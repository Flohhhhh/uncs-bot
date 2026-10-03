import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { AdminStore, COMMUNITY_MESSAGES_ACTOR_ID } from "./admin.store";

describe("stored action receipt lookup", () => {
  it("reads directly by bound UUID with exactly the recent-history projection", async () => {
    const id = randomUUID();
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [] as unknown[][] }));
    const store = new AdminStore(drizzle({ query } as unknown as Client) as Database);
    await store.history();
    query.mockResolvedValueOnce({
      rows: [
        [
          id,
          "Staff",
          "kick",
          "76561198000000001",
          { reason: "Resolved connection" },
          "unknown",
          "Check the game",
          "2026-08-01T00:00:00Z",
        ],
      ],
    });
    const record = await store.receipt(id);
    expect(record).toMatchObject({
      id,
      actorName: "Staff",
      state: "unknown",
      details: { reason: "Resolved connection" },
    });
    const [history] = query.mock.calls[0];
    const [lookup, params] = query.mock.calls[1];
    expect(lookup.text.split(" from ")[0]).toBe(history.text.split(" from ")[0]);
    expect(lookup.text).toContain('"admin_actions"."id" = $1');
    expect(lookup.text).toContain("->>'serverId'");
    expect(params).toEqual([id, "primary", "primary", 1]);
    expect(lookup.text).not.toMatch(/actor_id|request_hash|order by/);
    expect(lookup.text.split(" where ")[1]).not.toContain("created_at");
    expect(record).not.toHaveProperty("actorId");
    expect(record).not.toHaveProperty("requestHash");
    expect(query.mock.calls.every(([config]) => config.text.startsWith("select "))).toBe(true);
  });
  it("excludes only acknowledged automatic messages, inside the query before its row limit", async () => {
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [] as unknown[][] }));
    const store = new AdminStore(drizzle({ query } as unknown as Client) as Database);
    await store.history("east");
    await store.history("east", { notable: true });
    const [[all, allParams], [notable, params]] = query.mock.calls;
    expect(notable.text.split(" from ")[0]).toBe(all.text.split(" from ")[0]);
    expect(allParams).toEqual(["primary", "east", 100]);
    expect(params).toEqual([
      "primary",
      "east",
      COMMUNITY_MESSAGES_ACTOR_ID,
      "message",
      "broadcast",
      "accepted",
      "applied",
      100,
    ]);
    expect(notable.text.split(" where ")[1].split(" order by ")[0]).toContain(
      'not ("admin_actions"."actor_id" = $3 and "admin_actions"."action" in ($4, $5) and "admin_actions"."state" in ($6, $7))',
    );
  });
  it("finds a person's map queue for the server since a time, ignoring Gramps and refused queues", async () => {
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [] as unknown[][] }));
    const store = new AdminStore(drizzle({ query } as unknown as Client) as Database);
    const since = new Date("2026-10-03T12:00:00Z");
    await expect(store.staffQueuedSince("east", since)).resolves.toBe(false);
    query.mockResolvedValueOnce({ rows: [[randomUUID()]] });
    await expect(store.staffQueuedSince("east", since)).resolves.toBe(true);
    const [lookup, params] = query.mock.calls[0];
    expect(lookup.text.startsWith("select ")).toBe(true);
    expect(lookup.text.split(" where ")[1]).toBe(
      `("admin_actions"."action" = $1 and coalesce("admin_actions"."details"->>'serverId', $2) = $3 and "admin_actions"."created_at" >= $4 and not "admin_actions"."actor_id" like $5 and "admin_actions"."state" <> $6) limit $7`,
    );
    expect(params).toEqual(["map-next", "primary", "east", since.toISOString(), "system:%", "failed", 1]);
  });
  it("returns null when no stored receipt exists", async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const store = new AdminStore(drizzle({ query } as unknown as Client) as Database);
    await expect(store.receipt(randomUUID())).resolves.toBeNull();
  });
});
