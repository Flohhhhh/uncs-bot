import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { EnvService } from "../env/env.service";
import { GameServers } from "../admin/game-servers";
import { describeCause, UNKNOWN_WEAPON, type CauseKind } from "../common/cause-labels";
import { publicGameServer } from "../common/game-server";
import { mapLabel } from "../common/map-labels";
import { plainLabel } from "../server-community/community-state";
import { feedCredentials, feedServer, usableFeedToken } from "./telemetry.credentials";
import { TelemetryDeliveries } from "./telemetry.deliveries";
import { TelemetryStore } from "./telemetry.store";
import {
  emptyTotals,
  FeedRejectedException,
  LEADER_TAGS,
  parseFeed,
  periodMilliseconds,
  periodSchema,
  PUBLIC_MAX_DISTANCE_CENTIMETERS,
  telemetrySteamId,
  type CombatAggregate,
  type CombatStats,
  type LeaderTag,
  type ParsedFeed,
  type PublicCombatStats,
  type PublicServerStats,
  type RowExtras,
  type RowExtrasAggregate,
  type ServerStatsAggregate,
  type TelemetryPeriod,
  type TrackingRecord,
} from "./telemetry.types";

export const UNNAMED_PLAYER = "Unnamed player";
/** Server stats and leaderboard extras are recomputed at most once a minute per server and period. */
export const STATS_TTL_MS = 60_000;
const STATS_CACHE_ENTRIES = 30;
const STEAM_ID_LIKE = /\p{Nd}{17}/u;

// Storage falls back to the SteamID when no display name was observed, so a public name
// replaces any name that is empty, is a SteamID or contains this player's SteamID with a neutral label.
export function publicName(steamId: string | null | undefined, name: unknown): string {
  const label = typeof name === "string" ? name.trim() : "";
  const identifying = !label || /^\d{17}$/.test(label) || (!!steamId && label.includes(steamId));
  return identifying ? UNNAMED_PLAYER : (name as string);
}

/**
 * A name in any public response (leaderboard rows and stats lists): publicName(), then the website's
 * stricter rule that any 17-digit run, in any script's digits, is hidden. Gramps serves these on its own
 * origin, so this holds without the website's proxy. The weekly Discord post applies the same rule itself.
 */
export function publicListName(steamId: string | null | undefined, name: unknown): string {
  const visible = publicName(steamId, name);
  if (STEAM_ID_LIKE.test(visible)) return UNNAMED_PLAYER;
  return visible.trim().slice(0, 64) || UNNAMED_PLAYER;
}

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
/** Whole metres for a distance within the public 2 km cap, else null. */
export function publicMeters(centimeters: unknown): number | null {
  return typeof centimeters === "number" &&
    Number.isFinite(centimeters) &&
    centimeters > 0 &&
    centimeters <= PUBLIC_MAX_DISTANCE_CENTIMETERS
    ? Math.round(centimeters / 100)
    : null;
}
/** A readable map name, or null for an empty, unknown or SteamID-like one. */
function publicMap(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const label = plainLabel(mapLabel(name.trim()), 40);
  return label === "Unknown" || STEAM_ID_LIKE.test(label) ? null : label;
}
const byCountThenLabel = (a: { kills: number; label: string }, b: { kills: number; label: string }) =>
  b.kills - a.kills || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
const LEADER_KEYS = Object.keys(LEADER_TAGS) as LeaderTag[];

/** Public stats with nothing recorded: every count 0 and every list empty. */
export function emptyServerStats(): PublicServerStats {
  return {
    totals: { ...emptyTotals(), suicides: 0 },
    weapons: [],
    maps: [],
    longestKills: [],
    hours: Array.from({ length: 24 }, () => 0),
    tags: { melee: 0, roadkill: 0, vehicleExplosion: 0, penetration: 0, ricochet: 0, falling: 0, suicide: 0 },
    tagLeaders: { melee: [], roadkill: [], vehicleExplosion: [], penetration: [], ricochet: [], falling: [] },
  };
}

/**
 * The public stats shape, built field by field from the store's aggregate so nothing else can pass
 * through: names only, never a SteamID, and every weapon named by describeCause().
 */
