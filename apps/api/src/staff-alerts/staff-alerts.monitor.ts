import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ZodError } from "zod";
import { AdminStore, type ModerationCount } from "../admin/admin.store";
import { GameServers } from "../admin/game-servers";
import { RconError, type RconErrorKind } from "../admin/rcon-protocol";
import type { Overview, WardogsClient } from "../admin/wardogs.client";
import type { GameServerSummary } from "../common/game-server";
import { mapLabel } from "../common/map-labels";
import type { FeedContextView, RoundPeakView, StaffAlertsStatus, StaffAlertsWorkerView } from "../common/staff-alerts";
import { EnvService } from "../env/env.service";
import { LEAVE_GRACE_MS, MAX_ROSTER, ROUND_HOLD_MS } from "../server-community/community-state";
import { FEED_CONTEXT, type FeedContextSource } from "./feed-context";
import { initialHealthState, observeHealth, type HealthAlert } from "./health-state";
import { formatLocal, localParts } from "./local-time";
import { NETWORK_BAN_SOURCES, withTimeout, type NetworkBanEntry, type NetworkBanSource } from "./network-bans";
import {
  initialPerformanceState,
  observePerformance,
  type PerformanceCandidate,
  type RoundPeak,
} from "./performance-state";
import { initialRoundState, observeRound } from "./round-state";
import { initialSeedingState, observeSeeding, seedingView, type SeedingAlert } from "./seeding-state";
import { settingsView, staffAlertsOptions, type StaffAlertsOptions } from "./staff-alerts.config";
import { cleanText, playerLabel, StaffAlerts, type StaffAlertInput } from "./staff-alerts.service";

export const ACTIVE_DELAY_MS = 10_000;
export const IDLE_DELAY_MS = 15_000;
export const FAILED_DELAY_MS = 30_000;
const WHITELIST_CACHE_MS = 10 * 60_000;
/** Bounds the watch-list roster memory: current players plus recent leavers. */
const WATCH_SEEN_MAX = 2 * MAX_ROSTER;
/** A player not listed by any good read for this long counts as gone, even across failed reads. */
const WATCH_STALE_MS = 30 * 60_000;
/** Performance alerts whose extra notes are kept for a later amend. */
const NOTES_MAX = 100;
const ONLINE_AT_START = "online when Gramps started, recorded only";
const SOURCE_TIMEOUT_MS = 3_000;
const FEED_TIMEOUT_MS = 2_000;
const NO_ACTION = "Gramps took no action.";
const DAY_MS = 24 * 60 * 60_000;
/** Shown with the network-ban sources in the worker status. */
const KICK_HISTORY = "Kick history";
/** Alert posts that may wait on Discord at once per server; past this, alerts are recorded only. */
const POSTS_MAX = 10;

/** Why a read failed. A schema mismatch counts as unreadable; anything unclassified as an error. */
export function failureKind(error: unknown): RconErrorKind {
  if (error instanceof RconError) return error.kind ?? "error";
  if (error instanceof ZodError) return "unreadable";
  return "error";
}

const one = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
/** Review wording only: counters are prompts for a person, never proof and never an action. */
export function performanceText(candidate: PerformanceCandidate, timeZone: string, notes: string[] = []) {
  const name = playerLabel(candidate.name);
  const map = mapLabel(candidate.map);
  const lines: string[] = [];
  const windowLine =
    candidate.windowKills !== null && candidate.windowMinutes !== null && candidate.rate !== null
      ? `${name} had ${candidate.windowKills} kills in ${one(candidate.windowMinutes)} min (${one(candidate.rate)}/min).`
      : null;
  const kd = one(candidate.kd ?? 0);
  if (candidate.rules.includes("window") && windowLine)
    lines.push(
      windowLine,
      candidate.roundDeaths === null
        ? `Round on ${map}: ${candidate.roundKills} kills (deaths not reported).`
        : `Round on ${map}: ${candidate.roundKills} kills, ${candidate.roundDeaths} deaths (K/D ${kd}).`,
    );
  else
    lines.push(
      candidate.roundDeaths === null
        ? `${name} has ${candidate.roundKills} kills this round on ${map} (deaths not reported).`
        : `${name} has ${candidate.roundKills} kills and ${candidate.roundDeaths} deaths this round on ${map} (K/D ${kd}).`,
    );
  lines.push(`Counted from ${formatLocal(candidate.countedSince, timeZone)}, when Gramps first saw them this round.`);
  lines.push(...notes);
  lines.push(`From game counters only. Not proof of cheating. ${NO_ACTION}`);
  return {
    title: candidate.rules.includes("window") ? "Review: unusual kill rate" : "Review: unusual round K/D",
    lines,
    facts: {
      rules: candidate.rules.join(","),
      roundKills: candidate.roundKills,
      ...(candidate.roundDeaths !== null ? { roundDeaths: candidate.roundDeaths } : {}),
      ...(candidate.kd !== null ? { kd: candidate.kd } : {}),
      ...(candidate.windowKills !== null ? { windowKills: candidate.windowKills } : {}),
      ...(candidate.windowMinutes !== null ? { windowMinutes: candidate.windowMinutes } : {}),
      ...(candidate.rate !== null ? { killsPerMinute: candidate.rate } : {}),
      map: cleanText(candidate.map, 64),
      round: candidate.roundKey,
      countedSince: new Date(candidate.countedSince).toISOString(),
    } as Record<string, string | number>,
  };
}

