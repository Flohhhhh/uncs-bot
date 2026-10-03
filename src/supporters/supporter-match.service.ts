import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import { founderPolicy, patreonCampaign } from "./founder-policy";
import { SupporterMatchStore, type AutoMatchResult } from "./supporter-match.store";

/** The startup classification of older links runs this long after startup, before the first sync's sweep. */
export const SUPPORTER_MATCH_STARTUP_DELAY_MS = 5_000;
/** One sweep checks at most this many records; the next sweep continues after the last one checked. */
export const SUPPORTER_MATCH_SWEEP_LIMIT = 2_000;
const MATCH_FAILED =
  "Automatic supporter matching could not finish. Records already saved were kept; the next sync or approval retries.";
const SOURCES_FAILED =
  "Older supporter links could not be classified at startup. They stay unclassified (and are never matched automatically) until the next restart.";

export type SupporterMatchTrigger = "startup" | "sync" | "webhook" | "approval" | "link";
export type SupporterMatchStatus = {
  /** Copy empty SteamIDs from approved whitelist applications (SUPPORTER_AUTO_STEAM_FILL_ENABLED). */
  steamFill: boolean;
  /** Record founder promises automatically (SUPPORTER_AUTO_FOUNDER_ENABLED). */
  founderAuto: boolean;
  /** Hours an imported first payment must stand before an automatic founder promise. */
  holdHours: number;
  /** Patreon is configured, so there are Patreon records to match. */
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastTrigger: SupporterMatchTrigger | null;
  /** Fixed, safe text only. */
  lastError: string | null;
  /** Counts from the last sweep. */
  checked: number;
  steamFilled: number;
  foundersRecorded: number;
  /** Why records the last sweep checked were not changed, by reason. */
  blocked: Record<string, number>;
  /** The last sweep reached its limit; the next one continues after it. */
  capped: boolean;
};
type Counts = Pick<SupporterMatchStatus, "checked" | "steamFilled" | "foundersRecorded" | "blocked" | "capped">;
const emptyCounts = (): Counts => ({ checked: 0, steamFilled: 0, foundersRecorded: 0, blocked: {}, capped: false });
const uniqueViolation = (error: unknown) => {
  let cause: unknown = error;
  for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && cause.code === "23505") return true;
    cause = "cause" in cause ? cause.cause : null;
  }
  return false;
};

/**
 * Runs automatic supporter matching for Patreon records: after each Patreon sync, after a webhook observation, after
 * a whitelist application is approved, and after staff link a Discord account (SteamID only). Both switches are off by
 * default, and nothing runs while Patreon is not configured. Never throws to its callers and never posts to Discord;
 * a recorded founder only queues the usual Founder role check.
 */