export function publicServerStats(aggregate: ServerStatsAggregate): PublicServerStats {
  const stats = emptyServerStats();
  const groups = Array.isArray(aggregate?.groups) ? aggregate.groups : [];
  const all = groups.find((row) => row?.set === 7);
  const totals = aggregate?.totals;
  stats.totals = {
    events: count(totals?.events),
    kills: count(all?.kills),
    deaths: count(totals?.deaths),
    headshotKills: count(all?.headshotKills),
    players: count(totals?.players),
    suicides: count(totals?.suicides),
  };

  // Weapons: each cause row named, then rows with one name merged ("Id.Item.AK74M" and "ID.Item.AK74M").
  const weapons = new Map<
    string,
    { label: string; kind: CauseKind; kindKills: number; kills: number; headshotKills: number; longest: number }
  >();
  const causes = groups
    .filter((row) => row?.set === 3 && typeof row.cause === "string" && row.cause.trim())
    .slice(0, 500)
    .map((row) => ({ row, key: row.causeKey ?? row.cause!.trim().toLowerCase() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ row }) => row);
  for (const row of causes) {
    const { label, kind } = describeCause(row.cause);
    const kills = count(row.kills);
    if (!kills) continue;
    const entry = weapons.get(label) ?? { label, kind, kindKills: 0, kills: 0, headshotKills: 0, longest: 0 };
    if (kills > entry.kindKills) Object.assign(entry, { kind, kindKills: kills });
    entry.kills += kills;
    entry.headshotKills += count(row.headshotKills);
    // A firearm's longest kill is its longest plausible shot, as in the long-shot lists.
    const reach = kind === "firearm" ? row.longestShotCentimeters : row.longestCentimeters;
    const longest = publicMeters(reach) === null ? 0 : reach!;
    entry.longest = Math.max(entry.longest, longest);
    weapons.set(label, entry);
  }
  stats.weapons = [...weapons.values()]
    .sort(byCountThenLabel)
    .slice(0, 25)
    .map(({ label, kind, kills, headshotKills, longest }) => ({
      label,
      kind,
      kills,
      headshotKills,
      longestMeters: publicMeters(longest),
    }));

  // Maps: the catalog ID and the in-game name of one map count once.
  const maps = new Map<string, number>();
  for (const row of groups) {
    if (row?.set !== 5) continue;
    const label = publicMap(row.mapName);
    if (label && count(row.kills)) maps.set(label, (maps.get(label) ?? 0) + count(row.kills));
  }
  stats.maps = [...maps.entries()]
    .map(([label, kills]) => ({ label, kills }))
    .sort(byCountThenLabel)
    .slice(0, 10);

  for (const row of groups)
    if (row?.set === 6 && Number.isInteger(row.hour) && row.hour! >= 0 && row.hour! < 24)
      stats.hours[row.hour!] += count(row.kills);

  stats.tags = {
    melee: count(all?.melee),
    roadkill: count(all?.roadkill),
    vehicleExplosion: count(all?.vehicleExplosion),
    penetration: count(all?.penetration),
    ricochet: count(all?.ricochet),
    falling: count(totals?.falling),
    suicide: stats.totals.suicides,
  };

  // Longest kills: one row per player, farthest first.
  const seen = new Set<string>();
  const longest = (Array.isArray(aggregate?.longest) ? aggregate.longest : [])
    .map((row, order) => ({ row, order, meters: publicMeters(row?.distanceCentimeters) }))
    .filter(({ row, meters }) => meters !== null && typeof row.steamId === "string")
    .sort((a, b) => b.row.distanceCentimeters - a.row.distanceCentimeters || a.order - b.order);
  for (const { row, meters } of longest) {
    if (stats.longestKills.length >= 10 || seen.has(row.steamId)) continue;
    seen.add(row.steamId);
    stats.longestKills.push({
      name: publicListName(row.steamId, row.name),
      weapon: typeof row.cause === "string" && row.cause.trim() ? describeCause(row.cause).label : null,
      meters: meters!,
      map: publicMap(row.mapName),
    });
  }

  // Tag leaders: the top five names per tag. Self-inflicted deaths are never listed by name.
  const leaders = Array.isArray(aggregate?.leaders) ? aggregate.leaders : [];
  for (const tag of LEADER_KEYS)
    stats.tagLeaders[tag] = leaders
      .map((row, order) => ({ row, order, hits: count(row?.count) }))
      .filter(({ row, hits }) => row?.tag === tag && hits > 0 && typeof row.steamId === "string")
      .sort((a, b) => b.hits - a.hits || a.order - b.order)
      .slice(0, 5)
      .map(({ row, hits }) => ({ name: publicListName(row.steamId, row.name), count: hits }));
  return stats;
}