/** Monitoring only. Never suggests that Gramps bans; a ban works only while the player is online. */
export function watchlistText(entry: NetworkBanEntry, name: string, presentAtStart: boolean, knownGood: boolean) {
  const communities =
    entry.communities === null
      ? "Community count not recorded"
      : `Banned in ${entry.communities} ${entry.communities === 1 ? "community" : "communities"}${entry.recordedAt ? ` (as recorded ${entry.recordedAt})` : ""}`;
  const lines = [
    `${playerLabel(name)} ${presentAtStart ? "was online when Gramps started" : "joined"}.`,
    `${communities}. Reason: ${entry.reasons.map((reason) => cleanText(reason, 200)).join("; ") || "not recorded"}.`,
  ];
  if (entry.addedBy) lines.push(`Added to the watch list by ${cleanText(entry.addedBy, 64)}.`);
  if (knownGood) lines.push("This player is also on the performance known-good list.");
  lines.push(`Monitoring only. ${NO_ACTION} A ban works only while the player is online.`);
  return {
    title: presentAtStart ? "Watch list: player online" : "Watch list: player joined",
    lines,
  };
}

/** "3 (last 2026-10-02)": all of a player's recorded kicks and the local date of the newest. */
export function priorKicksText(kicks: ModerationCount, timeZone: string) {
  return `${kicks.count} (last ${localParts(kicks.lastAt.getTime(), timeZone).date})`;
}

/** Monitoring only: the record is dashboard kicks on this server, never a reason Gramps acts. */
export function repeatOffenderText(
  kicks: ModerationCount,
  name: string,
  days: number,
  presentAtStart: boolean,
  timeZone: string,
) {
  const times = (count: number) => (count === 1 ? "once" : `${count} times`);
  const reason = kicks.lastReason ? `: ${cleanText(kicks.lastReason, 200)}` : "";
  return {
    title: presentAtStart ? "Repeat offender online" : "Repeat offender joined",
    lines: [
      `${playerLabel(name)} ${presentAtStart ? "was online when Gramps started" : "joined"}.`,
      `Kicked ${times(kicks.recent)} in the last ${days} days${kicks.count > kicks.recent ? ` (${kicks.count} in all)` : ""}.`,
      `Last kick ${localParts(kicks.lastAt.getTime(), timeZone).date} by ${cleanText(kicks.lastBy, 64)}${reason}.`,
      `From dashboard kicks on this server. Monitoring only. ${NO_ACTION}`,
    ],
  };
}

/** Kick and ban counts for joining players, read in one query per pass. */
export type KickHistory = Pick<AdminStore, "moderationSummaries">;
type FeedReader = FeedContextSource | null | undefined;

