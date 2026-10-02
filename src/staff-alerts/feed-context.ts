import { Injectable } from "@nestjs/common";
import { TelemetryDeliveries } from "../telemetry/telemetry.deliveries";
import { TelemetryStore } from "../telemetry/telemetry.store";
import type { FeedContextView } from "../common/staff-alerts";

/** Optional combat-feed context for performance alerts. The rules never depend on it. */
export interface FeedContextSource {
  context(
    serverId: string,
    steamId: string,
    range: { since: number; windowSince: number; until: number },
  ): Promise<FeedContextView | null>;
}
export const FEED_CONTEXT = Symbol("STAFF_ALERTS_FEED_CONTEXT");
export const FEED_RECENT_MS = 10 * 60_000;

/**
 * Reads combat_events only while the feed is actually delivering: a stored batch for this server
 * in the last 10 minutes. Until the first batch arrives, alerts carry no feed context.
 */
@Injectable()
export class TelemetryFeedContext implements FeedContextSource {
  constructor(
    private readonly deliveries: TelemetryDeliveries,
    private readonly store: TelemetryStore,
  ) {}

  async context(serverId: string, steamId: string, range: { since: number; windowSince: number; until: number }) {
    const batch = this.deliveries.status(serverId).lastBatch;
    const received = batch ? Date.parse(batch.at) : NaN;
    if (!Number.isFinite(received) || range.until - received > FEED_RECENT_MS) return null;
    const context = await this.store.killContext(
      serverId,
      steamId,
      new Date(range.since),
      new Date(range.windowSince),
      new Date(range.until),
    );
    return {
      kills: context.kills,
      windowKills: context.windowKills,
      headshotShare: context.kills ? Math.round((context.headshotKills / context.kills) * 100) / 100 : null,
      topCauses: context.topCauses.slice(0, 2).map((cause) => cause.slice(0, 64)),
      maxDistanceMeters:
        context.maxDistanceMeters === null || !Number.isFinite(context.maxDistanceMeters)
          ? null
          : Math.round(context.maxDistanceMeters),
      since: new Date(range.since).toISOString(),
    } satisfies FeedContextView;
  }
}