/** Each listed player's row extras from the store's per-cause rows and streaks. */
export function rowExtrasByPlayer(aggregate: RowExtrasAggregate): Map<string, RowExtras> {
  const players = new Map<string, { weapons: Map<string, number>; longest: number; streak: number }>();
  const player = (steamId: string) => {
    let entry = players.get(steamId);
    if (!entry) players.set(steamId, (entry = { weapons: new Map(), longest: 0, streak: 0 }));
    return entry;
  };
  for (const row of Array.isArray(aggregate?.weapons) ? aggregate.weapons : []) {
    if (typeof row?.steamId !== "string") continue;
    const entry = player(row.steamId);
    const { label } = describeCause(row.cause);
    if (label !== UNKNOWN_WEAPON && count(row.kills))
      entry.weapons.set(label, (entry.weapons.get(label) ?? 0) + count(row.kills));
    if (publicMeters(row.longestCentimeters) !== null) entry.longest = Math.max(entry.longest, row.longestCentimeters!);
  }
  for (const row of Array.isArray(aggregate?.streaks) ? aggregate.streaks : [])
    if (typeof row?.steamId === "string") player(row.steamId).streak = count(row.bestStreak);
  const result = new Map<string, RowExtras>();
  for (const [steamId, entry] of players) {
    const extras: RowExtras = {};
    const [top] = [...entry.weapons.entries()].map(([label, kills]) => ({ label, kills })).sort(byCountThenLabel);
    if (top) extras.topWeapon = top.label;
    const meters = publicMeters(entry.longest);
    if (meters !== null) extras.longestKillMeters = meters;
    if (entry.streak >= 1) extras.bestStreak = entry.streak;
    result.set(steamId, extras);
  }
  return result;
}

