import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { EnvService } from "../env/env.service";
import { GameServers } from "../admin/game-servers";
import { publicGameServer } from "../common/game-server";
import { TelemetryDeliveries } from "./telemetry.deliveries";
import { TelemetryStore } from "./telemetry.store";
import {
  emptyTotals,
  FeedRejectedException,
  parseFeed,
  periodMilliseconds,
  periodSchema,
  telemetrySteamId,
  type CombatAggregate,
  type CombatStats,
  type ParsedFeed,
  type PublicCombatStats,
  type TelemetryPeriod,
  type TrackingRecord,
} from "./telemetry.types";

export const UNNAMED_PLAYER = "Unnamed player";

// Storage falls back to the SteamID when no display name was observed, so a public row
// replaces any name that is, or contains, a SteamID with a neutral label.
export function publicStats({ steamId, name, kills, deaths, headshotKills, kd }: CombatStats): PublicCombatStats {
  const label = typeof name === "string" ? name.trim() : "";
  const identifying = !label || /^\d{17}$/.test(label) || (!!steamId && label.includes(steamId));
  return { name: identifying ? UNNAMED_PLAYER : name, kills, deaths, headshotKills, kd };
}

@Injectable()
export class TelemetryService {
  private readonly snapshots = new Map<
    string,
    { until: number; value: Promise<{ aggregate: CombatAggregate; tracking: TrackingRecord; since: Date; asOf: Date }> }
  >();
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
    const token = this.servers.feedToken(serverId);
    return typeof token === "string" && token.length >= 32 ? null : "feed token not configured";
  }

  private configured(serverId: string) {
    return this.unavailable(serverId) === null;
  }

  // Records a refused delivery for staff (category and status only) and returns the error to throw.
  private refuse(serverId: string | undefined, reason: string, error: unknown) {
    this.deliveries.rejected(serverId, error instanceof HttpException ? error.getStatus() : 503, reason);
    return error;
  }

  async ingest(authorization: unknown, body: unknown, id?: string) {
    let serverId: string;
    try {
      serverId = this.servers.resolve(id);
    } catch (error) {
      throw this.refuse(id, error instanceof BadRequestException ? "server not selected" : "unknown server", error);
    }
    const unavailable = this.unavailable(serverId);
    if (unavailable)
      throw this.refuse(
        serverId,
        unavailable,
        new ServiceUnavailableException("The game event feed is not connected yet."),
      );
    const match = typeof authorization === "string" && /^Bearer ([^\s]{1,512})(?![\s\S])/i.exec(authorization);
    const actual = createHash("sha256")
      .update(match ? match[1] : "")
      .digest();
    const expected = createHash("sha256").update(this.servers.feedToken(serverId)!).digest();
    if (!match || !timingSafeEqual(actual, expected))
      throw this.refuse(
        serverId,
        match ? "token mismatch" : authorization ? "malformed credentials" : "missing credentials",
        new UnauthorizedException("Invalid game feed credentials."),
      );
    let parsed: ParsedFeed;
    try {
      parsed = parseFeed(body);
    } catch (error) {
      throw this.refuse(serverId, error instanceof FeedRejectedException ? error.reason : "invalid payload", error);
    }
    let result: Awaited<ReturnType<TelemetryStore["ingest"]>>;
    try {
      result = await this.store.ingest(parsed, new Date(), serverId);
    } catch (error) {
      throw this.refuse(serverId, "storage unavailable", error);
    }
    this.deliveries.accepted(serverId, {
      accepted: parsed.events.length,
      skipped: parsed.skipped,
      invalid: parsed.invalid,
      firstInvalid: parsed.firstInvalid,
    });
    for (const key of this.snapshots.keys()) if (key.startsWith(`${serverId}:`)) this.snapshots.delete(key);
    return { ok: true, ...result };
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

  private metadata(serverId: string, period: TelemetryPeriod, tracking: TrackingRecord, since: Date, asOf: Date) {
    const enabled = this.configured(serverId);
    const last = tracking?.lastReceivedAt ?? null;
    return {
      serverId,
      enabled,
      connected: enabled && last !== null,
      feedStatus:
        last === null
          ? ("waiting" as const)
          : Date.now() - last.getTime() <= 60_000
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

  /** Public leaderboard: display names and game statistics, never SteamIDs. */
  async leaderboard(input?: unknown, id?: string) {
    const result = await this.ranking(input, id);
    return { ...result, leaderboard: result.leaderboard.map(publicStats) };
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
    const events = result.enabled
      ? await this.store.events(new Date(result.windowStartedAt), new Date(result.asOf), undefined, result.serverId)
      : [];
    // Delivery diagnostics are staff-only; the public leaderboard never includes them.
    return { ...result, ...this.deliveries.status(result.serverId), events };
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
