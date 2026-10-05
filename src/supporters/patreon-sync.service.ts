import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import { PatreonApiError, PatreonClient, type PatreonTierPrices } from "./patreon.client";
import { SupporterMatchService } from "./supporter-match.service";
import { SupportersStore, type FounderReview } from "./supporters.store";

export const PATREON_SYNC_STARTUP_DELAY_MS = 15_000;
export const PATREON_SYNC_STAFF_COOLDOWN_MS = 30_000;
/** A rejected token needs a Railway update (and restart), so scheduled retries slow down meanwhile. */
const TOKEN_REJECTED_INTERVAL_MS = 6 * 3_600_000;
const MAX_DETAILS = 50;
const SAVE_FAILED =
  "Supporter records could not be saved. Records already imported were kept; the next sync will retry.";
const TOKEN_REUSED =
  "PATREON_CREATOR_ACCESS_TOKEN matches another configured secret. Use the Creator's Access Token from the Patreon client page.";
const TOKEN_MALFORMED =
  "PATREON_CREATOR_ACCESS_TOKEN does not look like a Patreon access token. Copy the Creator's Access Token again.";

/**
 * Deployment secrets that must never double as a Patreon credential. Shared by the webhook secret and the
 * creator token checks, so both refuse the same reuse.
 */
export function deploymentSecrets(env: EnvService) {
  return [
    env.get("DISCORD_BOT_TOKEN"),
    env.get("DATABASE_URL"),
    env.get("ADMIN_DISCORD_CLIENT_SECRET"),
    env.get("ADMIN_SESSION_SECRET"),
    env.get("WARDOGS_RCON_PASSWORD"),
    env.get("WARDOGS_FEED_TOKEN"),
    ...(env.get("WARDOGS_SERVERS") ?? []).flatMap((server) => [server.password, server.feedToken]),
  ];
}

export type PatreonSyncConflict = {
  supporterId: string;
  patreonMemberId: string;
  reason: "discord-in-use" | "discord-differs";
};
export type PatreonFounderReview = FounderReview;
export type PatreonSyncStatus = {
  configured: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Fixed, safe text only. Never contains the token or Patreon response data. */
  lastError: string | null;
  tokenRejected: boolean;
  /** Counts from the last successful sync. */
  members: number;
  newMembers: number;
  updated: number;
  payments: number;
  discordLinks: number;
  conflicts: number;
  /** Members whose returned pledge history may be incomplete, so no first payment was derived. */
  truncated: number;
  revokedPayments: number;
  /** Members with at least one completed payment in the history Patreon returned. */
  paidMembers: number;
  /** Members Patreon reported a Discord account for, linked or not. */
  discordReported: number;
  /** Completed payments in another currency that count as US$5 or more by their tier's price. */
  tierConfirmed: number;
  /** How many of those this sync counted for the first time. */
  tierConfirmedNew: number;
  /** Completed payments in another currency that are still not confirmed as US$5 or more. */
  tierUnconfirmed: number;
  /** Whether this sync read tier prices (see PatreonTierPrices). */
  tierPrices: PatreonTierPrices;
  memberListComplete: boolean;
  intervalMinutes: number;
  nextAttemptAt: string | null;
  conflictDetails: PatreonSyncConflict[];
  founderReviews: PatreonFounderReview[];
};
type Counts = Pick<
  PatreonSyncStatus,
  | "members"
  | "newMembers"
  | "updated"
  | "payments"
  | "discordLinks"
  | "conflicts"
  | "truncated"
  | "revokedPayments"
  | "paidMembers"
  | "discordReported"
  | "tierConfirmed"
  | "tierConfirmedNew"
  | "tierUnconfirmed"
  | "tierPrices"
  | "memberListComplete"
  | "conflictDetails"
  | "founderReviews"
>;
const emptyCounts = (): Counts => ({
  members: 0,
  newMembers: 0,
  updated: 0,
  payments: 0,
  discordLinks: 0,
  conflicts: 0,
  truncated: 0,
  revokedPayments: 0,
  paidMembers: 0,
  discordReported: 0,
  tierConfirmed: 0,
  tierConfirmedNew: 0,
  tierUnconfirmed: 0,
  tierPrices: "not_needed",
  memberListComplete: true,
  conflictDetails: [],
  founderReviews: [],
});

