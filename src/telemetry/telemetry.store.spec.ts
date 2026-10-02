import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { combatEvents } from "../database/telemetry.schema";
import { TelemetryStore } from "./telemetry.store";
import { parseFeed } from "./telemetry.types";

// These tests inspect the actual Drizzle driver queries; they do not emulate
// PostgreSQL constraints or claim that a migration has been applied.
function fixture() {
  const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [] as unknown[] }));
  const db = drizzle({ query } as unknown as Client) as Database;
  return { store: new TelemetryStore(db), query };
}
describe("telemetry persistence contract", () => {
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
      rows: config.text.startsWith('insert into "combat_events"') ? [[eventId]] : [],
    }));
    const result = await store.ingest(batch, new Date("2026-09-30T12:00:00Z"));
    expect(result).toEqual({ inserted: 1, duplicates: 1, skipped: 0 });
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
    expect(params).toEqual(["east", since, until, 10]);
    // A kill is a non-suicide event with a linked killer, as in snapshot().
    expect(config.text).toContain("SELECT * FROM scoped WHERE NOT suicide AND killer_steam_id IS NOT NULL");
    expect(config.text).toContain("ORDER BY steam_id, received_at DESC, event_id DESC");
    expect(config.text).toContain("WHERE kills >= $4");
    expect(config.text).toContain("ORDER BY kills::numeric / greatest(deaths, 1) DESC, kills DESC, steam_id LIMIT 1");
    expect(config.text).toContain(
      "ORDER BY kills.distance_centimeters DESC, kills.received_at, kills.event_time, kills.event_id LIMIT 1",
    );
    expect(config.text).toContain("LIMIT 50");
    expect(config.text).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(config.text).not.toMatch(/email|discord/i);
    await store.weeklyHighlights(since, until, "east", 25);
    expect(query.mock.calls[1][1]).toEqual(["east", since, until, 25]);
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
});
