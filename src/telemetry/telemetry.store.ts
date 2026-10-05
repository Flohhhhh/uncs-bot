import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { combatEvents, combatTracking, gameFeedEventTypes } from "../database/telemetry.schema";
import {
  type CombatAggregate,
  type FeedEventTypeSummary,
  type ParsedFeed,
  type ServerStatsAggregate,
  type TrackingRecord,
  type WeeklyHighlights,
  emptyHighlights,
  emptyTotals,
  LEADER_TAGS,
  PUBLIC_MAX_DISTANCE_CENTIMETERS,
} from "./telemetry.types";

/** New event types recorded per server and UTC day, killed aside, so a bad feed cannot add unbounded rows. */
export const MAX_FEED_TYPES_PER_DAY = 200;
const RETENTION_MS = 90 * 86_400_000;
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Read-only stats reads see one consistent snapshot, so their numbers add up. */
const READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
/** The public distance cap as an SQL literal: a code constant, never input. */
const DISTANCE_CAP = sql.raw(String(PUBLIC_MAX_DISTANCE_CENTIMETERS));
// context_tags keeps the feed's full strings, so a tag matches with or without either known prefix.
const TAG_PREFIXES = ["", "Meta.Progression.Context.Player.KillContext.", "Meta.PlayerKillFlag.Player."];
/** `<column> ?| ARRAY[...]` over every stored spelling of these tags. Built only from code constants. */
function hasTag(column: string, ...tags: string[]) {
  const variants = tags.flatMap((tag) => {
    if (!/^[A-Za-z]+$/.test(tag)) throw new Error("Tag constants must be plain words.");
    return TAG_PREFIXES.map((prefix) => `'${prefix}${tag}'`);
  });
  return sql.raw(`${column} ?| ARRAY[${variants.join(",")}]`);
}
/**
 * `server_id = $1 AND received_at >= $2 AND received_at <= $3`: the leading columns of
 * combat_events_received_idx. The first use in a statement binds the three values; later uses reuse
 * those same parameters, so every scan in the statement reads one window. Use it first in text order.
 */
function receivedWindow(serverId: string, since: Date, until: Date) {
  let bound = false;
  return (alias = "") => {
    const p = alias ? `${alias}.` : "";
    if (bound) return sql.raw(`${p}server_id = $1 AND ${p}received_at >= $2 AND ${p}received_at <= $3`);
    bound = true;
    return sql`${sql.raw(p)}server_id = ${serverId} AND ${sql.raw(p)}received_at >= ${since} AND ${sql.raw(p)}received_at <= ${until}`;
  };
}

