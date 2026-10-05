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

describe("kick and ban records", () => {
  const players = ["76561198000000001", "76561198000000002"];
  function storeWith(rows: unknown[][] = []) {
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows }));
    return { query, store: new AdminStore(drizzle({ query } as unknown as Client) as Database) };
  }
  const where = (text: string) => text.split(" where ")[1].split(" group by ")[0];

  it("keeps the player's roster name with a kick or ban record, and leaves other records unchanged", async () => {
    const { query, store } = storeWith([[randomUUID()]]);
    const staff = { id: "123456789012345678", name: "Mod", role: "moderator" as const, csrf: "csrf" };
    const kick = { id: randomUUID(), action: "kick" as const, steamId: players[0], reason: "Team killing" };
    await store.begin(staff, kick, "hash", "Griefer");
    await store.begin(staff, { ...kick, id: randomUUID() }, "hash");
    const [[named, namedParams], [plain, plainParams]] = query.mock.calls;
    expect(named.text.startsWith('insert into "admin_actions"')).toBe(true);
    expect(namedParams).toContain(JSON.stringify({ ...kick, playerName: "Griefer" }));
    expect(plain.text).toBe(named.text);
    expect(plainParams.some((value) => typeof value === "string" && value.includes("playerName"))).toBe(false);
  });

  it("counts each player's kicks and bans the game applied or accepted, for a whole list in one query", async () => {
    const since = new Date("2026-09-05T00:00:00Z");
    const { query, store } = storeWith([
      [players[0], "kick", "4", "3", "2026-10-02 18:00:00+00", "Mod", "Team killing", "Griefer"],
      [players[0], "ban", "1", "1", "2026-10-01 18:00:00+00", "Admin", "Cheating", "Old name"],
      [players[1], "kick", "1", "0", "2026-08-01 18:00:00+00", "Mod", null, null],
    ]);
    const summaries = await store.moderationSummaries("east", players, since);
    expect(query).toHaveBeenCalledTimes(1);
    const [lookup, params] = query.mock.calls[0];
    expect(lookup.text.startsWith("select ")).toBe(true);
    expect(where(lookup.text)).toBe(
      `(coalesce("admin_actions"."details"->>'serverId', $2) = $3 and "admin_actions"."target" in ($4, $5) and ("admin_actions"."action" in ($6, $7) and "admin_actions"."state" in ($8, $9)))`,
    );
    expect(lookup.text).toContain(`count(*) filter (where "admin_actions"."created_at" >= $1)`);
    expect(lookup.text).toContain(`group by "admin_actions"."target", "admin_actions"."action"`);
    expect(params).toEqual([since.toISOString(), "primary", "east", ...players, "kick", "ban", "applied", "accepted"]);
    expect(summaries.get(players[0])).toEqual({
      name: "Griefer",
      kicks: {
        count: 4,
        recent: 3,
        lastAt: new Date("2026-10-02T18:00:00Z"),
        lastBy: "Mod",
        lastReason: "Team killing",
      },
      bans: { count: 1, recent: 1, lastAt: new Date("2026-10-01T18:00:00Z"), lastBy: "Admin", lastReason: "Cheating" },
    });
    expect(summaries.get(players[1])).toMatchObject({ name: null, kicks: { count: 1, recent: 0 }, bans: null });
  });

  it("reads nothing for an empty list", async () => {
    const { query, store } = storeWith();
    await expect(store.moderationSummaries("east", [])).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("lists one player's newest kicks and bans, unconfirmed ones included and refused ones left out", async () => {
    const { query, store } = storeWith();
    await store.history("east");
    await store.moderationEntries("east", players[0]);
    const [[history], [lookup, params]] = query.mock.calls;
    expect(lookup.text.split(" from ")[0]).toBe(history.text.split(" from ")[0]);
    expect(lookup.text.split(" where ")[1]).toBe(
      `(coalesce("admin_actions"."details"->>'serverId', $1) = $2 and "admin_actions"."target" = $3 and ("admin_actions"."action" in ($4, $5) and "admin_actions"."state" <> $6)) order by "admin_actions"."created_at" desc limit $7`,
    );
    expect(params).toEqual(["primary", "east", players[0], "kick", "ban", "failed", 10]);
  });

  it("lists players kicked at least the minimum since a date, most kicks first", async () => {
    const since = new Date("2026-09-05T00:00:00Z");
    const { query, store } = storeWith([
      [players[0], "kick", "3", "3", "2026-10-02 18:00:00+00", "Mod", "Team killing", "Griefer"],
    ]);
    await expect(store.repeatOffenders("east", since, 2)).resolves.toEqual([
      {
        steamId: players[0],
        name: "Griefer",
        kicks: {
          count: 3,
          recent: 3,
          lastAt: new Date("2026-10-02T18:00:00Z"),
          lastBy: "Mod",
          lastReason: "Team killing",
        },
      },
    ]);
    const [lookup, params] = query.mock.calls[0];
    expect(where(lookup.text)).toContain(`"admin_actions"."action" = $`);
    expect(where(lookup.text)).toContain(`"admin_actions"."state" in ($`);
    expect(where(lookup.text)).toContain(`"admin_actions"."created_at" >= $`);
    expect(lookup.text).toMatch(
      / having count\(\*\) >= \$\d+ order by count\(\*\) desc, max\("admin_actions"\."created_at"\) desc limit \$\d+$/,
    );
    expect(params).toEqual(expect.arrayContaining(["east", "kick", "applied", "accepted", since.toISOString(), 2, 50]));
    expect(params).not.toContain("failed");
  });
});
