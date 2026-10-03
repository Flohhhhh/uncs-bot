import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Staff } from "../admin/admin.types";
import { GameServers } from "../admin/game-servers";
import type { GameServerSummary } from "../common/game-server";
import { EnvService } from "../env/env.service";
import { TelemetryService } from "../telemetry/telemetry.service";
import { TelemetryStore } from "../telemetry/telemetry.store";
import type { CombatAggregate, TrackingRecord, WeeklyHighlights } from "../telemetry/telemetry.types";
import {
  WeeklyDiscordError,
  WeeklyLeaderboardDiscord,
  weeklyNonce,
  type WeeklyChannel,
} from "./weekly-leaderboard.discord";
import { MIN_RANKED_PLAYERS, renderWeeklyBoard, type WeeklyBoardMessage } from "./weekly-render";
import {
  CATCH_UP_HOURS,
  CATCH_UP_MS,
  TIME_ZONE,
  followingSlot,
  isoWeekKey,
  latestSlot,
  nextSlot,
  weekEndingAt,
  type WeekWindow,
  type WeeklySchedule,
} from "./weekly-schedule";

export const CHECK_INTERVAL_MS = 5 * 60_000;
export const STARTUP_DELAY_MS = 60_000;
export const ADMIN_ONLY_MESSAGE = "Only administrators can preview or post the weekly board.";

export type WeeklyTrigger = "schedule" | "staff";
export type WeeklyOutcome = "posted" | "skipped" | "failed" | "unknown";
export type WeeklyTotals = { kills: number; players: number; rankedPlayers: number };
/** In-memory, per server. Holds only times, counts and fixed reason categories: no SteamIDs or names. */
export type WeeklyRun = {
  weekKey: string;
  windowStartedAt: string;
  windowEndedAt: string;
  checkedAt: string;
  trigger: WeeklyTrigger;
  outcome: WeeklyOutcome;
  reason: string;
  totals?: WeeklyTotals;
  messageId?: string | null;
};

type Evaluation = {
  window: WeekWindow;
  /** Slot used for the heading's "week ending" date. */
  slot: number;
  /** First failed eligibility check, or null when the week can be posted. */
  reason: string | null;
  /** A skip that a later check this week cannot change. Storage failures are retried. */
  settled: boolean;
  totals?: WeeklyTotals;
  message?: WeeklyBoardMessage;
};

const weekSchema = z.enum(["last", "current"]).default("last");
const postSchema = z
  .object({
    weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
  })
  .strict();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const discordFailures: Record<string, string> = {
  "Discord not ready": "Discord is not ready. Try again shortly.",
  "channel unusable":
    "The weekly board channel is not usable. Choose a text or announcement channel in this community that the bot can view, post in and read.",
  "posted check unavailable":
    "Gramps could not confirm whether this week is already in the channel, so nothing was posted.",
};

/**
 * One friendly post per configured server per week. Silent unless the week clears every threshold;
 * the in-process claim, a channel scan for the week's marker and a deterministic nonce keep it to one.
 */