/** Single-instance, single-flight Patreon member import. All state is in memory. */
@Injectable()
export class PatreonSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PatreonSyncService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private current: Promise<PatreonSyncStatus> | null = null;
  private blockedUntil = 0;
  private nextAttemptAt: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private tokenRejected = false;
  private counts = emptyCounts();

  constructor(
    private readonly client: PatreonClient,
    private readonly store: SupportersStore,
    private readonly env: EnvService,
    private readonly roles: DiscordRolesService,
    private readonly match: SupporterMatchService,
  ) {}

  /**
   * A Discord account the sync linked can make a founder eligible for the Founder role, and a changed status or
   * payment can start or end support for the Supporter role, so the role service checks that account like a staff
   * change. Fire-and-forget: a role problem never fails the import.
   */
  private notifyRoles(discordId: string | null) {
    try {
      this.roles.supporterChanged(discordId);
    } catch {
      /* The role service logs its own problems. */
    }
  }

  private otherSecrets() {
    return [this.env.get("PATREON_WEBHOOK_SECRET"), ...deploymentSecrets(this.env)];
  }
  /** Mirrors the webhook secret checks: a reused or malformed secret is never sent to Patreon. */
  private token(): { token: string | null; problem: string | null } {
    const token = this.env.get("PATREON_CREATOR_ACCESS_TOKEN");
    if (typeof token !== "string" || !token) return { token: null, problem: null };
    if (token.length < 16 || token.length > 2048 || !/^[\x21-\x7e]+$/.test(token))
      return { token: null, problem: TOKEN_MALFORMED };
    if (this.otherSecrets().some((secret) => typeof secret === "string" && secret === token))
      return { token: null, problem: TOKEN_REUSED };
    return { token, problem: null };
  }
  private campaignId() {
    return this.env.get("PATREON_ENABLED") ? (this.env.get("PATREON_CAMPAIGN_ID") ?? null) : null;
  }
  configured() {
    return Boolean(this.campaignId() && this.token().token);
  }
  private intervalMs() {
    const minutes = Number(this.env.get("PATREON_SYNC_INTERVAL_MINUTES"));
    return (Number.isInteger(minutes) && minutes >= 10 && minutes <= 1440 ? minutes : 30) * 60_000;
  }

  status(): PatreonSyncStatus {
    const configured = this.configured();
    const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
    return {
      configured,
      running: this.current !== null,
      lastAttemptAt: iso(this.lastAttemptAt),
      lastSuccessAt: iso(this.lastSuccessAt),
      lastError: this.lastError ?? (this.campaignId() ? this.token().problem : null),
      tokenRejected: this.tokenRejected,
      ...this.counts,
      conflictDetails: [...this.counts.conflictDetails],
      founderReviews: [...this.counts.founderReviews],
      intervalMinutes: this.intervalMs() / 60_000,
      nextAttemptAt: configured ? iso(this.nextAttemptAt) : null,
    };
  }

  onApplicationBootstrap() {
    if (this.configured()) this.schedule(PATREON_SYNC_STARTUP_DELAY_MS);
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.nextAttemptAt = null;
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAttemptAt = Date.now() + delay;
    this.timer = setTimeout(() => void this.sync(), delay);
    this.timer.unref();
  }
  private nextDelay() {
    const interval = this.tokenRejected ? Math.max(this.intervalMs(), TOKEN_REJECTED_INTERVAL_MS) : this.intervalMs();
    return Math.max(interval, this.blockedUntil - Date.now());
  }

  /** Runs one sync, or joins the one already running. Resolves with the status; never rejects. */
  sync(): Promise<PatreonSyncStatus> {
    if (!this.current)
      this.current = this.execute()
        .catch(() => {
          this.lastError = SAVE_FAILED;
        })
        .finally(() => {
          this.current = null;
          if (this.configured()) this.schedule(this.nextDelay());
        })
        .then(() => this.status());
    return this.current;
  }

  /** Staff trigger: joins a running sync, and briefly reuses a sync that just finished. */
  async staffSync() {
    if (this.current) return { joined: true, sync: await this.current };
    if (this.lastAttemptAt !== null && Date.now() - this.lastAttemptAt < PATREON_SYNC_STAFF_COOLDOWN_MS)
      return { joined: false, recent: true, sync: this.status() };
    return { joined: false, sync: await this.sync() };
  }

  private async execute() {
    const campaignId = this.campaignId();
    const { token } = this.token();
    if (!campaignId || !token || this.stopped || Date.now() < this.blockedUntil) return;
    this.lastAttemptAt = Date.now();
    try {
      const { members, complete, tierPrices, retryAfterMs } = await this.client.members(campaignId, token);
      // Patreon rate-limited the tier request only. The members were read, so the import goes on and the next one waits.
      if (retryAfterMs) this.blockedUntil = Date.now() + retryAfterMs;
      const counts = emptyCounts();
      counts.members = members.length;
      counts.memberListComplete = complete;
      counts.tierPrices = tierPrices;
      for (const member of members) {
        if (this.stopped) break;
        if (!member.historyComplete) counts.truncated++;
        if (member.discordId) counts.discordReported++;
        if (member.events.some((event) => event.paymentStatus === "Paid")) counts.paidMembers++;
        const result = await this.store.importApiMember(campaignId, member, new Date());
        if (result.created) counts.newMembers++;
        if (result.updated) counts.updated++;
        counts.payments += result.payments;
        counts.revokedPayments += result.revoked;
        counts.tierConfirmed += result.tierConfirmed;
        counts.tierConfirmedNew += result.tierConfirmedNew;
        counts.tierUnconfirmed += result.tierUnconfirmed;
        if (result.discordLinked) counts.discordLinks++;
        // An unchanged record queues nothing; the six-hour role safety pass covers time-based expiry.
        if (
          result.discordId &&
          (result.created || result.updated || result.payments || result.revoked || result.discordLinked)
        )
          this.notifyRoles(result.discordId);
        if (result.conflict) {
          counts.conflicts++;
          if (counts.conflictDetails.length < MAX_DETAILS)
            counts.conflictDetails.push({
              supporterId: result.memberId,
              patreonMemberId: result.patreonMemberId,
              reason: result.conflict,
            });
        }
      }
      // A shutdown mid-sync keeps what was imported but does not report a completed sync.
      if (this.stopped) return;
      // Automatic supporter matching (off by default) sees this sync's Discord links and payments. It never rejects
      // and keeps its own status, so it cannot fail the sync.
      await this.match.sweep("sync");
      counts.founderReviews = await this.store.founderReviews(campaignId);
      // Logged once when the tier result changes, so a deploy shows whether other-currency payments now count.
      const tierChanged =
        counts.tierUnconfirmed !== this.counts.tierUnconfirmed || counts.tierPrices !== this.counts.tierPrices;
      this.counts = counts;
      this.lastSuccessAt = Date.now();
      this.tokenRejected = false;
      this.lastError = complete
        ? null
        : `Patreon listed more members than one sync reads. The first ${members.length} were imported.`;
      if (
        counts.newMembers ||
        counts.updated ||
        counts.payments ||
        counts.revokedPayments ||
        counts.discordLinks ||
        counts.conflicts ||
        counts.tierConfirmedNew ||
        tierChanged
      )
        this.logger.log(
          `Patreon sync: ${counts.members} members, ${counts.newMembers} new, ${counts.updated} updated, ${counts.payments} payments, ${counts.revokedPayments} payments unverified, ${counts.discordLinks} Discord links, ${counts.conflicts} conflicts, ${counts.discordReported} Discord accounts reported, ${counts.tierConfirmed} other-currency payments counted by tier price (${counts.tierConfirmedNew} new), ${counts.tierUnconfirmed} not confirmed, tier prices ${counts.tierPrices}.`,
        );
    } catch (error) {
      // Only fixed messages are recorded: errors may carry request details that must stay private.
      this.lastError = error instanceof PatreonApiError ? error.message : SAVE_FAILED;
      if (error instanceof PatreonApiError && error.kind === "token") this.tokenRejected = true;
      if (error instanceof PatreonApiError && error.kind === "rate" && error.retryAfterMs)
        this.blockedUntil = Date.now() + error.retryAfterMs;
      this.logger.warn(`Patreon sync failed: ${this.lastError}`);
    }
  }
}
