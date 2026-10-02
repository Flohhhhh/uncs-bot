import { drizzle } from "drizzle-orm/node-postgres";
import type { Database } from "../database/database.types";
import * as schema from "../database/schema";
import { DiscordRolesStore } from "./discord-roles.store";

function fixture(rows: (text: string) => unknown[] = () => []) {
  const query = jest.fn(async (config: { text: string } | string, _params?: unknown[]) => ({
    rows: rows(typeof config === "string" ? config : config.text),
  }));
  const db = drizzle({ client: { query } as never, schema });
  return { store: new DiscordRolesStore(db as unknown as Database), query };
}
const text = (call: unknown[]) => (call[0] as { text: string }).text;

describe("Discord role records", () => {
  it("reads approved UNC member applications across servers and founders with a linked Discord account", async () => {
    const { store, query } = fixture((sql) =>
      sql.includes("FROM whitelist_applications")
        ? [{ userId: "300000000000000001", basisId: "application" }]
        : [{ userId: "300000000000000002", basisId: "supporter" }],
    );
    const desired = await store.desired(["300000000000000001", "300000000000000002"]);
    expect(desired.member).toEqual(new Map([["300000000000000001", "application"]]));
    expect(desired.founder).toEqual(new Map([["300000000000000002", "supporter"]]));
    const [member, founder] = query.mock.calls;
    expect(text(member)).toContain("WHERE status = 'approved' AND relationship = 'unc_member'");
    expect(text(member)).not.toContain("server_id");
    expect(text(founder)).toContain("WHERE m.discord_id IS NOT NULL");
    expect(text(founder)).not.toContain("provider");
    // Discord IDs are bound parameters, never part of the statement.
    expect(member[1]).toEqual(["300000000000000001", "300000000000000002"]);
    expect(text(member)).not.toContain("300000000000000001");
  });
  it("reads nothing for an empty target list", async () => {
    const { store, query } = fixture();
    await expect(store.desired([])).resolves.toEqual({ member: new Map(), founder: new Map() });
    await expect(store.revokedBasis([])).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
  it("counts a revoked UNC application only when no approved UNC application remains", async () => {
    const { store, query } = fixture();
    await store.revokedBasis();
    expect(text(query.mock.calls[0])).toContain("revoked.status = 'revoked' AND revoked.relationship = 'unc_member'");
    expect(text(query.mock.calls[0])).toContain("NOT EXISTS (SELECT 1 FROM whitelist_applications approved");
  });
  it("treats applied, unknown and unfinished rows for the configured role as the latest effective change", async () => {
    const { store, query } = fixture();
    await store.lastEffective("100000000000000001", "300000000000000001", "member", "200000000000000001");
    const [statement, params] = query.mock.calls[0] as [{ text: string }, unknown[]];
    expect(statement.text).toContain('"discord_role_actions"."role_id" = $');
    expect(statement.text).toContain('order by "discord_role_actions"."created_at" desc limit');
    expect(params).toEqual(
      expect.arrayContaining([
        "100000000000000001",
        "300000000000000001",
        "member",
        "200000000000000001",
        "applied",
        "unknown",
        "started",
      ]),
    );
    expect(params).not.toContain("failed");
  });
  it("confirms only an unfinished or unknown row of the expected operation", async () => {
    const { store, query } = fixture();
    await store.confirm("00000000-0000-4000-8000-000000000001", "remove");
    const [statement, params] = query.mock.calls[0] as [{ text: string }, unknown[]];
    expect(statement.text).toContain('update "discord_role_actions"');
    expect(statement.text).toContain('"discord_role_actions"."operation" = $');
    expect(params).toEqual(
      expect.arrayContaining([
        "applied",
        "Confirmed later: the role is absent after an unconfirmed removal.",
        "remove",
        "unknown",
        "started",
      ]),
    );
  });
  it("writes every row as the Gramps Discord roles system actor before Discord is called", async () => {
    const { store, query } = fixture((sql) => (sql.startsWith("insert") ? [["row-id"]] : []));
    await expect(
      store.begin({
        trigger: "admin",
        requestedBy: "400000000000000001",
        guildId: "100000000000000001",
        discordUserId: "300000000000000001",
        roleKind: "member",
        roleId: "200000000000000001",
        operation: "add",
        basisType: "application",
        basisId: "application",
      }),
    ).resolves.toBe("row-id");
    const [statement, params] = query.mock.calls[0] as [{ text: string }, unknown[]];
    expect(statement.text).toContain('insert into "discord_role_actions"');
    expect(params).toEqual(
      expect.arrayContaining(["system:discord-roles", "Gramps Discord roles", "400000000000000001", "admin", "add"]),
    );
  });
});