/** One server: shared overview reads, pure reducers, then StaffAlerts.raise. Never changes the game. */
export class StaffAlertsWorker {
  private readonly logger = new Logger(StaffAlertsWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private health = initialHealthState();
  private seeding = initialSeedingState();
  private performance = initialPerformanceState();
  /** SteamIDs already offered to the network-ban sources, with when a good read last listed each. */
  private readonly watchSeen = new Map<string, number>();
  private bootChecked = false;
  /** The first good read: when its roster is empty, the start window stays open until ROUND_HOLD_MS after it. */
  private bootAt: number | null = null;
  private lastObservedAt: string | null = null;
  private lastReadAt: string | null = null;
  private reachable: boolean | null = null;
  private players: number | null = null;
  private unlinked = 0;
  private round = initialRoundState();
  private whitelist: { until: number; ids: ReadonlySet<string> } | null = null;
  /** Notes on a raised performance alert (by key), so an amend keeps them. */
  private readonly performanceNotes = new Map<string, string[]>();
  private readonly sourceErrors = new Map<string, { error: string; at: string } | null>();
  private posting = 0;

  constructor(
    private readonly server: GameServerSummary,
    private readonly game: WardogsClient,
    private readonly alerts: StaffAlerts,
    private readonly env: EnvService,
    private readonly sources: NetworkBanSource[] = [],
    private readonly feed: FeedReader = null,
    private readonly history: KickHistory | null = null,
  ) {}

  start() {
    this.schedule(0);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number) {
    if (process.env.API_WORKERS_ENABLED !== "true") return;
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().then(
        (next) => this.schedule(next),
        () => {
          this.logger.warn(`Staff alerts for ${this.server.id} failed one pass; the next read starts again.`);
          this.schedule(FAILED_DELAY_MS);
        },
      );
    }, delay);
    this.timer.unref?.();
  }

  /** One bounded read and alert pass; returns the delay before the next. Public for isolated tests. */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return FAILED_DELAY_MS;
    this.running = true;
    try {
      const options = staffAlertsOptions(this.env);
      if (!options.active) return IDLE_DELAY_MS;
      let overview: Overview;
      try {
        overview = await this.game.overview();
      } catch (error) {
        if (this.stopped) return FAILED_DELAY_MS;
        this.failed(failureKind(error), options);
        return FAILED_DELAY_MS;
      }
      if (this.stopped) return FAILED_DELAY_MS;
      const active = options.performance.mode !== "off" ? ACTIVE_DELAY_MS : IDLE_DELAY_MS;
      if (overview.observedAt === this.lastObservedAt)
        return overview.status.players.current > 0 ? active : IDLE_DELAY_MS;
      await this.observed(overview, options);
      return overview.status.players.current > 0 ? active : IDLE_DELAY_MS;
    } finally {
      this.running = false;
    }
  }

  private failed(kind: RconErrorKind, options: StaffAlertsOptions) {
    const now = Date.now();
    if (kind !== "paused") this.reachable = false;
    const health = observeHealth(this.health, { ok: false, kind }, now, options.health);
    this.health = health.state;
    if (options.health.enabled) for (const alert of health.alerts) this.raiseHealth(alert);
    if (options.seeding.enabled)
      this.seeding = observeSeeding(
        this.seeding,
        { reachable: false, players: null, restart: this.health.watch },
        now,
        options.seeding,
      ).state;
  }

  private async observed(overview: Overview, options: StaffAlertsOptions) {
    const parsed = Date.parse(overview.observedAt);
    const now = Number.isFinite(parsed) ? parsed : Date.now();
    this.lastObservedAt = overview.observedAt;
    this.lastReadAt = new Date(now).toISOString();
    this.reachable = true;
    this.players = overview.status.players.current;
    this.unlinked = overview.unlinkedPlayerCount ?? 0;
    const rounds = observeRound(this.round, overview.status, now);
    this.round = rounds.state;
    const roundChanged = rounds.changed;
    const round = this.round.round;

    const health = observeHealth(
      this.health,
      {
        ok: true,
        map: overview.status.map,
        players: overview.status.players.current,
        matchSeconds: overview.status.matchSeconds ?? null,
        build: overview.capabilities.build ?? null,
        roundChanged,
      },
      now,
      options.health,
    );
    this.health = health.state;
    if (options.health.enabled) for (const alert of health.alerts) this.raiseHealth(alert);

    if (options.seeding.enabled) {
      const seeding = observeSeeding(
        this.seeding,
        { reachable: true, players: overview.status.players.current, restart: this.health.watch },
        now,
        options.seeding,
      );
      this.seeding = seeding.state;
      for (const alert of seeding.alerts) this.raiseHealth(alert);
    }

    if (options.performance.mode !== "off" && round) {
      const knownGood = new Set([...options.performance.knownGood.keys(), ...this.alerts.sessionNever()]);
      const performance = observePerformance(
        this.performance,
        {
          roundId: round.id,
          phase: this.round.phase,
          map: overview.status.map,
          restartLike: health.restartLike,
          players: overview.players,
        },
        now,
        options.performance,
        knownGood,
      );
      this.performance = performance.state;
      for (const candidate of performance.candidates) await this.raisePerformance(candidate, options, now);
    }

    if (options.watchlist.enabled) await this.checkWatchlist(overview, options, now);
  }

  /**
   * Records an alert and posts it without holding up the reads. raise() records the alert and
   * applies its repeat window and hourly limit before it first waits, so only the post runs on. A
   * post can take about a minute while discord.js retries, and the next read would then come after
   * the round gap and could look like a restart. While POSTS_MAX posts are still waiting, a further
   * alert is recorded but not posted.
   */
  private raise(input: StaffAlertInput) {
    const backlog = input.deliver && !input.suppressed && this.posting >= POSTS_MAX;
    this.posting++;
    void this.alerts
      .raise(backlog ? { ...input, suppressed: "earlier posts still waiting on Discord" } : input)
      .catch(() => null)
      .finally(() => this.posting--);
  }

  private raiseHealth(alert: HealthAlert | SeedingAlert) {
    this.raise({
      serverId: this.server.id,
      serverName: this.server.name,
      kind: alert.kind,
      severity: alert.severity,
      key: alert.key,
      title: alert.title,
      lines: alert.lines,
      facts: alert.facts,
      deliver: true,
      ...("suppressed" in alert && alert.suppressed ? { suppressed: alert.suppressed } : {}),
    });
  }

  /**
   * The live whitelist (the running reserved slots, never the configuration document), read only
   * when an alert is about to fire and cached for 10 minutes.
   */
  private async whitelisted(steamId: string): Promise<boolean | null> {
    const now = Date.now();
    if (!this.whitelist || this.whitelist.until <= now) {
      try {
        const { ids } = await this.game.reservedSlots();
        this.whitelist = { until: now + WHITELIST_CACHE_MS, ids };
      } catch {
        this.whitelist = null;
        return null;
      }
    }
    return this.whitelist.ids.has(steamId);
  }

  private async raisePerformance(candidate: PerformanceCandidate, options: StaffAlertsOptions, now: number) {
    const key = `perf:${candidate.steamId}:${candidate.roundKey}`;
    if (candidate.amend) {
      // A second rule for the same player and round: the record takes the newer title and kind and
      // keeps the notes it was raised with.
      const text = performanceText(candidate, options.timeZone, this.performanceNotes.get(key) ?? []);
      this.alerts.amend(this.server.id, key, {
        kind: candidate.kind,
        title: text.title,
        lines: text.lines,
        facts: text.facts,
      });
      return;
    }
    const notes: string[] = [];
    if (options.performance.skipWhitelisted) {
      const whitelisted = await this.whitelisted(candidate.steamId);
      if (whitelisted) return;
      if (whitelisted === null) notes.push("Whitelist unavailable, so whitelisted players were not skipped.");
    }
    let feed: FeedContextView | null = null;
    if (this.feed && !candidate.suppressed) {
      const reader = this.feed;
      const windowSince = now - options.performance.windowMinutes * 60_000;
      try {
        feed = await withTimeout(
          () =>
            reader.context(this.server.id, candidate.steamId, {
              since: Math.min(candidate.countedSince, windowSince),
              windowSince,
              until: now,
            }),
          FEED_TIMEOUT_MS,
        );
      } catch {
        feed = null;
      }
    }
    if (notes.length) {
      this.performanceNotes.set(key, notes);
      for (const old of this.performanceNotes.keys()) {
        if (this.performanceNotes.size <= NOTES_MAX) break;
        this.performanceNotes.delete(old);
      }
    }
    const text = performanceText(candidate, options.timeZone, notes);
    const fields: [string, string][] = [];
    if (candidate.kd !== null) fields.push(["Round K/D", one(candidate.kd)]);
    if (candidate.rate !== null) fields.push(["Kills/min", one(candidate.rate)]);
    this.raise({
      serverId: this.server.id,
      serverName: this.server.name,
      kind: candidate.kind,
      severity: "warning",
      key,
      title: text.title,
      lines: text.lines,
      player: { steamId: candidate.steamId, name: candidate.name },
      facts: text.facts,
      fields,
      deliver: options.performance.mode === "on",
      feed,
      ...(candidate.suppressed ? { suppressed: candidate.suppressed } : {}),
    });
  }

  /**
   * Players to look up: everyone listed now who was not online in recent reads. A populated roster
   * shows who left after the 60-second leave grace, and an empty one only once it stays empty past
   * a map load. A failed read or a read gap shows nothing, so players still online are not looked
   * up again and players who joined meanwhile are, until WATCH_STALE_MS without a good read listing
   * them. This is separate from the community welcome rules, which skip joins around baselines and
   * round transitions on purpose.
   */
  private watchJoins(overview: Overview, now: number) {
    const ids = [...new Set(overview.players.map((player) => player.steamId))].slice(0, MAX_ROSTER);
    const fresh = ids.filter((id) => {
      const seenAt = this.watchSeen.get(id);
      return seenAt === undefined || now - seenAt > WATCH_STALE_MS;
    });
    for (const id of ids) {
      this.watchSeen.delete(id);
      this.watchSeen.set(id, now);
    }
    const grace = ids.length ? LEAVE_GRACE_MS : ROUND_HOLD_MS;
    for (const [id, seenAt] of this.watchSeen) if (now - seenAt > grace) this.watchSeen.delete(id);
    for (const id of this.watchSeen.keys()) {
      if (this.watchSeen.size <= WATCH_SEEN_MAX) break;
      this.watchSeen.delete(id);
    }
    return fresh;
  }

  private async checkWatchlist(overview: Overview, options: StaffAlertsOptions, now: number) {
    const ids = this.watchJoins(overview, now);
    // Players online at the first read may have been reported before a redeploy: record them for
    // the staff API without posting or pinging. Joins seen after that alert as usual. A start during
    // a map load reads an empty roster first, and the roster then refills over several reads, so
    // after an empty first read the window stays open until a map load's time has passed.
    const first = this.bootAt === null;
    this.bootAt ??= now;
    const presentAtStart = !this.bootChecked && now - this.bootAt < ROUND_HOLD_MS;
    if (!presentAtStart || (first && overview.players.length)) this.bootChecked = true;
    if (!ids.length) return;
    const knownGood = options.performance.knownGood;
    const [kicks, lookups] = await Promise.all([this.priorKicks(ids, options, now), this.networkBans(ids, now)]);
    // A watch-list alert already carries the player's kicks, so the same join raises no second alert.
    const watched = new Set<string>();
    for (const { source, found } of lookups) {
      for (const steamId of ids) {
        const entry = found.get(steamId);
        if (!entry || entry.revoked) continue;
        watched.add(steamId);
        const prior = kicks.get(steamId);
        const name = overview.players.find((player) => player.steamId === steamId)?.name ?? "Unknown";
        const isKnownGood = knownGood.has(steamId) || this.alerts.sessionNever().has(steamId);
        const text = watchlistText(entry, name, presentAtStart, isKnownGood);
        const highlighted = entry.communities !== null && entry.communities >= options.watchlist.highlightCommunities;
        const fields: [string, string][] = [];
        if (entry.communities !== null) fields.push(["Communities", String(entry.communities)]);
        if (prior) fields.push(["Prior kicks", priorKicksText(prior, options.timeZone)]);
        this.raise({
          serverId: this.server.id,
          serverName: this.server.name,
          kind: "watchlist-join",
          severity: highlighted ? "high" : "warning",
          key: `${presentAtStart ? "watch-start" : "watch"}:${steamId}`,
          repeatMs: options.watchlist.cooldownMinutes * 60_000,
          title: text.title,
          lines: text.lines,
          player: { steamId, name },
          facts: {
            source: source.name,
            ...(entry.communities !== null ? { communities: entry.communities } : {}),
            ...(entry.recordedAt ? { recordedAt: entry.recordedAt } : {}),
            ...(prior ? { priorKicks: prior.count, lastKickAt: prior.lastAt.toISOString() } : {}),
          },
          fields,
          links: entry.evidenceUrls,
          deliver: !presentAtStart,
          ...(presentAtStart ? { suppressed: ONLINE_AT_START } : {}),
          network: {
            source: entry.source,
            sourceName: source.name,
            communities: entry.communities,
            reasons: entry.reasons.map((reason) => cleanText(reason, 200)),
            evidenceUrls: [...entry.evidenceUrls],
            recordedAt: entry.recordedAt,
            addedBy: entry.addedBy ? cleanText(entry.addedBy, 64) : null,
            knownGood: isKnownGood,
            presentAtStart,
          },
        });
      }
    }
    const { repeatKicks, repeatDays } = options.watchlist;
    if (repeatKicks > 0)
      for (const steamId of ids) {
        const prior = kicks.get(steamId);
        if (!prior || prior.recent < repeatKicks || watched.has(steamId)) continue;
        const name = overview.players.find((player) => player.steamId === steamId)?.name ?? "Unknown";
        const text = repeatOffenderText(prior, name, repeatDays, presentAtStart, options.timeZone);
        this.raise({
          serverId: this.server.id,
          serverName: this.server.name,
          kind: "repeat-offender-join",
          severity: "warning",
          key: `${presentAtStart ? "repeat-start" : "repeat"}:${steamId}`,
          repeatMs: options.watchlist.cooldownMinutes * 60_000,
          title: text.title,
          lines: text.lines,
          player: { steamId, name },
          facts: {
            kicks: prior.recent,
            days: repeatDays,
            priorKicks: prior.count,
            lastKickAt: prior.lastAt.toISOString(),
          },
          fields: [
            ["Kicks", `${prior.recent} in ${repeatDays} days`],
            ["Prior kicks", priorKicksText(prior, options.timeZone)],
          ],
          deliver: !presentAtStart,
          ...(presentAtStart ? { suppressed: ONLINE_AT_START } : {}),
        });
      }
  }

  /** Each network-ban source's matches, asked in turn. A failed source is reported and skipped; the next join tries again. */
  private async networkBans(ids: string[], now: number) {
    const lookups: { source: NetworkBanSource; found: Map<string, NetworkBanEntry> }[] = [];
    for (const source of this.sources) {
      try {
        const found = await withTimeout((signal) => source.lookup(ids, signal), SOURCE_TIMEOUT_MS);
        this.sourceErrors.set(source.name, null);
        lookups.push({ source, found });
      } catch {
        // Never log SteamIDs or source details.
        this.logger.warn(`Network ban source "${source.name}" failed for ${this.server.id}.`);
        this.sourceErrors.set(source.name, {
          error: "The lookup failed or took longer than 3 seconds.",
          at: new Date(now).toISOString(),
        });
      }
    }
    return lookups;
  }

  /**
   * Recorded kicks for the joining players, from one query with a 3-second limit. A failed read is
   * shown in the status and leaves the alerts without kick counts; the next join reads again.
   */
  private async priorKicks(ids: string[], options: StaffAlertsOptions, now: number) {
    const found = new Map<string, ModerationCount>();
    const history = this.history;
    if (!history) return found;
    const since = new Date(now - options.watchlist.repeatDays * DAY_MS);
    try {
      const summaries = await withTimeout(
        () => history.moderationSummaries(this.server.id, ids, since),
        SOURCE_TIMEOUT_MS,
      );
      this.sourceErrors.set(KICK_HISTORY, null);
      for (const [steamId, summary] of summaries) if (summary.kicks) found.set(steamId, summary.kicks);
    } catch {
      // Never log SteamIDs or database details.
      this.logger.warn(`Kick history could not be read for ${this.server.id}.`);
      this.sourceErrors.set(KICK_HISTORY, {
        error: "The lookup failed or took longer than 3 seconds.",
        at: new Date(now).toISOString(),
      });
    }
    return found;
  }

  view(): StaffAlertsWorkerView {
    const outage = this.health.outage;
    return {
      state: this.stopped ? "off" : "running",
      lastReadAt: this.lastReadAt,
      reachable: this.reachable,
      failingSince: outage ? new Date(outage.since).toISOString() : null,
      failureKind: outage?.kind ?? null,
      players: this.players,
      round: this.round.round
        ? {
            id: this.round.round.id,
            map: cleanText(mapLabel(this.round.round.map), 64),
            phase: this.round.phase,
          }
        : null,
      build: this.health.build,
      lastRestartAt: this.health.lastRestartAt === null ? null : new Date(this.health.lastRestartAt).toISOString(),
      seeding: seedingView(this.seeding),
      counters: this.performance.counters,
      trackedPlayers: this.performance.players.size,
      unlinkedPlayers: this.unlinked,
      sources: [...this.sources.map((source) => source.name), ...(this.history ? [KICK_HISTORY] : [])].map((name) => ({
        name,
        error: this.sourceErrors.get(name)?.error ?? null,
        at: this.sourceErrors.get(name)?.at ?? null,
      })),
    };
  }

  peaks(): RoundPeakView[] {
    return [...this.performance.peaks].reverse().map((peak: RoundPeak) => ({
      roundKey: peak.roundKey,
      map: cleanText(mapLabel(peak.map), 64),
      startedAt: new Date(peak.startedAt).toISOString(),
      window: peak.window ? { ...peak.window, name: playerLabel(peak.window.name) } : null,
      kd: peak.kd ? { ...peak.kd, name: playerLabel(peak.kd.name) } : null,
    }));
  }
}

