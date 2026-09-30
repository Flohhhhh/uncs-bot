import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { AdminStore } from "./admin.store";

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
    expect(lookup.text).toContain('where "admin_actions"."id" = $1');
    expect(params).toEqual([id, 1]);
    expect(lookup.text).not.toMatch(/actor_id|request_hash|order by|created_at.*[<>]/);
    expect(record).not.toHaveProperty("actorId");
    expect(record).not.toHaveProperty("requestHash");
    expect(query.mock.calls.every(([config]) => config.text.startsWith("select "))).toBe(true);
  });
  it("returns null when no stored receipt exists", async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const store = new AdminStore(drizzle({ query } as unknown as Client) as Database);
    await expect(store.receipt(randomUUID())).resolves.toBeNull();
  });
});
