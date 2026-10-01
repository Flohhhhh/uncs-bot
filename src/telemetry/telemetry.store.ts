import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { combatEvents, combatTracking } from "../database/telemetry.schema";
import { type CombatAggregate, type ParsedFeed, type TrackingRecord, emptyTotals } from "./telemetry.types";

@Injectable()
export class TelemetryStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async ingest(batch: ParsedFeed, receivedAt: Date, serverId = "primary") {
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      if (batch.events.length) {
        const rows = await tx
          .insert(combatEvents)
          .values(
            batch.events.map((event) => ({
              ...event,
              serverId,
              serverInstanceId: batch.serverId,
              serverName: batch.serverName,
              receivedAt,
            })),
          )
          .onConflictDoNothing({ target: [combatEvents.serverId, combatEvents.serverInstanceId, combatEvents.eventId] })
          .returning({ eventId: combatEvents.eventId });
        inserted = rows.length;
      }
      await tx
        .insert(combatTracking)
        .values({ id: serverId, firstReceivedAt: receivedAt, lastReceivedAt: receivedAt })
        .onConflictDoUpdate({
          target: combatTracking.id,
          set: {
            firstReceivedAt: sql`least(${combatTracking.firstReceivedAt}, ${receivedAt})`,
            lastReceivedAt: sql`greatest(${combatTracking.lastReceivedAt}, ${receivedAt})`,
          },
        });
      const cleanup = await tx
        .update(combatTracking)
        .set({ lastCleanupAt: receivedAt })
        .where(
          and(
            eq(combatTracking.id, serverId),
            or(
              isNull(combatTracking.lastCleanupAt),
              lt(combatTracking.lastCleanupAt, new Date(receivedAt.getTime() - 86_400_000)),
            ),
          ),
        )
        .returning({ id: combatTracking.id });
      if (cleanup.length)
        await tx
          .delete(combatEvents)
          .where(
            and(
              eq(combatEvents.serverId, serverId),
              lt(combatEvents.receivedAt, new Date(receivedAt.getTime() - 90 * 86_400_000)),
            ),
          );
      return { inserted, duplicates: batch.events.length - inserted, skipped: batch.skipped };
    });
  }

  async tracking(serverId = "primary"): Promise<TrackingRecord> {
    const [record] = await this.db
      .select({ firstReceivedAt: combatTracking.firstReceivedAt, lastReceivedAt: combatTracking.lastReceivedAt })
      .from(combatTracking)
      .where(eq(combatTracking.id, serverId));
    return record ?? null;
  }

  async snapshot(since: Date, until: Date, playerId?: string, serverId = "primary"): Promise<CombatAggregate> {
    const rows = await this.db.execute<CombatAggregate>(sql`
      WITH scoped AS (
        SELECT * FROM combat_events WHERE server_id = ${serverId} AND received_at >= ${since} AND received_at <= ${until}
          ${playerId ? sql`AND (killer_steam_id = ${playerId} OR victim_steam_id = ${playerId})` : sql``}
      ), actors AS (
        SELECT killer_steam_id AS steam_id, killer_name AS name, received_at, event_id,
          CASE WHEN NOT suicide THEN 1 ELSE 0 END AS kills, 0 AS deaths,
          CASE WHEN NOT suicide AND headshot THEN 1 ELSE 0 END AS headshot_kills
        FROM scoped WHERE killer_steam_id IS NOT NULL
        UNION ALL
        SELECT victim_steam_id, victim_name, received_at, event_id, 0, 1, 0
        FROM scoped WHERE victim_steam_id IS NOT NULL
      ), names AS (
        SELECT DISTINCT ON (steam_id) steam_id, name FROM actors WHERE name IS NOT NULL AND name <> ''
        ORDER BY steam_id, received_at DESC, event_id DESC
      ), stats AS (
        SELECT steam_id, sum(kills) AS kills, sum(deaths) AS deaths,
          sum(headshot_kills) AS headshot_kills FROM actors
        ${playerId ? sql`WHERE steam_id = ${playerId}` : sql``}
        GROUP BY steam_id
      )
      SELECT COALESCE((SELECT json_agg(row_to_json(r)) FROM (
        SELECT stats.steam_id AS "steamId", coalesce(names.name, stats.steam_id) AS name,
          kills, deaths, headshot_kills AS "headshotKills",
          CASE WHEN deaths = 0 THEN NULL ELSE round(kills::numeric / deaths, 2) END AS kd
        FROM stats LEFT JOIN names USING (steam_id)
        ORDER BY kills DESC, deaths ASC, stats.steam_id LIMIT 100
      ) r), '[]'::json) AS leaderboard,
      json_build_object('events', (SELECT count(*) FROM scoped),
        'kills', coalesce((SELECT sum(kills) FROM stats), 0),
        'deaths', coalesce((SELECT sum(deaths) FROM stats), 0),
        'headshotKills', coalesce((SELECT sum(headshot_kills) FROM stats), 0),
        'players', (SELECT count(*) FROM stats)) AS totals
    `);
    return rows.rows[0] ?? { leaderboard: [], totals: emptyTotals() };
  }

  async events(since: Date, until: Date, playerId?: string, serverId = "primary") {
    const rows = await this.db
      .select({
        eventId: combatEvents.eventId,
        serverInstanceId: combatEvents.serverInstanceId,
        receivedAt: combatEvents.receivedAt,
        eventTime: combatEvents.eventTime,
        matchId: combatEvents.matchId,
        mapName: combatEvents.mapName,
        killerSteamId: combatEvents.killerSteamId,
        killerName: combatEvents.killerName,
        victimSteamId: combatEvents.victimSteamId,
        victimName: combatEvents.victimName,
        cause: combatEvents.cause,
        distanceMeters: sql<number | null>`${combatEvents.distanceCentimeters} / 100.0`,
        headshot: combatEvents.headshot,
        suicide: combatEvents.suicide,
      })
      .from(combatEvents)
      .where(
        and(
          eq(combatEvents.serverId, serverId),
          gte(combatEvents.receivedAt, since),
          lte(combatEvents.receivedAt, until),
          playerId ? or(eq(combatEvents.killerSteamId, playerId), eq(combatEvents.victimSteamId, playerId)) : undefined,
        ),
      )
      .orderBy(desc(combatEvents.receivedAt), desc(combatEvents.eventId))
      .limit(100);
    return rows;
  }
}
