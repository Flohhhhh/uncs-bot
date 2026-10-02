import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { combatEvents, combatTracking } from "../database/telemetry.schema";
import {
  type CombatAggregate,
  type ParsedFeed,
  type TrackingRecord,
  type WeeklyHighlights,
  emptyHighlights,
  emptyTotals,
} from "./telemetry.types";

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

  /**
   * Read-only weekly shout-out inputs over the same bounds as snapshot(). A kill is a non-suicide
   * event with a linked killer; names use snapshot()'s latest non-empty name, else the SteamID.
   * bestKd only ranks players with at least minKdKills kills.
   */
  async weeklyHighlights(since: Date, until: Date, serverId = "primary", minKdKills = 10): Promise<WeeklyHighlights> {
    const rows = await this.db.execute<WeeklyHighlights>(sql`
      WITH scoped AS (
        SELECT * FROM combat_events WHERE server_id = ${serverId} AND received_at >= ${since} AND received_at <= ${until}
      ), kills AS (
        SELECT * FROM scoped WHERE NOT suicide AND killer_steam_id IS NOT NULL
      ), actors AS (
        SELECT killer_steam_id AS steam_id, killer_name AS name, received_at, event_id
        FROM scoped WHERE killer_steam_id IS NOT NULL
        UNION ALL
        SELECT victim_steam_id, victim_name, received_at, event_id
        FROM scoped WHERE victim_steam_id IS NOT NULL
      ), names AS (
        SELECT DISTINCT ON (steam_id) steam_id, name FROM actors WHERE name IS NOT NULL AND name <> ''
        ORDER BY steam_id, received_at DESC, event_id DESC
      ), killers AS (
        SELECT killer_steam_id AS steam_id, count(*)::int AS kills,
          (count(*) FILTER (WHERE headshot))::int AS headshot_kills
        FROM kills GROUP BY killer_steam_id
      ), victims AS (
        SELECT victim_steam_id AS steam_id, count(*)::int AS deaths
        FROM scoped WHERE victim_steam_id IS NOT NULL GROUP BY victim_steam_id
      ), players AS (
        SELECT killers.steam_id, coalesce(names.name, killers.steam_id) AS name, killers.kills,
          killers.headshot_kills, coalesce(victims.deaths, 0)::int AS deaths
        FROM killers LEFT JOIN victims USING (steam_id) LEFT JOIN names USING (steam_id)
      )
      SELECT
        (SELECT row_to_json(r) FROM (
          SELECT steam_id AS "steamId", name, kills, deaths FROM players WHERE kills >= ${minKdKills}
          ORDER BY kills::numeric / greatest(deaths, 1) DESC, kills DESC, steam_id LIMIT 1
        ) r) AS "bestKd",
        (SELECT row_to_json(r) FROM (
          SELECT steam_id AS "steamId", name, headshot_kills AS "headshotKills" FROM players WHERE headshot_kills > 0
          ORDER BY headshot_kills DESC, kills DESC, steam_id LIMIT 1
        ) r) AS "mostHeadshots",
        (SELECT row_to_json(r) FROM (
          SELECT kills.killer_steam_id AS "steamId", coalesce(names.name, kills.killer_steam_id) AS name,
            kills.distance_centimeters AS "distanceCentimeters", kills.cause, kills.map_name AS "mapName"
          FROM kills LEFT JOIN names ON names.steam_id = kills.killer_steam_id
          WHERE kills.distance_centimeters IS NOT NULL
          ORDER BY kills.distance_centimeters DESC, kills.received_at, kills.event_time, kills.event_id LIMIT 1
        ) r) AS "longestKill",
        (SELECT count(*)::int FROM kills) AS kills,
        (SELECT count(*)::int FROM kills WHERE cause IS NOT NULL AND cause <> '') AS "killsWithCause",
        (SELECT row_to_json(r) FROM (
          SELECT cause, count(*)::int AS kills FROM kills WHERE cause IS NOT NULL AND cause <> ''
          GROUP BY cause ORDER BY count(*) DESC, cause LIMIT 1
        ) r) AS "topCause",
        COALESCE((SELECT json_agg(row_to_json(r)) FROM (
          SELECT map_name AS "mapName", count(*)::int AS kills FROM kills WHERE map_name IS NOT NULL AND map_name <> ''
          GROUP BY map_name ORDER BY count(*) DESC, map_name LIMIT 50
        ) r), '[]'::json) AS maps
    `);
    return rows.rows[0] ?? emptyHighlights();
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