const idleWorker = (state: StaffAlertsWorkerView["state"]): StaffAlertsWorkerView => ({
  state,
  lastReadAt: null,
  reachable: null,
  failingSince: null,
  failureKind: null,
  players: null,
  round: null,
  build: null,
  lastRestartAt: null,
  seeding: { lowSince: null, alerted: [] },
  counters: "unknown",
  trackedPlayers: 0,
  unlinkedPlayers: 0,
  sources: [],
});

/**
 * Alert-only staff monitoring: one worker per configured server, started only when
 * STAFF_ALERTS_ENABLED and at least one feature are on. It reads the shared, cached overview
 * (and the live reserved slots only when a performance alert is about to fire, and joining players'
 * kick counts from admin_actions while the watch list is on). It never sends a game action, writes no
 * admin_actions rows and has no WarDogs Server Commands connection. State is in memory; run one replica.
 */
@Injectable()
export class StaffAlertsMonitor implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy {
  private readonly logger = new Logger(StaffAlertsMonitor.name);
  private readonly workers = new Map<string, StaffAlertsWorker>();
  private readonly unconfigured = new Set<string>();
  constructor(
    private readonly servers: GameServers,
    private readonly alerts: StaffAlerts,
    private readonly env: EnvService,
    @Inject(NETWORK_BAN_SOURCES) private readonly sources: NetworkBanSource[],
    @Optional() @Inject(FEED_CONTEXT) private readonly feed?: FeedContextSource | null,
    @Optional() @Inject(AdminStore) private readonly history?: AdminStore | null,
  ) {}