@Injectable()
export class SupporterMatchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SupporterMatchService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private ready: Promise<void> = Promise.resolve();
  private release?: () => void;
  private current: Promise<void> | null = null;
  private rerun: SupporterMatchTrigger | null = null;
  private cursor: string | null = null;
  private lastRunAt: number | null = null;
  private lastTrigger: SupporterMatchTrigger | null = null;
  private lastError: string | null = null;
  private counts = emptyCounts();

  constructor(
    private readonly store: SupporterMatchStore,
    private readonly env: EnvService,
    private readonly roles: DiscordRolesService,
  ) {}

  private steps() {
    return {
      fillSteam: this.env.get("SUPPORTER_AUTO_STEAM_FILL_ENABLED") === true,
      recordFounder: this.env.get("SUPPORTER_AUTO_FOUNDER_ENABLED") === true,
    };
  }
  enabled() {
    const steps = this.steps();
    return steps.fillSteam || steps.recordFounder;
  }

  status(): SupporterMatchStatus {
    const steps = this.steps();
    return {
      steamFill: steps.fillSteam,
      founderAuto: steps.recordFounder,
      holdHours: founderPolicy(this.env).automaticHoldHours!,
      configured: patreonCampaign(this.env) !== null,
      running: this.current !== null,
      lastRunAt: this.lastRunAt === null ? null : new Date(this.lastRunAt).toISOString(),
      lastTrigger: this.lastTrigger,
      lastError: this.lastError,
      ...this.counts,
      blocked: { ...this.counts.blocked },
    };
  }

  /**
   * Labels older links once the application has started, every time, whether or not matching is on: the labels only
   * say where existing links came from. Matching waits for it, so an unlabelled link is never matched.
   */
  onApplicationBootstrap() {
    this.ready = new Promise((resolve) => {
      this.release = resolve;
    });
    this.timer = setTimeout(() => void this.startup(), SUPPORTER_MATCH_STARTUP_DELAY_MS);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.release?.();
  }
  private async startup() {
    try {
      await this.store.backfillSources();
    } catch {
      // Database errors carry SQL parameters (Discord IDs and SteamIDs): log fixed text only.
      this.logger.warn(SOURCES_FAILED);
    } finally {
      this.release?.();
    }
    await this.sweep("startup");
  }

  /**
   * Checks every record automation could still change. Single-flight: a sweep asked for while one runs is run once
   * more after it, so a sync's newly imported members are never missed. Never rejects.
   */
  sweep(trigger: SupporterMatchTrigger): Promise<void> {
    if (this.current) {
      this.rerun = trigger;
      return this.current;
    }
    this.current = (async () => {
      let next: SupporterMatchTrigger | null = trigger;
      try {
        while (next && !this.stopped) {
          this.rerun = null;
          await this.pass(next);
          next = this.rerun;
        }
      } finally {
        this.current = null;
      }
    })();
    return this.current;
  }

  private async pass(trigger: SupporterMatchTrigger) {
    const campaignId = patreonCampaign(this.env);
    if (!campaignId || !this.enabled()) return;
    await this.ready;
    if (this.stopped) return;
    const counts = emptyCounts();
    this.lastRunAt = Date.now();
    this.lastTrigger = trigger;
    let ids: string[];
    try {
      ids = await this.store.candidates(
        campaignId,
        founderPolicy(this.env),
        this.steps(),
        this.cursor,
        SUPPORTER_MATCH_SWEEP_LIMIT + 1,
      );
    } catch {
      this.fail();
      return;
    }
    counts.capped = ids.length > SUPPORTER_MATCH_SWEEP_LIMIT;
    ids = ids.slice(0, SUPPORTER_MATCH_SWEEP_LIMIT);
    this.cursor = counts.capped ? ids.at(-1)! : null;
    let failed = false;
    for (const id of ids) {
      if (this.stopped) break;
      const result = await this.member(id, trigger);
      if (!result) {
        failed = true;
        continue;
      }
      counts.checked++;
      if (result.steamFilled) counts.steamFilled++;
      if (result.founderRecorded) counts.foundersRecorded++;
      for (const reason of result.blocked) counts.blocked[reason] = (counts.blocked[reason] ?? 0) + 1;
    }
    this.counts = counts;
    if (!failed) this.lastError = null;
    if (counts.steamFilled || counts.foundersRecorded)
      this.logger.log(
        `Automatic supporter match (${trigger}): ${counts.checked} checked, ${counts.steamFilled} SteamIDs copied from approved applications, ${counts.foundersRecorded} founder promises recorded.`,
      );
  }

  private fail() {
    this.lastError = MATCH_FAILED;
    this.logger.warn(MATCH_FAILED);
  }

  /**
   * Matches one record. `founder: false` limits it to the SteamID fill (a staff link must not lead straight to a
   * permanent promise). Returns null when nothing ran or the attempt failed; never throws.
   */
  async member(
    memberId: string,
    trigger: SupporterMatchTrigger,
    options: { founder?: boolean } = {},
  ): Promise<AutoMatchResult | null> {
    try {
      const campaignId = patreonCampaign(this.env);
      const steps = this.steps();
      const recordFounder = steps.recordFounder && options.founder !== false;
      if (!campaignId || this.stopped || (!steps.fillSteam && !recordFounder)) return null;
      await this.ready;
      if (this.stopped) return null;
      try {
        const result = await this.store.autoMatch(memberId, {
          campaignId,
          policy: founderPolicy(this.env),
          fillSteam: steps.fillSteam,
          recordFounder,
          now: new Date(),
        });
        if (result.founderRecorded) this.notifyRoles(result.discordId);
        if (trigger !== "startup" && trigger !== "sync" && (result.steamFilled || result.founderRecorded))
          this.logger.log(
            `Automatic supporter match (${trigger}): ${result.steamFilled ? "copied a SteamID from an approved application" : "kept the SteamID"}${result.founderRecorded ? " and recorded a founder promise" : ""}.`,
          );
        return result;
      } catch (error) {
        // A staff link of the same SteamID on another record won the race; the whole attempt rolled back.
        if (uniqueViolation(error))
          return {
            memberId,
            discordId: null,
            skipped: false,
            steamFilled: false,
            founderRecorded: false,
            blocked: ["steam_on_another_record"],
          };
        throw error;
      }
    } catch {
      this.fail();
      return null;
    }
  }

  /** An application was approved: match the campaign's Patreon record for that Discord account. Never rejects. */
  async applicationChanged(discordUserId: unknown) {
    try {
      if (typeof discordUserId !== "string" || !/^\d{17,20}$/.test(discordUserId)) return;
      const campaignId = patreonCampaign(this.env);
      if (!campaignId || !this.enabled() || this.stopped) return;
      for (const id of await this.store.patreonMembersForDiscord(campaignId, discordUserId))
        await this.member(id, "approval");
    } catch {
      this.fail();
    }
  }

  /** Fire-and-forget: a role problem never fails a match. */
  private notifyRoles(discordId: string | null) {
    try {
      this.roles.supporterChanged(discordId);
    } catch {
      /* The role service logs its own problems. */
    }
  }
}