@Injectable()
export class WeeklyLeaderboardService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WeeklyLeaderboardService.name);
  /**
   * `${serverId}:${weekKey}` claims and settled skips. Claimed before any send; released only when Discord
   * definitely refused the post, which moves the week to `refused`.
   */
  private readonly decided = new Set<string>();
  /** Weeks Discord refused: nothing was posted. The schedule never retries them; an administrator may post. */
  private readonly refused = new Set<string>();
  private readonly lastRuns = new Map<string, WeeklyRun>();
  private readonly logged = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;

  constructor(
    private readonly store: TelemetryStore,
    private readonly telemetry: TelemetryService,
    private readonly servers: GameServers,
    private readonly env: EnvService,
    private readonly discord: WeeklyLeaderboardDiscord,
  ) {}

  private options() {
    return {
      enabled: this.env.get("WEEKLY_LEADERBOARD_ENABLED") === true,
      channelId: this.env.get("WEEKLY_LEADERBOARD_CHANNEL_ID"),
      guildId: this.env.get("ADMIN_GUILD_ID"),
      schedule: {
        day: this.env.get("WEEKLY_LEADERBOARD_DAY"),
        time: this.env.get("WEEKLY_LEADERBOARD_TIME"),
      } satisfies WeeklySchedule,
      minKills: this.env.get("WEEKLY_LEADERBOARD_MIN_KILLS"),
      minPlayers: this.env.get("WEEKLY_LEADERBOARD_MIN_PLAYERS"),
    };
  }

  onApplicationBootstrap() {
    if (this.options().enabled) this.schedule(STARTUP_DELAY_MS);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(CHECK_INTERVAL_MS));
    }, delay);
    this.timer.unref();
  }

  /** One pass over every configured server. Public only so tests can run it without a timer. */
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const servers = this.servers.list();
      for (const server of servers) {
        if (this.stopped) break;
        try {
          await this.scheduled(server, servers.length > 1, Date.now());
        } catch {
          this.logger.warn(`Weekly board check for server ${server.id} failed; it will be checked again.`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async scheduled(server: GameServerSummary, showServerName: boolean, now: number) {
    const options = this.options();
    const slot = latestSlot(now, options.schedule);
    const window = weekEndingAt(slot, options.schedule);
    const key = `${server.id}:${window.weekKey}`;
    if (this.decided.has(key) || this.refused.has(key)) return;
    if (!options.enabled) {
      this.decided.add(key);
      this.record(server.id, window, "schedule", "skipped", "disabled");
      return;
    }
    if (now - slot > CATCH_UP_MS) {
      // Turning the board on midweek or a restart after the window never posts by surprise. Not a
      // claim: an administrator can still post this week.
      if (this.lastRuns.get(server.id)?.weekKey !== window.weekKey)
        this.record(server.id, window, "schedule", "skipped", "missed posting window");
      return;
    }
    const evaluation = await this.evaluate(server, showServerName, window, slot, false);
    if (evaluation.reason !== null) {
      if (evaluation.settled) this.decided.add(key);
      this.record(server.id, window, "schedule", "skipped", evaluation.reason, evaluation.totals);
      return;
    }
    await this.deliver(server, evaluation, "schedule");
  }

  /**
   * §4 eligibility in order; the first failed check is the reason. A scheduled check stops at the first
   * failure. A preview (or post-now) reads everything so the board renders even when the week is not
   * eligible, and leaves the on/off switch to its caller.
   */
  private async evaluate(
    server: GameServerSummary,
    showServerName: boolean,
    window: WeekWindow,
    slot: number,
    preview: boolean,
  ): Promise<Evaluation> {
    const options = this.options();
    const reasons: string[] = [];
    const stop = (reason: string, settled = true): Evaluation => ({ window, slot, reason, settled });
    if (!preview && !options.enabled) return stop("disabled");
    if (!options.channelId || !options.guildId) reasons.push("channel not configured");
    if (!this.telemetry.feedAvailable(server.id)) reasons.push("feed not configured");
    if (reasons.length && !preview) return stop(reasons[0]);
    let tracking: TrackingRecord;
    let aggregate: CombatAggregate;
    let highlights: WeeklyHighlights;
    try {
      tracking = await this.store.tracking(server.id);
      if (!tracking || tracking.lastReceivedAt.getTime() < window.start.getTime()) {
        reasons.push("no combat events received this week");
        if (!preview) return stop(reasons[0]);
      }
      [aggregate, highlights] = await Promise.all([
        this.store.snapshot(window.since, window.until, undefined, server.id),
        this.store.weeklyHighlights(window.since, window.until, server.id),
      ]);
    } catch {
      return stop("storage unavailable", false);
    }
    const totals: WeeklyTotals = {
      kills: aggregate.totals.kills,
      players: aggregate.totals.players,
      rankedPlayers: aggregate.leaderboard.filter((row) => row.kills > 0).length,
    };
    if (totals.kills < options.minKills) reasons.push(`below minimum kills (${totals.kills}/${options.minKills})`);
    if (totals.players < options.minPlayers)
      reasons.push(`below minimum players (${totals.players}/${options.minPlayers})`);
    if (totals.rankedPlayers < MIN_RANKED_PLAYERS) reasons.push(`fewer than ${MIN_RANKED_PLAYERS} players with kills`);
    const message = renderWeeklyBoard({
      serverId: server.id,
      serverName: server.name,
      showServerName,
      slot,
      window,
      trackingStartedAt: tracking?.firstReceivedAt ?? null,
      rows: aggregate.leaderboard,
      highlights,
    });
    return { window, slot, reason: reasons[0] ?? null, settled: true, totals, message };
  }

  /**
   * Channel check, then the posted check, then a synchronous claim and one send. Returns null when another
   * caller claimed the week while this one was checking Discord.
   */
  private async deliver(server: GameServerSummary, evaluation: Evaluation, trigger: WeeklyTrigger, staff?: Staff) {
    const { window, totals, message } = evaluation;
    const key = `${server.id}:${window.weekKey}`;
    const options = this.options();
    let channel: WeeklyChannel;
    try {
      channel = await this.discord.channel(options.guildId!, options.channelId!);
      if (await this.discord.posted(channel, window.end.getTime(), window.weekKey, server.id)) {
        this.decided.add(key);
        return this.record(server.id, window, trigger, "skipped", "already posted", totals, undefined, staff);
      }
    } catch (error) {
      const failure = error instanceof WeeklyDiscordError ? error : new WeeklyDiscordError("channel unusable");
      if (failure.settled) this.decided.add(key);
      return this.record(server.id, window, trigger, "skipped", failure.reason, totals, undefined, staff);
    }
    if (this.decided.has(key) || (trigger === "schedule" && this.refused.has(key)) || this.stopped || !message)
      return null;
    // Claimed synchronously before the send, so overlapping checks in this process send at most once.
    this.refused.delete(key);
    this.decided.add(key);
    const result = await this.discord.send(channel, message, weeklyNonce(server.id, window.weekKey));
    if (result.outcome === "failed") {
      // A definite refusal posted nothing, so an administrator can post once the cause is fixed.
      this.decided.delete(key);
      this.refused.add(key);
    }
    if (result.outcome === "posted")
      return this.record(server.id, window, trigger, "posted", "posted", totals, result.messageId, staff);
    return this.record(
      server.id,
      window,
      trigger,
      result.outcome,
      result.outcome === "failed" ? "send refused" : "send result unknown",
      totals,
      null,
      staff,
    );
  }

  private record(
    serverId: string,
    window: WeekWindow,
    trigger: WeeklyTrigger,
    outcome: WeeklyOutcome,
    reason: string,
    totals?: WeeklyTotals,
    messageId?: string | null,
    staff?: Staff,
  ) {
    const run: WeeklyRun = {
      weekKey: window.weekKey,
      windowStartedAt: window.start.toISOString(),
      windowEndedAt: window.end.toISOString(),
      checkedAt: new Date().toISOString(),
      trigger,
      outcome,
      reason,
      ...(totals ? { totals: { ...totals } } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    };
    this.lastRuns.set(serverId, run);
    // Once per server, week and reason; never names, SteamIDs or content.
    const logKey = `${serverId}:${window.weekKey}:${trigger}:${reason}`;
    if (!this.logged.has(logKey)) {
      if (this.logged.size >= 1_000) this.logged.clear();
      this.logged.add(logKey);
      const text =
        `Weekly board ${window.weekKey} for server ${serverId}: ${outcome} (${reason})` +
        `${staff ? ` by staff ${staff.id}` : ""}.`;
      if (outcome === "failed" || outcome === "unknown") this.logger.warn(text);
      else this.logger.log(text);
    }
    return run;
  }

  private server(staff: Staff) {
    const serverId = this.servers.resolve(staff.serverId);
    const list = this.servers.list();
    return { server: list.find((entry) => entry.id === serverId)!, showServerName: list.length > 1 };
  }

  private requireAdmin(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException(ADMIN_ONLY_MESSAGE);
  }

  /** Any staff role: configuration, schedule, thresholds and the last result. */
  status(staff: Staff) {
    const { server } = this.server(staff);
    const options = this.options();
    const lastRun = this.lastRuns.get(server.id);
    return {
      enabled: options.enabled,
      configured: !!options.channelId && !!options.guildId,
      feedConfigured: this.telemetry.feedAvailable(server.id),
      schedule: {
        day: options.schedule.day,
        time: options.schedule.time,
        timeZone: TIME_ZONE,
        nextPostAt: new Date(nextSlot(Date.now(), options.schedule)).toISOString(),
        catchUpHours: CATCH_UP_HOURS,
      },
      thresholds: { minKills: options.minKills, minPlayers: options.minPlayers, minRankedPlayers: MIN_RANKED_PLAYERS },
      lastRun: lastRun ? { ...lastRun, ...(lastRun.totals ? { totals: { ...lastRun.totals } } : {}) } : null,
    };
  }

  /** Administrators only. Renders the last completed week (postable) or the week so far; never sends. */
  async preview(staff: Staff, input: unknown) {
    this.requireAdmin(staff);
    const week = weekSchema.safeParse(input === "" ? undefined : input);
    if (!week.success) throw new BadRequestException("Choose last or current.");
    const { server, showServerName } = this.server(staff);
    const options = this.options();
    const now = Date.now();
    let window: WeekWindow, slot: number;
    if (week.data === "last") {
      slot = latestSlot(now, options.schedule);
      window = weekEndingAt(slot, options.schedule);
    } else {
      const start = latestSlot(now, options.schedule);
      slot = followingSlot(start, options.schedule);
      window = {
        weekKey: isoWeekKey(slot),
        start: new Date(start),
        end: new Date(now),
        since: new Date(start),
        until: new Date(now),
      };
    }
    const evaluation = await this.evaluate(server, showServerName, window, slot, true);
    if (!evaluation.message) throw new ServiceUnavailableException("Combat history is unavailable. Try again shortly.");
    let alreadyPosted: boolean | null = null;
    if (week.data === "current") alreadyPosted = false;
    else if (options.guildId && options.channelId)
      try {
        const channel = await this.discord.channel(options.guildId, options.channelId);
        alreadyPosted = await this.discord.posted(channel, slot, window.weekKey, server.id);
      } catch {
        alreadyPosted = null;
      }
    const content = evaluation.message.content;
    return {
      weekKey: window.weekKey,
      windowStartedAt: window.start.toISOString(),
      windowEndedAt: window.end.toISOString(),
      postable:
        week.data === "last" &&
        options.enabled &&
        evaluation.reason === null &&
        !this.decided.has(`${server.id}:${window.weekKey}`) &&
        alreadyPosted !== true,
      eligible: evaluation.reason === null,
      reason: evaluation.reason,
      totals: evaluation.totals ?? null,
      content,
      previewHash: sha256(content),
      alreadyPosted,
    };
  }

  /** Administrators only: post the last completed week now, exactly as previewed. */
  async post(staff: Staff, input: unknown) {
    this.requireAdmin(staff);
    const body = postSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("Preview the weekly board, then confirm posting that preview.");
    const { server, showServerName } = this.server(staff);
    const options = this.options();
    if (!options.enabled)
      throw new ConflictException("Turn on the weekly board (WEEKLY_LEADERBOARD_ENABLED) before posting.");
    const slot = latestSlot(Date.now(), options.schedule);
    const window = weekEndingAt(slot, options.schedule);
    if (body.data.weekKey !== window.weekKey)
      throw new ConflictException(`Only the last completed week (${window.weekKey}) can be posted.`);
    const key = `${server.id}:${window.weekKey}`;
    const handled = "This week's board was already handled. Check the weekly board status.";
    if (this.decided.has(key)) throw new ConflictException(handled);
    const evaluation = await this.evaluate(server, showServerName, window, slot, true);
    if (evaluation.reason === "storage unavailable" || !evaluation.message)
      throw new ServiceUnavailableException("Combat history is unavailable. Try again shortly.");
    if (evaluation.reason !== null) throw new ConflictException(`This week can't be posted: ${evaluation.reason}.`);
    if (sha256(evaluation.message.content) !== body.data.previewHash)
      throw new ConflictException("The board changed since your preview. Preview again.");
    const run = await this.deliver(server, evaluation, "staff", staff);
    if (!run) throw new ConflictException(handled);
    if (run.reason === "already posted") throw new ConflictException("This week's board is already in the channel.");
    if (run.outcome === "skipped")
      throw new ServiceUnavailableException(discordFailures[run.reason] ?? discordFailures["channel unusable"]);
    if (run.outcome === "failed")
      throw new ServiceUnavailableException(
        "Discord refused the weekly board post. Check the channel and the bot's permissions.",
      );
    return { outcome: run.outcome, messageId: run.messageId ?? null, weekKey: window.weekKey };
  }
}