/** A public leaderboard row: game statistics and valid extras only, assigned one by one. */
export function publicStats(
  { steamId, name, kills, deaths, headshotKills, kd }: CombatStats,
  extras?: RowExtras,
): PublicCombatStats {
  // A name can embed another player's SteamID ("UNC|7656119...|"), which the own-ID check in publicName() misses.
  const row: PublicCombatStats = { name: publicListName(steamId, name), kills, deaths, headshotKills, kd };
  const weapon = extras?.topWeapon;
  if (typeof weapon === "string" && /^[A-Za-z0-9][A-Za-z0-9 '-]{0,39}$/.test(weapon) && weapon !== UNKNOWN_WEAPON)
    row.topWeapon = weapon;
  const meters = extras?.longestKillMeters;
  if (typeof meters === "number" && Number.isSafeInteger(meters) && meters >= 0 && meters <= 2_000)
    row.longestKillMeters = meters;
  const streak = extras?.bestStreak;
  if (typeof streak === "number" && Number.isSafeInteger(streak) && streak >= 1) row.bestStreak = streak;
  return row;
}

type Cached<T> = Map<string, { until: number; value: Promise<T> }>;
type StatsSnapshot = { aggregate: ServerStatsAggregate; tracking: TrackingRecord; since: Date; asOf: Date };

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);
  private readonly snapshots = new Map<
    string,
    { until: number; value: Promise<{ aggregate: CombatAggregate; tracking: TrackingRecord; since: Date; asOf: Date }> }
  >();
  // Time-based, not cleared by ingest(): each recompute scans the whole window, so traffic and feed
  // batches cannot raise their rate above one per server and period per minute.
  private readonly statsCache: Cached<StatsSnapshot> = new Map();
  private readonly extrasCache: Cached<Map<string, RowExtras>> = new Map();
  constructor(
    private readonly store: TelemetryStore,
    private readonly env: EnvService,
    private readonly servers: GameServers,
    private readonly deliveries: TelemetryDeliveries,
  ) {}
  serversList() {
    return this.servers.list().map(publicGameServer);
  }

  /** Why the feed cannot accept deliveries for this server, or null when it can. */
  private unavailable(serverId: string) {
    if (!this.env.get("WARDOGS_FEED_ENABLED")) return "feed disabled";
    return usableFeedToken(this.servers.feedToken(serverId)) ? null : "feed token not configured";
  }

  private configured(serverId: string) {
    return this.unavailable(serverId) === null;
  }

  /** Whether the game feed can accept deliveries for this server: enabled and a usable token. */
  feedAvailable(serverId: string) {
    return this.configured(serverId);
  }

  // Records a refused delivery for staff (category and status only) and returns the error to throw.
  // withToken: the request carried the server's feed token, so it is the game's own delivery.
  private refuse(serverId: string | undefined, reason: string, error: unknown, withToken: boolean) {
    this.deliveries.rejected(serverId, error instanceof HttpException ? error.getStatus() : 503, reason, withToken);
    return error;
  }

  async ingest(authorization: unknown, body: unknown, id?: string) {
    let serverId: string;
    try {
      serverId = feedServer(this.servers, id, authorization);
    } catch (error) {
      const reason = error instanceof BadRequestException ? "server not selected" : "unknown server";
      throw this.refuse(id, reason, error, false);
    }
    // Checked before availability so every refusal is filed by whether it carried the feed token.
    const credentials = feedCredentials(authorization, this.servers.feedToken(serverId));
    const withToken = credentials === "valid";
    const unavailable = this.unavailable(serverId);
    if (unavailable)
      throw this.refuse(
        serverId,
        unavailable,
        new ServiceUnavailableException("The game event feed is not connected yet."),
        withToken,
      );
    if (!withToken)
      throw this.refuse(serverId, credentials, new UnauthorizedException("Invalid game feed credentials."), false);
    let parsed: ParsedFeed;
    try {
      parsed = parseFeed(body);
    } catch (error) {
      throw this.refuse(
        serverId,
        error instanceof FeedRejectedException ? error.reason : "invalid payload",
        error,
        true,
      );
    }
    // Malformed entries and nothing valid to store, not even an event type count: refuse the batch,
    // so the game, staff and logs see a 400 and the feed does not read as receiving while every event
    // is dropped. A badly named type alone does not refuse a batch; it was skipped before names were checked.
    if (!parsed.types.length && parsed.firstMalformed) {
      const reason = `invalid payload: ${parsed.firstMalformed}`;
      throw this.refuse(serverId, reason, new FeedRejectedException("Invalid killed event fields.", reason), true);
    }
    let result: Awaited<ReturnType<TelemetryStore["ingest"]>>;
    try {
      result = await this.store.ingest(parsed, new Date(), serverId);
    } catch (error) {
      throw this.refuse(serverId, "storage unavailable", error, true);
    }
    const { typesOverLimit = 0, ...receipt } = result;
    this.deliveries.accepted(serverId, {
      accepted: parsed.events.length,
      skipped: parsed.skipped,
      invalid: parsed.invalid,
      firstInvalid: parsed.firstInvalid,
      types: parsed.types.length,
      typesOverLimit,
    });
    for (const key of this.snapshots.keys()) if (key.startsWith(`${serverId}:`)) this.snapshots.delete(key);
    // The game's receipt is unchanged: event type counts are for staff.
    return { ok: true, ...receipt };
  }

  private period(input: unknown): TelemetryPeriod {
    const value = periodSchema.safeParse(input === undefined ? "week" : input);
    if (!value.success) throw new BadRequestException("Choose day, week or month.");
    return value.data;
  }

  private async snapshot(serverId: string, period: TelemetryPeriod, playerId?: string) {
    const key = `${serverId}:${period}:${playerId ?? "all"}`;
    const now = Date.now();
    const existing = this.snapshots.get(key);
    if (existing && existing.until > now) return existing.value;
    const asOf = new Date(now),
      since = new Date(now - periodMilliseconds[period]);
    if (this.snapshots.size >= 100) this.snapshots.delete(this.snapshots.keys().next().value!);
    const value = Promise.all([
      this.store.snapshot(since, asOf, playerId, serverId),
      this.store.tracking(serverId),
    ]).then(([aggregate, tracking]) => ({ aggregate, tracking, since, asOf }));
    const entry = { until: now + 10_000, value };
    this.snapshots.set(key, entry);
    try {
      return await value;
    } catch (error) {
      if (this.snapshots.get(key) === entry) this.snapshots.delete(key);
      throw error;
    }
  }

  /**
   * Single-flight time-based cache: callers within the TTL share one load, a failed load is evicted,
   * and the oldest entry makes room past STATS_CACHE_ENTRIES.
   */
  private async cached<T>(cache: Cached<T>, key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = cache.get(key);
    if (existing && existing.until > now) return existing.value;
    cache.delete(key);
    while (cache.size >= STATS_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    const entry = { until: now + STATS_TTL_MS, value: load() };
    cache.set(key, entry);
    try {
      return await entry.value;
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }
  }

  private statsSnapshot(serverId: string, period: TelemetryPeriod) {
    return this.cached(this.statsCache, `${serverId}:${period}`, async (): Promise<StatsSnapshot> => {
      const asOf = new Date(Date.now()),
        since = new Date(asOf.getTime() - periodMilliseconds[period]);
      const [aggregate, tracking] = await Promise.all([
        this.store.serverStats(since, asOf, serverId),
        this.store.tracking(serverId),
      ]);
      return { aggregate, tracking, since, asOf };
    });
  }

  /** `now` sets when feedStatus is judged: stats pass the time their cached numbers were read. */
  private metadata(
    serverId: string,
    period: TelemetryPeriod,
    tracking: TrackingRecord,
    since: Date,
    asOf: Date,
    now = Date.now(),
  ) {
    const enabled = this.configured(serverId);
    const last = tracking?.lastReceivedAt ?? null;
    return {
      serverId,
      enabled,
      connected: enabled && last !== null,
      feedStatus:
        last === null
          ? ("waiting" as const)
          : now - last.getTime() <= 60_000
            ? ("receiving" as const)
            : ("quiet" as const),
      lastReceivedAt: last?.toISOString() ?? null,
      trackingStartedAt: tracking?.firstReceivedAt.toISOString() ?? null,
      period,
      windowStartedAt: since.toISOString(),
      asOf: asOf.toISOString(),
      coverageNote: !enabled
        ? "Game event tracking is not enabled."
        : "Based on events received during this time window. Earlier matches, delayed events and delivery gaps may affect totals. A quiet feed can simply mean no deaths occurred.",
    };
  }

  private summary(aggregate: CombatAggregate): CombatAggregate {
    // Output contains only game statistics, even if storage gains fields. SteamIDs stay here for
    // staff; the public leaderboard() strips them.
    return {
      leaderboard: aggregate.leaderboard.slice(0, 100).map(({ steamId, name, kills, deaths, headshotKills, kd }) => ({
        steamId,
        name,
        kills,
        deaths,
        headshotKills,
        kd,
      })),
      totals: {
        events: aggregate.totals.events,
        kills: aggregate.totals.kills,
        deaths: aggregate.totals.deaths,
        headshotKills: aggregate.totals.headshotKills,
        players: aggregate.totals.players,
      },
    };
  }

  /**
   * Public leaderboard: display names, game statistics and optional row extras, never SteamIDs. The
   * extras never fail the leaderboard: without them the rows are served as before.
   */
  async leaderboard(input?: unknown, id?: string) {
    const result = await this.ranking(input, id);
    const extras = result.enabled
      ? await this.rowExtras(result.serverId, result.period, result.leaderboard)
      : new Map<string, RowExtras>();
    return { ...result, leaderboard: result.leaderboard.map((row) => publicStats(row, extras.get(row.steamId))) };
  }

  /**
   * Row extras for the players listed when the cache was filled, over the window ending then. Players who
   * reach the top 100 later get theirs at the next refresh.
   */
  private async rowExtras(serverId: string, period: TelemetryPeriod, rows: CombatStats[]) {
    try {
      return await this.cached(this.extrasCache, `${serverId}:${period}`, async () => {
        const until = new Date(Date.now()),
          since = new Date(until.getTime() - periodMilliseconds[period]);
        const steamIds = rows.map((row) => row.steamId);
        return rowExtrasByPlayer(await this.store.rowExtras(since, until, steamIds, serverId));
      });
    } catch {
      this.logger.warn("Leaderboard extras unavailable; serving rows without them.");
      return new Map<string, RowExtras>();
    }
  }

  /**
   * Public server stats: totals, weapons, maps, long shots, hours and tag counts, with the leaderboard's
   * metadata. Names only, never SteamIDs. Recomputed at most once a minute per server and period.
   */
  async stats(input?: unknown, id?: string) {
    const serverId = this.servers.resolve(id);
    const period = this.period(input);
    if (!this.configured(serverId)) {
      const now = new Date();
      return {
        ...this.metadata(serverId, period, null, new Date(now.getTime() - periodMilliseconds[period]), now),
        ...emptyServerStats(),
      };
    }
    const { aggregate, tracking, since, asOf } = await this.statsSnapshot(serverId, period);
    return {
      ...this.metadata(serverId, period, tracking, since, asOf, asOf.getTime()),
      ...publicServerStats(aggregate),
    };
  }

  /** Staff ranking with SteamIDs. Shares the snapshot cache with the public leaderboard. */
  private async ranking(input?: unknown, id?: string) {
    const serverId = this.servers.resolve(id);
    const period = this.period(input);
    if (!this.configured(serverId)) {
      const now = new Date();
      return {
        ...this.metadata(serverId, period, null, new Date(now.getTime() - periodMilliseconds[period]), now),
        leaderboard: [],
        totals: emptyTotals(),
      };
    }
    const snapshot = await this.snapshot(serverId, period);
    return {
      ...this.metadata(serverId, period, snapshot.tracking, snapshot.since, snapshot.asOf),
      ...this.summary(snapshot.aggregate),
    };
  }

  async combat(input?: unknown, id?: string) {
    const result = await this.ranking(input, id);
    const since = new Date(result.windowStartedAt),
      until = new Date(result.asOf);
    const [events, otherEvents] = result.enabled
      ? await Promise.all([
          this.store.events(since, until, undefined, result.serverId),
          // A diagnostic: if its counts cannot be read, the rest of the staff view still loads.
          this.store.eventTypes(since, until, result.serverId).catch(() => {
            this.logger.warn(`Could not read game event type counts for server ${result.serverId}.`);
            return null;
          }),
        ])
      : [[], []];
    // Delivery diagnostics and feed event types, with their raw samples, are staff-only; the public
    // leaderboard never includes them.
    return { ...result, ...this.deliveries.status(result.serverId), events, otherEvents };
  }

  async player(id: unknown, input?: unknown, selected?: string) {
    const serverId = this.servers.resolve(selected);
    const playerId = telemetrySteamId.safeParse(id);
    if (!playerId.success) throw new BadRequestException("Enter a valid SteamID64.");
    const period = this.period(input);
    if (!this.configured(serverId)) {
      const { leaderboard: _leaderboard, ...base } = await this.ranking(period, serverId);
      return { ...base, steamId: playerId.data, player: null, events: [] };
    }
    const snapshot = await this.snapshot(serverId, period, playerId.data);
    return {
      ...this.metadata(serverId, period, snapshot.tracking, snapshot.since, snapshot.asOf),
      steamId: playerId.data,
      player: snapshot.aggregate.leaderboard.find((entry) => entry.steamId === playerId.data) ?? null,
      totals: snapshot.aggregate.totals,
      events: await this.store.events(snapshot.since, snapshot.asOf, playerId.data, serverId),
    };
  }
}