@Injectable()
export class TelemetryStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Adds this batch's per-type counts to today's rows in one statement. Existing rows always count;
   * types new today are added in batch order while the server has fewer than MAX_FEED_TYPES_PER_DAY
   * of them. Returns how many of the batch's types were over that limit and not recorded.
   */
  private async tallyTypes(tx: Transaction, batch: ParsedFeed, receivedAt: Date, serverId: string) {
    if (!batch.types.length) return 0;
    const day = utcDay(receivedAt);
    const rows = sql.join(
      batch.types.map(
        (entry, order) =>
          sql`(${entry.type}::varchar, ${entry.count}::bigint, ${entry.sample === null ? null : JSON.stringify(entry.sample)}::jsonb, ${order}::int)`,
      ),
      sql`, `,
    );
    // A stored sample is replaced by a newer one, and by a size marker (which has no "type" key) only
    // when there is none yet. killed never carries a sample.
    const result = await tx.execute<{ type: string }>(sql`
      WITH batch(type, count, sample, ord) AS (VALUES ${rows}),
      today AS (SELECT type FROM game_feed_event_types WHERE server_id = ${serverId} AND day = ${day}::date),
      fresh AS (
        SELECT batch.*, row_number() OVER (ORDER BY ord) AS rank FROM batch
        WHERE type <> 'killed' AND type NOT IN (SELECT type FROM today)
      ), allowed AS (
        SELECT type, count, sample FROM batch WHERE type = 'killed' OR type IN (SELECT type FROM today)
        UNION ALL
        SELECT type, count, sample FROM fresh
        WHERE rank <= ${MAX_FEED_TYPES_PER_DAY} - (SELECT count(*) FROM today WHERE type <> 'killed')
      )
      INSERT INTO game_feed_event_types AS stored (server_id, type, day, count, first_received_at, last_received_at, sample)
      SELECT ${serverId}, type, ${day}::date, count, ${receivedAt}, ${receivedAt}, sample FROM allowed
      ON CONFLICT (server_id, type, day) DO UPDATE SET
        count = stored.count + excluded.count,
        first_received_at = least(stored.first_received_at, excluded.first_received_at),
        last_received_at = greatest(stored.last_received_at, excluded.last_received_at),
        sample = CASE
          WHEN excluded.sample IS NULL THEN stored.sample
          WHEN excluded.sample ? 'type' THEN excluded.sample
          ELSE coalesce(stored.sample, excluded.sample)
        END
      RETURNING type
    `);
    return batch.types.length - result.rows.length;
  }

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
      // After the tracking upsert, which holds this server's tracking row until commit, so concurrent
      // batches for one server count today's types one at a time and the daily limit holds.
      const typesOverLimit = await this.tallyTypes(tx, batch, receivedAt, serverId);
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
      if (cleanup.length) {
        const cutoff = new Date(receivedAt.getTime() - RETENTION_MS);
        await tx
          .delete(combatEvents)
          .where(and(eq(combatEvents.serverId, serverId), lt(combatEvents.receivedAt, cutoff)));
        await tx
          .delete(gameFeedEventTypes)
          .where(and(eq(gameFeedEventTypes.serverId, serverId), lt(gameFeedEventTypes.day, utcDay(cutoff))));
      }
      return { inserted, duplicates: batch.events.length - inserted, skipped: batch.skipped, typesOverLimit };
    });
  }

  /**
   * Staff diagnostic: each feed event type counted on the UTC days that overlap since..until, with
   * its total, first and last receipt and latest kept sample. Whole days, so totals can include
   * entries received shortly before since.
   */
  async eventTypes(since: Date, until: Date, serverId = "primary"): Promise<FeedEventTypeSummary[]> {
    const rows = await this.db.execute<FeedEventTypeSummary>(sql`
      WITH scoped AS (
        SELECT * FROM game_feed_event_types
        WHERE server_id = ${serverId} AND day >= ${utcDay(since)}::date AND day <= ${utcDay(until)}::date
      ), totals AS (
        SELECT type, sum(count) AS count, min(first_received_at) AS first_received_at,
          max(last_received_at) AS last_received_at
        FROM scoped GROUP BY type
      ), latest AS (
        SELECT DISTINCT ON (type) type, sample FROM scoped WHERE sample IS NOT NULL
        ORDER BY type, last_received_at DESC, day DESC
      )
      SELECT totals.type, totals.count::float8 AS count, totals.first_received_at AS "firstReceivedAt",
        totals.last_received_at AS "lastReceivedAt", latest.sample
      FROM totals LEFT JOIN latest USING (type)
      ORDER BY totals.count DESC, totals.type LIMIT ${MAX_FEED_TYPES_PER_DAY + 1}
    `);
    return rows.rows.map((row) => ({
      type: row.type,
      count: Number(row.count),
      firstReceivedAt: new Date(row.firstReceivedAt),
      lastReceivedAt: new Date(row.lastReceivedAt),
      sample: row.sample ?? null,
    }));
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
          SELECT min(btrim(cause)) AS cause, count(*)::int AS kills FROM kills WHERE cause IS NOT NULL AND btrim(cause) <> ''
          GROUP BY lower(btrim(cause)) ORDER BY count(*) DESC, lower(btrim(cause)) LIMIT 1
        ) r) AS "topCause",
        COALESCE((SELECT json_agg(row_to_json(r)) FROM (
          SELECT map_name AS "mapName", count(*)::int AS kills FROM kills WHERE map_name IS NOT NULL AND map_name <> ''
          GROUP BY map_name ORDER BY count(*) DESC, map_name LIMIT 50
        ) r), '[]'::json) AS maps
    `);
    return rows.rows[0] ?? emptyHighlights();
  }

  /**
   * Server-wide stats inputs over the same bounds as snapshot(), in three read-only statements that share
   * one snapshot. A kill is a non-suicide event with a linked killer, as in snapshot(), so these totals
   * match the leaderboard's. Each statement range-scans combat_events_received_idx; there is no
   * materialized copy of the window. Rows keep SteamIDs for name lookups and never leave the service.
   */
  async serverStats(since: Date, until: Date, serverId = "primary"): Promise<ServerStatsAggregate> {
    return this.db.transaction(async (tx) => {
      // S1: kills by cause, by map, by UTC hour and in total, in one scan with hashed grouping sets.
      const range1 = receivedWindow(serverId, since, until);
      const groups = await tx.execute<ServerStatsAggregate["groups"][number]>(sql`
        SELECT GROUPING(cause_key, map_name, hour)::int AS "set", cause_key AS "causeKey", min(cause) AS cause,
          map_name AS "mapName", hour, count(*)::int AS kills,
          (count(*) FILTER (WHERE headshot))::int AS "headshotKills",
          max(distance_centimeters) FILTER (WHERE distance_centimeters > 0 AND distance_centimeters <= ${DISTANCE_CAP}) AS "longestCentimeters",
          (count(*) FILTER (WHERE ${hasTag("context_tags", LEADER_TAGS.melee)}))::int AS melee,
          (count(*) FILTER (WHERE ${hasTag("context_tags", LEADER_TAGS.roadkill)}))::int AS roadkill,
          (count(*) FILTER (WHERE ${hasTag("context_tags", LEADER_TAGS.vehicleExplosion)}))::int AS "vehicleExplosion",
          (count(*) FILTER (WHERE ${hasTag("context_tags", LEADER_TAGS.penetration)}))::int AS penetration,
          (count(*) FILTER (WHERE ${hasTag("context_tags", LEADER_TAGS.ricochet)}))::int AS ricochet
        FROM (
          SELECT lower(nullif(btrim(cause), '')) AS cause_key, nullif(btrim(cause), '') AS cause,
            nullif(btrim(map_name), '') AS map_name, extract(hour FROM received_at AT TIME ZONE 'UTC')::int AS hour,
            headshot, distance_centimeters, context_tags
          FROM combat_events
          WHERE ${range1()} AND NOT suicide AND killer_steam_id IS NOT NULL
        ) k
        GROUP BY GROUPING SETS ((cause_key), (map_name), (hour), ())
      `);
      // S2: event totals. Each event is read once as its killer and once as its victim.
      const range2 = receivedWindow(serverId, since, until);
      const totals = await tx.execute<ServerStatsAggregate["totals"]>(sql`
        SELECT (count(*) FILTER (WHERE v.n = 1))::int AS events,
          (count(*) FILTER (WHERE v.n = 2 AND v.id IS NOT NULL))::int AS deaths,
          (count(*) FILTER (WHERE v.n = 1 AND e.suicide))::int AS suicides,
          (count(*) FILTER (WHERE v.n = 2 AND v.id IS NOT NULL AND ${hasTag("e.context_tags", LEADER_TAGS.falling)}))::int AS falling,
          count(DISTINCT v.id)::int AS players
        FROM combat_events e CROSS JOIN LATERAL (VALUES (1, e.killer_steam_id), (2, e.victim_steam_id)) AS v(n, id)
        WHERE ${range2("e")}
      `);
      // S3: named lists. Each player's longest kill from the top 200, and the top five per tag, with
      // snapshot()'s latest non-empty name looked up only for those players.
      const range3 = receivedWindow(serverId, since, until);
      const lists = await tx.execute<Pick<ServerStatsAggregate, "longest" | "leaders">>(sql`
        WITH longest AS (
          SELECT DISTINCT ON (killer_steam_id) killer_steam_id AS steam_id, cause, map_name, distance_centimeters,
            received_at, event_id
          FROM (
            SELECT killer_steam_id, cause, map_name, distance_centimeters, received_at, event_id FROM combat_events
            WHERE ${range3()} AND NOT suicide AND killer_steam_id IS NOT NULL
              AND distance_centimeters > 0 AND distance_centimeters <= ${DISTANCE_CAP}
            ORDER BY distance_centimeters DESC, received_at, event_id LIMIT 200
          ) top
          ORDER BY killer_steam_id, distance_centimeters DESC, received_at, event_id
        ), tagged AS (
          SELECT t.tag, t.steam_id FROM combat_events e
          CROSS JOIN LATERAL (VALUES
            ('melee', e.killer_steam_id, NOT e.suicide AND ${hasTag("e.context_tags", LEADER_TAGS.melee)}),
            ('roadkill', e.killer_steam_id, NOT e.suicide AND ${hasTag("e.context_tags", LEADER_TAGS.roadkill)}),
            ('vehicleExplosion', e.killer_steam_id, NOT e.suicide AND ${hasTag("e.context_tags", LEADER_TAGS.vehicleExplosion)}),
            ('penetration', e.killer_steam_id, NOT e.suicide AND ${hasTag("e.context_tags", LEADER_TAGS.penetration)}),
            ('ricochet', e.killer_steam_id, NOT e.suicide AND ${hasTag("e.context_tags", LEADER_TAGS.ricochet)}),
            ('falling', e.victim_steam_id, ${hasTag("e.context_tags", LEADER_TAGS.falling)})
          ) AS t(tag, steam_id, hit)
          WHERE ${range3("e")} AND ${hasTag("e.context_tags", ...Object.values(LEADER_TAGS))}
            AND t.hit AND t.steam_id IS NOT NULL
        ), leaders AS (
          SELECT tag, steam_id, hits FROM (
            SELECT tag, steam_id, count(*)::int AS hits,
              row_number() OVER (PARTITION BY tag ORDER BY count(*) DESC, steam_id) AS rank
            FROM tagged GROUP BY tag, steam_id
          ) ranked WHERE rank <= 5
        ), named AS (
          SELECT steam_id FROM longest UNION SELECT steam_id FROM leaders
        ), names AS (
          SELECT DISTINCT ON (steam_id) steam_id, name FROM (
            SELECT killer_steam_id AS steam_id, killer_name AS name, received_at, event_id FROM combat_events
            WHERE ${range3()} AND killer_steam_id IN (SELECT steam_id FROM named)
              AND killer_name IS NOT NULL AND killer_name <> ''
            UNION ALL
            SELECT victim_steam_id, victim_name, received_at, event_id FROM combat_events
            WHERE ${range3()} AND victim_steam_id IN (SELECT steam_id FROM named)
              AND victim_name IS NOT NULL AND victim_name <> ''
          ) seen
          ORDER BY steam_id, received_at DESC, event_id DESC
        )
        SELECT
          COALESCE((SELECT json_agg(row_to_json(r)) FROM (
            SELECT longest.steam_id AS "steamId", names.name, longest.cause, longest.map_name AS "mapName",
              longest.distance_centimeters AS "distanceCentimeters"
            FROM longest LEFT JOIN names USING (steam_id)
            ORDER BY longest.distance_centimeters DESC, longest.received_at, longest.event_id LIMIT 10
          ) r), '[]'::json) AS longest,
          COALESCE((SELECT json_agg(row_to_json(r)) FROM (
            SELECT leaders.tag, leaders.steam_id AS "steamId", names.name, leaders.hits AS count
            FROM leaders LEFT JOIN names USING (steam_id)
            ORDER BY leaders.tag, leaders.hits DESC, leaders.steam_id
          ) r), '[]'::json) AS leaders
      `);
      return {
        groups: groups.rows,
        totals: totals.rows[0] ?? { events: 0, deaths: 0, suicides: 0, falling: 0, players: 0 },
        longest: lists.rows[0]?.longest ?? [],
        leaders: lists.rows[0]?.leaders ?? [],
      };
    }, READ_ONLY);
  }

  /**
   * Supporting context for a staff review prompt: this player's most recent kills (at most 500,
   * suicides excluded) between since and until. Never used to decide anything.
   */
  async killContext(serverId: string, steamId: string, since: Date, windowSince: Date, until: Date) {
    const rows = await this.db.execute<{
      kills: number;
      windowKills: number;
      headshotKills: number;
      maxDistanceMeters: number | null;
      topCauses: string[] | null;
    }>(sql`
      WITH recent AS (
        SELECT received_at, cause, headshot, distance_centimeters FROM combat_events
        WHERE server_id = ${serverId} AND killer_steam_id = ${steamId} AND NOT suicide
          AND received_at >= ${since} AND received_at <= ${until}
        ORDER BY received_at DESC LIMIT 500
      )
      SELECT count(*)::int AS kills,
        (count(*) FILTER (WHERE received_at >= ${windowSince}))::int AS "windowKills",
        (count(*) FILTER (WHERE headshot))::int AS "headshotKills",
        max(distance_centimeters) / 100.0 AS "maxDistanceMeters",
        (SELECT json_agg(cause) FROM (
          SELECT cause FROM recent WHERE cause IS NOT NULL AND cause <> ''
          GROUP BY cause ORDER BY count(*) DESC, cause LIMIT 2
        ) top) AS "topCauses"
      FROM recent
    `);
    const row = rows.rows[0];
    return {
      kills: Number(row?.kills ?? 0),
      windowKills: Number(row?.windowKills ?? 0),
      headshotKills: Number(row?.headshotKills ?? 0),
      maxDistanceMeters:
        row?.maxDistanceMeters === null || row?.maxDistanceMeters === undefined ? null : Number(row.maxDistanceMeters),
      topCauses: Array.isArray(row?.topCauses) ? row.topCauses.filter((cause) => typeof cause === "string") : [],
    };
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
