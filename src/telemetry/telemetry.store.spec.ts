import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { combatEvents, gameFeedEventTypes } from "../database/telemetry.schema";
import { FIREARM_ITEM_KEYS } from "../common/cause-labels";
import { MAX_FEED_TYPES_PER_DAY, TelemetryStore } from "./telemetry.store";
import { MAX_SAMPLE_BYTES, parseFeed } from "./telemetry.types";

// These tests inspect the actual Drizzle driver queries; they do not emulate
// PostgreSQL constraints or claim that a migration has been applied.
function fixture() {
  const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [] as unknown[] }));
  const db = drizzle({ query } as unknown as Client) as Database;
  return { store: new TelemetryStore(db), query };
}
const isTypeUpsert = (text: string) => text.includes("INSERT INTO game_feed_event_types");
/** The bound key list of one long-shot test (labelled firearms only), in parameter order. */
const LONG_SHOT_KEYS = [FIREARM_ITEM_KEYS];
/**
 * The long-shot test on `column`, with its key list at $param: the item code (after Id.Item., or a whole
 * bare code) is a labelled firearm or a WEPN_ code, as in describeCause(). Nothing else counts.
 */
const longShotSql = (column: string, param: number) => {
  const cause = `lower(btrim(${column}))`;
  const code = `(CASE WHEN ${cause} LIKE 'id.item.%' THEN substr(${cause}, 9) WHEN ${cause} !~ '[./\\\\]' THEN ${cause} END)`;
  return `(regexp_replace(${code}, '[^a-z0-9]', '', 'g') = ANY($${param}::text[]) OR ${code} ~ '^wepn_?[0-9]{1,4}$')`;
};
/**
 * The plausible-shot test on the `alias` row: above zero, at most 1,200 m, and not tagged as a vehicle
 * explosion, roadkill or fall in any stored spelling. Binds no parameter.
 */