  onApplicationBootstrap() {
    if (process.env.API_WORKERS_ENABLED !== "true") return;
    if (!staffAlertsOptions(this.env).active) return;
    for (const server of this.servers.list()) {
      try {
        const worker = new StaffAlertsWorker(
          server,
          this.servers.get(server.id),
          this.alerts,
          this.env,
          this.sources,
          this.feed,
          this.history ?? null,
        );
        this.workers.set(server.id, worker);
        worker.start();
      } catch {
        this.unconfigured.add(server.id);
        this.logger.warn(`Staff alerts for ${server.id} need connection setup. Other servers remain available.`);
      }
    }
  }
  onModuleDestroy() {
    this.onApplicationShutdown();
  }
  onApplicationShutdown() {
    for (const worker of this.workers.values()) worker.stop();
    this.workers.clear();
  }

  /** Staff-only status for one server: settings as counts, worker observations, snoozes, alerts and peaks. */
  async status(id?: string): Promise<StaffAlertsStatus> {
    const serverId = this.servers.resolve(id);
    const options = staffAlertsOptions(this.env);
    const worker = this.workers.get(serverId);
    return {
      serverId,
      enabled: options.enabled,
      features: {
        health: options.health.enabled,
        seeding: options.seeding.enabled,
        performance: options.performance.mode,
        watchlist: options.watchlist.enabled,
      },
      channel: await this.alerts.channelStatus(),
      settings: settingsView(options, this.alerts.sessionNever().size),
      worker: worker ? worker.view() : idleWorker(this.unconfigured.has(serverId) ? "not-configured" : "off"),
      snoozes: this.alerts.activeSnoozes(serverId),
      alerts: this.alerts.list(serverId),
      peaks: worker ? worker.peaks() : [],
    };
  }
}
