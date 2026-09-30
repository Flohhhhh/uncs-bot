import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { EnvService } from "../env/env.service";
import { TelemetryStore } from "./telemetry.store";
import {
  emptyTotals,
  parseFeed,
  periodMilliseconds,
  periodSchema,
  telemetrySteamId,
  type CombatAggregate,
  type TelemetryPeriod,
  type TrackingRecord,
} from "./telemetry.types";

@Injectable()
export class TelemetryService {
  private readonly snapshots = new Map<
    string,
    { until: number; value: Promise<{ aggregate: CombatAggregate; tracking: TrackingRecord; since: Date; asOf: Date }> }
  >();
  constructor(
    private readonly store: TelemetryStore,
    private readonly env: EnvService,
  ) {}

  private configured() {
    const token = this.env.get("WARDOGS_FEED_TOKEN");
    return (
      this.env.get("WARDOGS_FEED_ENABLED") &&
      typeof token === "string" &&
      token.length >= 32 &&
      token !== this.env.get("WARDOGS_RCON_PASSWORD")
    );
  }

  async ingest(authorization: unknown, body: unknown) {
    if (!this.configured()) throw new ServiceUnavailableException("The game event feed is not connected yet.");
    const match = typeof authorization === "string" && /^Bearer ([^\s]{1,512})(?![\s\S])/i.exec(authorization);
    const actual = createHash("sha256")
      .update(match ? match[1] : "")
      .digest();
    const expected = createHash("sha256").update(this.env.get("WARDOGS_FEED_TOKEN")!).digest();
    if (!match || !timingSafeEqual(actual, expected)) throw new UnauthorizedException("Invalid game feed credentials.");
    const parsed = parseFeed(body);
    const result = await this.store.ingest(parsed, new Date());
    this.snapshots.clear();
    return { ok: true, ...result };
  }

  private period(input: unknown): TelemetryPeriod {
    const value = periodSchema.safeParse(input === undefined ? "week" : input);
    if (!value.success) throw new BadRequestException("Choose day, week or month.");
    return value.data;
  }

  private async snapshot(period: TelemetryPeriod, playerId?: string) {
    const key = `${period}:${playerId ?? "all"}`;
    const now = Date.now();
    const existing = this.snapshots.get(key);
    if (existing && existing.until > now) return existing.value;
    const asOf = new Date(now),
      since = new Date(now - periodMilliseconds[period]);
    if (this.snapshots.size >= 100) this.snapshots.delete(this.snapshots.keys().next().value!);
    const value = Promise.all([this.store.snapshot(since, asOf, playerId), this.store.tracking()]).then(
      ([aggregate, tracking]) => ({ aggregate, tracking, since, asOf }),
    );
    const entry = { until: now + 10_000, value };
    this.snapshots.set(key, entry);
    try {
      return await value;
    } catch (error) {
      if (this.snapshots.get(key) === entry) this.snapshots.delete(key);
      throw error;
    }
  }

  private metadata(period: TelemetryPeriod, tracking: TrackingRecord, since: Date, asOf: Date) {
    const enabled = this.configured();
    const last = tracking?.lastReceivedAt ?? null;
    return {
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
        ? "Game event tracking is not connected. Existing host feed settings have not been changed."
        : "Based on events received during this time window. Earlier matches, delayed events and delivery gaps may affect totals. A quiet feed can simply mean no deaths occurred.",
    };
  }

  private summary(aggregate: CombatAggregate): CombatAggregate {
    // Public output contains only game statistics, even if storage gains fields.
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

  async leaderboard(input?: unknown) {
    const period = this.period(input);
    if (!this.configured()) {
      const now = new Date();
      return {
        ...this.metadata(period, null, new Date(now.getTime() - periodMilliseconds[period]), now),
        leaderboard: [],
        totals: emptyTotals(),
      };
    }
    const snapshot = await this.snapshot(period);
    return {
      ...this.metadata(period, snapshot.tracking, snapshot.since, snapshot.asOf),
      ...this.summary(snapshot.aggregate),
    };
  }

  async combat(input?: unknown) {
    const result = await this.leaderboard(input);
    const events = result.enabled
      ? await this.store.events(new Date(result.windowStartedAt), new Date(result.asOf))
      : [];
    return { ...result, events };
  }

  async player(id: unknown, input?: unknown) {
    const playerId = telemetrySteamId.safeParse(id);
    if (!playerId.success) throw new BadRequestException("Enter a valid SteamID64.");
    const period = this.period(input);
    if (!this.configured()) {
      const { leaderboard: _leaderboard, ...base } = await this.leaderboard(period);
      return { ...base, steamId: playerId.data, player: null, events: [] };
    }
    const snapshot = await this.snapshot(period, playerId.data);
    return {
      ...this.metadata(period, snapshot.tracking, snapshot.since, snapshot.asOf),
      steamId: playerId.data,
      player: snapshot.aggregate.leaderboard.find((entry) => entry.steamId === playerId.data) ?? null,
      totals: snapshot.aggregate.totals,
      events: await this.store.events(snapshot.since, snapshot.asOf, playerId.data),
    };
  }
}