const plausibleShotSql = (alias = "") => {
  const p = alias ? `${alias}.` : "";
  const prefixes = ["", "Meta.Progression.Context.Player.KillContext.", "Meta.PlayerKillFlag.Player."];
  const tags = ["VehicleExplosion", "RoadKill", "Falling"].flatMap((tag) => prefixes.map((x) => `'${x}${tag}'`));
  return `${p}distance_centimeters > 0 AND ${p}distance_centimeters <= 120000 AND NOT (${p}context_tags ?| ARRAY[${tags.join(",")}])`;
};
const oneLine = (text: string) => text.replace(/\s+/g, " ");
const serverInstance = randomUUID();
const killed = () => ({ eventId: randomUUID(), type: "killed", eventTime: 3 });
const feed = (events: unknown[]) => parseFeed({ serverId: serverInstance, serverName: "The UNCs", events });
describe("telemetry persistence contract", () => {
  it("keeps one bounded row per server, event type and UTC day with a purge index", () => {
    const schema = getTableConfig(gameFeedEventTypes);
    expect(schema.name).toBe("game_feed_event_types");
    expect(schema.primaryKeys[0].columns.map((column) => column.name)).toEqual(["server_id", "type", "day"]);
    expect(schema.indexes.map((index) => index.config.name)).toEqual(["game_feed_event_types_day_idx"]);
    expect(schema.columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
      ["server_id", "text", true],
      ["type", "varchar(64)", true],
      ["day", "date", true],
      ["count", "bigint", true],
      ["first_received_at", "timestamp with time zone", true],
      ["last_received_at", "timestamp with time zone", true],
      ["sample", "jsonb", false],
    ]);
  });
  it("has durable instance+event identity and receipt/player lookup indexes", () => {
    const schema = getTableConfig(combatEvents);
    expect(schema.primaryKeys[0].columns.map((column) => column.name)).toEqual([
      "server_id",
      "server_instance_id",
      "event_id",
    ]);
    expect(schema.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "combat_events_received_idx",
        "combat_events_killer_received_idx",
        "combat_events_victim_received_idx",
      ]),
    );
    expect(schema.columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(["email", "discord_id"]));
  });
  it("lets the unique constraint deduplicate events and reports inserted versus duplicate rows", async () => {
    const { store, query } = fixture();
    const eventId = randomUUID();
    const batch = parseFeed({
      serverId: randomUUID(),
      serverName: "The UNCs",
      events: [
        { eventId, type: "killed", eventTime: 3 },
        { eventId, type: "killed", eventTime: 3 },
      ],
    });
    query.mockImplementation(async (config) => ({
      rows: config.text.startsWith('insert into "combat_events"')
        ? [[eventId]]
        : isTypeUpsert(config.text)
          ? [{ type: "killed" }]
          : [],
    }));
    const result = await store.ingest(batch, new Date("2026-09-30T12:00:00Z"));
    expect(result).toEqual({ inserted: 1, duplicates: 1, skipped: 0, typesOverLimit: 0 });
    const [config, values] = query.mock.calls.find(([config]) =>
      config.text.startsWith('insert into "combat_events"'),
    )!;
    expect(config.text).toContain('on conflict ("server_id","server_instance_id","event_id") do nothing');
    expect(values).toContain(batch.serverId);
    expect(values).toContain(eventId);
    expect(query.mock.calls[0][0].text).toBe("begin");
    expect(query.mock.calls.at(-1)![0].text).toBe("commit");
    expect(query.mock.calls.some(([config]) => config.text.startsWith("delete"))).toBe(false);
  });
  it("claims retention cleanup at most daily and only deletes records older than 90 days", async () => {
    const { store, query } = fixture();
    const now = new Date("2026-09-30T12:00:00Z");
    query.mockImplementation(async (config) => ({
      rows: config.text.startsWith('update "combat_tracking"') ? [["uncs"]] : [],
    }));
    await store.ingest(parseFeed({ serverId: randomUUID(), serverName: "The UNCs", events: [] }), now);
    const [claim, claimParams] = query.mock.calls.find(([config]) => config.text.startsWith("update"))!;
    expect(claim.text).toContain('"combat_tracking"."last_cleanup_at" is null');
    expect(claim.text).toContain('"combat_tracking"."last_cleanup_at" <');
    expect(claimParams).toContain(new Date(now.getTime() - 86_400_000).toISOString());
    const [remove, removeParams] = query.mock.calls.find(([config]) => config.text.startsWith("delete"))!;
    expect(remove.text).toContain('"combat_events"."received_at" <');
    expect(removeParams).toContain(new Date(now.getTime() - 90 * 86_400_000).toISOString());
    // The same daily claim purges event type counts for whole UTC days before the 90-day cutoff.
    const [purge, purgeParams] = query.mock.calls.find(([config]) =>
      config.text.startsWith('delete from "game_feed_event_types"'),
    )!;
    expect(purge.text).toContain('"game_feed_event_types"."server_id" = $1');
    expect(purge.text).toContain('"game_feed_event_types"."day" < $2');
    expect(purgeParams).toEqual(["primary", "2026-07-02"]);
  });
  it("purges nothing when the daily cleanup was already claimed", async () => {
    const { store, query } = fixture();
    await store.ingest(feed([killed(), { type: "spawn" }]), new Date("2026-09-30T12:00:00Z"));
    expect(query.mock.calls.some(([config]) => config.text.startsWith("delete"))).toBe(false);
  });
  it("adds every type in a batch with one upsert after the tracking row lock, never one query per event", async () => {
    const { store, query } = fixture();
    const now = new Date("2026-09-30T23:59:59.999Z");
    const events = [
      ...Array.from({ length: 150 }, killed),
      ...Array.from({ length: 40 }, (_, index) => ({ type: "spawn", index })),
      ...Array.from({ length: 10 }, (_, index) => ({ type: "Round.Result", index })),
    ];
    query.mockImplementation(async (config) => ({
      rows: isTypeUpsert(config.text) ? [{ type: "killed" }, { type: "spawn" }, { type: "Round.Result" }] : [],
    }));
    await expect(store.ingest(feed(events), now, "east")).resolves.toMatchObject({ typesOverLimit: 0 });
    const texts = query.mock.calls.map(([config]) => config.text);
    expect(texts.filter(isTypeUpsert)).toHaveLength(1);
    // Six statements in all for 200 events: begin, events, tracking, types, cleanup claim, commit.
    expect(texts).toHaveLength(6);
    const tracking = texts.findIndex((text) => text.startsWith('insert into "combat_tracking"'));
    const upsert = texts.findIndex(isTypeUpsert);
    expect(tracking).toBeGreaterThan(0);
    expect(upsert).toBeGreaterThan(tracking);
    expect(texts.at(-1)).toBe("commit");
    const [config, params] = query.mock.calls[upsert];
    expect(config.text).toContain("ON CONFLICT (server_id, type, day) DO UPDATE SET");
    expect(config.text).toContain("count = stored.count + excluded.count");
    expect(config.text).toContain("last_received_at = greatest(stored.last_received_at, excluded.last_received_at)");
    // One VALUES row per type: name, count, sample (null for killed) and batch order.
    expect(params.slice(0, 12)).toEqual([
      "killed",
      150,
      null,
      0,
      "spawn",
      40,
      JSON.stringify({ type: "spawn", index: 39 }),
      1,
      "Round.Result",
      10,
      JSON.stringify({ type: "Round.Result", index: 9 }),
      2,
    ]);
    // Counted on the server's configured key and the UTC receipt day, never the payload's instance ID.
    expect(params).toEqual(expect.arrayContaining(["east", "2026-09-30", now]));
    expect(params).not.toContain(serverInstance);
  });
  it("keeps a stored sample over a size marker and keeps killed samples empty", async () => {
    const { store, query } = fixture();
    const big = { type: "bulk", padding: "x".repeat(MAX_SAMPLE_BYTES) };
    await store.ingest(feed([big, killed()]), new Date("2026-09-30T12:00:00Z"));
    const [config, params] = query.mock.calls.find(([config]) => isTypeUpsert(config.text))!;
    const bytes = Buffer.byteLength(JSON.stringify(big));
    expect(params.slice(0, 8)).toEqual(["bulk", 1, JSON.stringify({ tooLarge: true, bytes }), 0, "killed", 1, null, 1]);
    expect(JSON.stringify(params)).not.toContain("xxxx");
    // A newer real sample replaces the stored one; a marker (no "type" key) or null keeps it.
    expect(config.text).toContain("WHEN excluded.sample IS NULL THEN stored.sample");
    expect(config.text).toContain("WHEN excluded.sample ? 'type' THEN excluded.sample");
    expect(config.text).toContain("ELSE coalesce(stored.sample, excluded.sample)");
  });
  it("caps new types per server and UTC day, killed aside, and reports the types left out", async () => {
    const { store, query } = fixture();
    const events = [killed(), ...["a", "b", "c", "d"].map((type) => ({ type }))];
    // The database recorded killed and two of the four new types; two were over the limit.
    query.mockImplementation(async (config) => ({
      rows: isTypeUpsert(config.text) ? [{ type: "killed" }, { type: "a" }, { type: "b" }] : [],
    }));
    const result = await store.ingest(feed(events), new Date("2026-09-30T12:00:00Z"));
    expect(result).toEqual({ inserted: 0, duplicates: 1, skipped: 4, typesOverLimit: 2 });
    const [config, params] = query.mock.calls.find(([config]) => isTypeUpsert(config.text))!;
    expect(MAX_FEED_TYPES_PER_DAY).toBe(200);
    expect(config.text).toContain("WHERE type <> 'killed' AND type NOT IN (SELECT type FROM today)");
    expect(config.text).toMatch(/WHERE rank <= \$\d+ - \(SELECT count\(\*\) FROM today WHERE type <> 'killed'\)/);
    expect(config.text).toContain("row_number() OVER (ORDER BY ord)");
    expect(params).toContain(MAX_FEED_TYPES_PER_DAY);
  });
  it("skips the type upsert for a batch with no valid entries", async () => {
    const { store, query } = fixture();
    await store.ingest(feed([]), new Date());
    expect(query.mock.calls.some(([config]) => isTypeUpsert(config.text))).toBe(false);
  });
  it("rolls back the killed events and tracking when the type counts fail", async () => {
    const { store, query } = fixture();
    query.mockImplementation(async (config) => {
      if (isTypeUpsert(config.text)) throw new Error("database error");
      return { rows: [] };
    });
    await expect(store.ingest(feed([killed(), { type: "spawn" }]), new Date())).rejects.toThrow();
    const texts = query.mock.calls.map(([config]) => config.text);
    expect(texts.some((text) => text.startsWith('insert into "combat_events"'))).toBe(true);
    expect(texts.at(-1)).toBe("rollback");
    expect(texts).not.toContain("commit");
  });
  it("reads staff event type totals over whole UTC days with one read-only statement", async () => {
    const { store, query } = fixture();
    const first = new Date("2026-09-29T01:00:00Z"),
      last = new Date("2026-09-30T11:00:00Z");
    query.mockResolvedValueOnce({
      rows: [
        { type: "spawn", count: "12", firstReceivedAt: first, lastReceivedAt: last, sample: { type: "spawn" } },
        { type: "killed", count: 3, firstReceivedAt: first.toISOString(), lastReceivedAt: last, sample: null },
      ],
    });
    const since = new Date("2026-09-29T12:00:00Z"),
      until = new Date("2026-09-30T12:00:00Z");
    await expect(store.eventTypes(since, until, "east")).resolves.toEqual([
      { type: "spawn", count: 12, firstReceivedAt: first, lastReceivedAt: last, sample: { type: "spawn" } },
      { type: "killed", count: 3, firstReceivedAt: first, lastReceivedAt: last, sample: null },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [config, params] = query.mock.calls[0];
    expect(config.text).toContain("server_id = $1 AND day >= $2::date AND day <= $3::date");
    expect(params).toEqual(["east", "2026-09-29", "2026-09-30", MAX_FEED_TYPES_PER_DAY + 1]);
    expect(config.text).toContain("DISTINCT ON (type) type, sample FROM scoped WHERE sample IS NOT NULL");
    expect(config.text).not.toMatch(/\b(insert|update|delete)\b/i);
  });
  it("rolls back event and tracking writes if persistence fails", async () => {
    const { store, query } = fixture();
    query.mockImplementation(async (config) => {
      if (config.text.startsWith('insert into "combat_tracking"')) throw new Error("database error");
      return { rows: [] };
    });
    await expect(
      store.ingest(parseFeed({ serverId: randomUUID(), serverName: "The UNCs", events: [] }), new Date()),
    ).rejects.toThrow();
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
    expect(query.mock.calls.some(([config]) => config.text === "commit")).toBe(false);
  });
  it("aggregates bounded receipt windows in SQL, excludes suicide credit and binds player values", async () => {
    const { store, query } = fixture();
    const since = new Date("2026-09-29T12:00:00Z"),
      until = new Date("2026-09-30T12:00:00Z");
    const playerId = "76561198000000001";
    await store.snapshot(since, until, playerId);
    const [config, params] = query.mock.calls[0];
    expect(config.text).toContain("server_id = $1 AND received_at >= $2 AND received_at <= $3");
    expect(params.slice(0, 3)).toEqual(["primary", since, until]);
    expect(config.text).toContain("CASE WHEN NOT suicide THEN 1 ELSE 0 END");
    expect(config.text).toContain("CASE WHEN NOT suicide AND headshot THEN 1 ELSE 0 END");
    expect(config.text).toContain("FROM scoped WHERE victim_steam_id IS NOT NULL");
    expect(config.text).toContain("WHERE steam_id = $6");
    expect(config.text).toContain("LIMIT 100");
    expect(config.text).not.toContain(playerId);
    expect(params.slice(3)).toEqual([playerId, playerId, playerId]);
  });
  it("reads weekly highlights over the same bounds as snapshot with one read-only statement", async () => {
    const { store, query } = fixture();
    const since = new Date("2026-09-28T00:00:00Z"),
      until = new Date("2026-10-04T23:59:59.999Z");
    await expect(store.weeklyHighlights(since, until, "east")).resolves.toEqual({
      bestKd: null,
      mostHeadshots: null,
      longestKill: null,
      kills: 0,
      killsWithCause: 0,
      topCause: null,
      maps: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [config, params] = query.mock.calls[0];
    expect(config.text.trim()).toMatch(/^WITH scoped AS/);
    expect(config.text).toContain("server_id = $1 AND received_at >= $2 AND received_at <= $3");
    expect(params).toEqual(["east", since, until, 10, ...LONG_SHOT_KEYS]);
    // A kill is a non-suicide event with a linked killer, as in snapshot().
    expect(config.text).toContain("SELECT * FROM scoped WHERE NOT suicide AND killer_steam_id IS NOT NULL");
    expect(config.text).toContain("ORDER BY steam_id, received_at DESC, event_id DESC");
    expect(config.text).toContain("WHERE kills >= $4");
    expect(config.text).toContain("ORDER BY kills::numeric / greatest(deaths, 1) DESC, kills DESC, steam_id LIMIT 1");
    expect(config.text).toContain(
      "ORDER BY kills.distance_centimeters DESC, kills.received_at, kills.event_time, kills.event_id LIMIT 1",
    );
    // Long-distance call: plausible firearm shots only, so artillery, rocket pods and impossible
    // distances never take it.
    expect(oneLine(config.text)).toContain(
      `WHERE ${plausibleShotSql("kills")} AND ${longShotSql("kills.cause", 5)} ORDER BY`,
    );
    expect(config.text).toContain("LIMIT 50");
    // "Id.Item.AK74M" and "ID.Item.AK74M" are one weapon, so Old faithful counts them together.
    expect(config.text).toContain("GROUP BY lower(btrim(cause)) ORDER BY count(*) DESC, lower(btrim(cause)) LIMIT 1");
    expect(config.text).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(config.text).not.toMatch(/email|discord/i);
    await store.weeklyHighlights(since, until, "east", 25);
    expect(query.mock.calls[1][1]).toEqual(["east", since, until, 25, ...LONG_SHOT_KEYS]);
  });
  it("bounds individual history and converts centimetres without altering game timestamps", async () => {
    const { store, query } = fixture();
    await store.events(new Date("2026-09-29T00:00:00Z"), new Date("2026-09-30T00:00:00Z"), "76561198000000001");
    const [config, params] = query.mock.calls[0];
    expect(config.text).toContain('"distance_centimeters" / 100.0');
    expect(config.text).toContain('"event_time"');
    expect(config.text).toContain('"killer_steam_id" =');
    expect(config.text).toContain('"victim_steam_id" =');
    expect(config.text).toContain("limit $");
    expect(params.at(-1)).toBe(100);
    expect(config.text).not.toMatch(/email|discord|to_timestamp/);
  });
  const statements = (query: ReturnType<typeof fixture>["query"]) =>
    query.mock.calls.filter(([config]) => !/^(begin|commit|rollback)\b/.test(config.text));
  it("reads server stats in three range scans inside one read-only, repeatable-read transaction", async () => {
    const { store, query } = fixture();
    const since = new Date("2026-09-06T02:00:00Z"),
      until = new Date("2026-10-06T02:00:00Z");
    query.mockImplementation(async (config) => ({
      rows: config.text.includes("GROUPING SETS")
        ? [{ set: 7, kills: 3 }]
        : config.text.includes("CROSS JOIN LATERAL (VALUES (1,")
          ? [{ events: 4, deaths: 4, suicides: 1, falling: 0, players: 3 }]
          : config.text.includes("WITH best AS")
            ? [{ longest: [{ steamId: "76561198000000001" }], leaders: [] }]
            : [],
    }));
    await expect(store.serverStats(since, until, "east")).resolves.toEqual({
      groups: [{ set: 7, kills: 3 }],
      totals: { events: 4, deaths: 4, suicides: 1, falling: 0, players: 3 },
      longest: [{ steamId: "76561198000000001" }],
      leaders: [],
    });
    expect(query.mock.calls[0][0].text).toBe("begin isolation level repeatable read read only");
    expect(query.mock.calls.at(-1)![0].text).toBe("commit");
    const [s1, s2, s3] = statements(query);
    expect(statements(query)).toHaveLength(3);
    for (const [config, params] of [s1, s2, s3]) {
      // Every scan uses the leading columns of combat_events_received_idx, bound once per statement.
      expect(params.slice(0, 3)).toEqual(["east", since, until]);
      expect(config.text).toMatch(/server_id = \$1 AND (e\.)?received_at >= \$2 AND (e\.)?received_at <= \$3/);
      expect(config.text).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(config.text).not.toMatch(/email|discord|MATERIALIZED/i);
    }
    // Only S3's long shots bind more: the firearm key list, once for the ranking and once for the kill row.
    for (const [config, params] of [s1, s2]) {
      expect(params).toHaveLength(3);
      expect(config.text).not.toMatch(/\$4/);
    }
    expect(s3[1].slice(3)).toEqual([...LONG_SHOT_KEYS, ...LONG_SHOT_KEYS]);
    // S1: kills by cause, map and hour plus the total, in one scan. The per-weapon longest keeps every kind.
    expect(s1[0].text).toContain("GROUP BY GROUPING SETS ((cause_key), (map_name), (hour), ())");
    expect(s1[0].text).toContain("NOT suicide AND killer_steam_id IS NOT NULL");
    expect(s1[0].text).toContain("extract(hour FROM received_at AT TIME ZONE 'UTC')");
    expect(s1[0].text).toContain("distance_centimeters <= 200000");
    // A firearm's longest kill reads the plausible-shot maximum; the service picks it by kind.
    expect(oneLine(s1[0].text)).toContain(
      `max(distance_centimeters) FILTER (WHERE ${plausibleShotSql()}) AS "longestShotCentimeters"`,
    );
    expect(s1[0].text).not.toContain("id.item.");
    expect(s1[0].text).toContain(
      "?| ARRAY['Penetration','Meta.Progression.Context.Player.KillContext.Penetration','Meta.PlayerKillFlag.Player.Penetration']",
    );
    // S2: event totals, with the e. alias. Players are counted from a hashable GROUP BY, never a
    // count(DISTINCT) that sorts two rows per event.
    expect(s2[0].text).toContain("e.server_id = $1 AND e.received_at >= $2 AND e.received_at <= $3");
    expect(s2[0].text).toContain("GROUP BY v.id");
    expect(s2[0].text).toContain("count(id)::int AS players");
    expect(s2[0].text).not.toMatch(/count\(DISTINCT/i);
    expect(s2[0].text).toContain(
      "e.context_tags ?| ARRAY['Falling','Meta.Progression.Context.Player.KillContext.Falling','Meta.PlayerKillFlag.Player.Falling']",
    );
    // S3: the ten players with the longest capped kills, ranked by each player's own best shot (no
    // top-N prefilter a few snipers could fill), five leaders per tag, ten rows out.
    const cte = (name: string, next: string) => {
      const text = s3[0].text;
      const start = text.indexOf(`${name} AS (`);
      expect(start).toBeGreaterThanOrEqual(0);
      return text.slice(start, text.indexOf(`), ${next} AS (`, start));
    };
    const best = cte("best", "longest");
    expect(best).toContain("NOT suicide AND killer_steam_id IS NOT NULL");
    expect(oneLine(best)).toContain(`${plausibleShotSql()} AND ${longShotSql("cause", 4)} GROUP BY`);
    expect(best).toContain("GROUP BY killer_steam_id");
    // Capped at ten before any name is looked up.
    expect(best).toContain("ORDER BY cm DESC, killer_steam_id LIMIT 10");
    const longest = cte("longest", "tagged");
    expect(longest).toContain("FROM best CROSS JOIN LATERAL (");
    expect(longest).toContain(
      "c.server_id = $1 AND c.received_at >= $2 AND c.received_at <= $3 AND c.killer_steam_id = best.steam_id",
    );
    // The kill row is a long shot too, so a vehicle kill at the same centimetre cannot be shown instead.
    expect(oneLine(longest)).toContain(
      `c.distance_centimeters = best.cm AND ${plausibleShotSql("c")} AND ${longShotSql("c.cause", 5)} ORDER BY`,
    );
    expect(longest).toContain("ORDER BY c.received_at, c.event_id LIMIT 1");
    expect(s3[0].text).not.toContain("LIMIT 200");
    expect(s3[0].text).not.toContain("DISTINCT ON");
    expect(s3[0].text).toContain("row_number() OVER (PARTITION BY tag ORDER BY count(*) DESC, steam_id)");
    expect(s3[0].text).toContain("rank <= 5");
    expect(s3[0].text).toContain("e.server_id = $1 AND e.received_at >= $2 AND e.received_at <= $3");
    // Names: one latest-name probe per listed player on the killer and victim indexes, never every
    // event those players have in the window.
    const names = s3[0].text.slice(s3[0].text.indexOf("names AS ("));
    expect(names).toMatch(/FROM named\s+LEFT JOIN LATERAL \(/);
    for (const role of ["killer", "victim"])
      expect(names).toContain(
        `c.server_id = $1 AND c.received_at >= $2 AND c.received_at <= $3 AND c.${role}_steam_id = named.steam_id`,
      );
    expect(names.match(/ORDER BY c\.received_at DESC, c\.event_id DESC LIMIT 1\)/g)).toHaveLength(2);
    expect(names).toMatch(/ORDER BY received_at DESC, event_id DESC LIMIT 1\s+\) latest ON true/);
    expect(s3[0].text).not.toContain("IN (SELECT steam_id FROM named)");
    // Self-inflicted deaths are counted in S2 but never ranked by name.
    expect(s3[0].text).not.toContain("'suicide'");
    expect(s3[0].text).toContain("('falling', e.victim_steam_id,");
  });
  it("rolls back a failed stats read and returns empty lists when nothing matched", async () => {
    const { store, query } = fixture();
    await expect(store.serverStats(new Date(0), new Date(1))).resolves.toEqual({
      groups: [],
      totals: { events: 0, deaths: 0, suicides: 0, falling: 0, players: 0 },
      longest: [],
      leaders: [],
    });
    expect(statements(query).map(([, params]) => params[0])).toEqual(["primary", "primary", "primary"]);
    query.mockImplementation(async (config) => {
      if (config.text.includes("WITH best AS")) throw new Error("database error");
      return { rows: [] };
    });
    await expect(store.serverStats(new Date(0), new Date(1))).rejects.toThrow();
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
  });
  it("reads row extras only for listed public SteamIDs, bound as an explicit list, read-only", async () => {
    const { store, query } = fixture();
    const since = new Date("2026-09-29T00:00:00Z"),
      until = new Date("2026-10-06T00:00:00Z");
    await expect(store.rowExtras(since, until, [], "east")).resolves.toEqual({ weapons: [], streaks: [] });
    await expect(store.rowExtras(since, until, ["123", "x' OR 1=1 --", "76561197960265728"])).resolves.toEqual({
      weapons: [],
      streaks: [],
    });
    expect(query).not.toHaveBeenCalled();
    const ids = ["76561198000000001", "76561198000000002", "76561198000000001", "not-an-id"];
    await store.rowExtras(since, until, ids, "east");
    expect(query.mock.calls[0][0].text).toBe("begin isolation level repeatable read read only");
    expect(query.mock.calls.at(-1)![0].text).toBe("commit");
    const [weapons, streaks] = statements(query);
    expect(statements(query)).toHaveLength(2);
    expect(weapons[1]).toEqual(["east", since, until, "76561198000000001", "76561198000000002", ...LONG_SHOT_KEYS]);
    expect(weapons[0].text).toContain(
      "server_id = $1 AND received_at >= $2 AND received_at <= $3 AND NOT suicide AND killer_steam_id IN ($4, $5)",
    );
    expect(weapons[0].text).toContain("GROUP BY killer_steam_id, lower(btrim(cause))");
    expect(oneLine(weapons[0].text)).toContain(
      `max(distance_centimeters) FILTER (WHERE ${plausibleShotSql()}) AS longest`,
    );
    // longestKillMeters counts plausible firearm shots only; the cause test runs once per player and cause.
    expect(oneLine(weapons[0].text)).toContain(
      `CASE WHEN ${longShotSql("cause", 6)} THEN longest END AS "longestCentimeters" FROM causes`,
    );
    expect(streaks[1]).toEqual([
      "east",
      since,
      until,
      "76561198000000001",
      "76561198000000002",
      "76561198000000001",
      "76561198000000002",
    ]);
    expect(streaks[0].text).toContain("PARTITION BY steam_id, server_instance_id");
    expect(streaks[0].text).toContain("ORDER BY received_at, event_time, is_kill DESC, event_id");
    expect(streaks[0].text).toContain("killer_steam_id IN ($4, $5)");
    expect(streaks[0].text).toContain(
      "server_id = $1 AND received_at >= $2 AND received_at <= $3 AND victim_steam_id IN ($6, $7)",
    );
    for (const [config] of [weapons, streaks]) {
      expect(config.text).not.toContain("76561198");
      expect(config.text).not.toMatch(/\b(insert|update|delete)\b/i);
    }
    // At most the leaderboard's 100 players.
    query.mockClear();
    const many = Array.from({ length: 150 }, (_, index) => String(76561198000000000n + BigInt(index + 1)));
    await store.rowExtras(since, until, many, "east");
    expect(statements(query)[0][1]).toHaveLength(3 + 100 + LONG_SHOT_KEYS.length);
  });
});
