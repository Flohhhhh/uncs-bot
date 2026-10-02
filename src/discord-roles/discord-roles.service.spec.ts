import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import type { EnvService } from "../env/env.service";
import type { DiscordRolesDiscord, RoleMember } from "./discord-roles.discord";
import { DiscordRolesService } from "./discord-roles.service";
import type { DiscordRolesStore, RoleActionStart } from "./discord-roles.store";
import { PAYPAL_SUPPORT_MS, supportActive, type SupportFacts } from "../supporters/supporters.types";
import { SAFETY_PASS_MS, type RoleCheckView } from "./discord-roles.types";

const GUILD = "100000000000000001";
const UNC = "200000000000000001";
const FOUNDER = "200000000000000002";
const SUPPORTER = "200000000000000004";
const A = "300000000000000001";
const B = "300000000000000002";
const admin: Staff = { id: "400000000000000001", name: "Admin", role: "admin", csrf: "csrf" };

class TestRolesService extends DiscordRolesService {
  readonly sleeps: number[] = [];
  protected sleep(ms: number) {
    this.sleeps.push(ms);
    return Promise.resolve();
  }
}
type LedgerRow = RoleActionStart & {
  id: string;
  state: string;
  changed: boolean;
  message: string;
  createdAt: Date;
};
type FakeMember = RoleMember & { roles: Set<string>; add: jest.Mock; remove: jest.Mock };
const assignable = (id: string, name: string): RoleCheckView => ({
  id,
  name,
  exists: true,
  position: 1,
  managed: false,
  privileged: false,
  staffRole: false,
  assignable: true,
  problem: null,
});

const services: DiscordRolesService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.onModuleDestroy();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const transient = () => Object.assign(new Error("Service Unavailable"), { status: 503 });
/** A ledger row written by an earlier pass. */
const history = (overrides: Partial<LedgerRow> & Pick<LedgerRow, "discordUserId">): LedgerRow => ({
  id: randomUUID(),
  trigger: "event",
  requestedBy: null,
  guildId: GUILD,
  roleKind: "member",
  roleId: UNC,
  operation: "add",
  basisType: "application",
  basisId: "application-a",
  state: "applied",
  changed: true,
  message: "Recorded",
  createdAt: new Date(),
  ...overrides,
});

function fixture(env: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    DISCORD_ROLES_ENABLED: true,
    ADMIN_GUILD_ID: GUILD,
    DISCORD_MEMBER_ROLE_ID: UNC,
    DISCORD_FOUNDER_ROLE_ID: FOUNDER,
    ADMIN_ADMIN_ROLE_IDS: "",
    ...env,
  };
  const ledger: LedgerRow[] = [];
  const state = {
    member: new Map<string, string>(),
    founder: new Map<string, string>(),
    supporter: new Map<string, string>(),
    revoked: new Map<string, string>(),
  };
  const order: string[] = [];
  const only = (map: Map<string, string>, users?: string[]) =>
    new Map([...map].filter(([user]) => !users || users.includes(user)));
  const store = {
    desired: jest.fn(async (users?: string[]) => ({
      member: only(state.member, users),
      founder: only(state.founder, users),
    })),
    revokedBasis: jest.fn(async (users?: string[]) => only(state.revoked, users)),
    supporterDesired: jest.fn(async (users?: string[]) => only(state.supporter, users)),
    heldBasis: jest.fn(async (guildId: string, kind: string, roleId: string, users?: string[]) => {
      const latest = new Map<string, LedgerRow>();
      for (const row of ledger)
        if (
          row.guildId === guildId &&
          row.roleKind === kind &&
          row.roleId === roleId &&
          ["applied", "unknown", "started"].includes(row.state) &&
          (!users || users.includes(row.discordUserId))
        )
          latest.set(row.discordUserId, row);
      return new Map(
        [...latest]
          .filter(([, row]) => row.operation === "add" || (row.operation === "remove" && row.state !== "applied"))
          .map(([user, row]) => [user, row.basisId]),
      );
    }),
    lastEffective: jest.fn(async (guildId: string, userId: string, kind: string, roleId?: string) => {
      const rows = ledger.filter(
        (row) =>
          row.guildId === guildId &&
          row.discordUserId === userId &&
          row.roleKind === kind &&
          (roleId === undefined || row.roleId === roleId) &&
          ["applied", "unknown", "started"].includes(row.state),
      );
      const row = rows.at(-1);
      return row
        ? { id: row.id, operation: row.operation, state: row.state, changed: row.changed, createdAt: row.createdAt }
        : null;
    }),
    begin: jest.fn(async (input: RoleActionStart) => {
      const id = randomUUID();
      order.push(`begin:${input.operation}:${input.discordUserId}:${input.roleKind}`);
      ledger.push({ ...input, id, state: "started", changed: false, message: "Recorded", createdAt: new Date() });
      return id;
    }),
    finish: jest.fn(async (id: string, rowState: string, changed: boolean, message: string) => {
      Object.assign(ledger.find((row) => row.id === id)!, { state: rowState, changed, message });
    }),
    note: jest.fn(async (input: Omit<RoleActionStart, "operation">) => {
      ledger.push({
        ...input,
        operation: "note",
        id: randomUUID(),
        state: "applied",
        changed: false,
        message: "Noted",
        createdAt: new Date(),
      });
    }),
    confirm: jest.fn(async (id: string, _operation?: "add" | "remove") => {
      Object.assign(ledger.find((row) => row.id === id)!, { state: "applied", changed: true });
    }),
    summary: jest.fn(async () => ({ memberEligible: state.member.size, founders: 2, foundersWithoutDiscord: 1 })),
    foundersWithoutDiscord: jest.fn(async () => [
      {
        supporterId: "supporter-1",
        displayName: "PayPal donor",
        provider: "paypal",
        awardedAt: "2026-10-01T00:00:00Z",
      },
    ]),
    recent: jest.fn(async () => ledger.slice(-25).reverse()),
  };
  const members = new Map<string, FakeMember>();
  const discord = {
    ready: jest.fn(() => true),
    check: jest.fn(async () => ({
      manageRoles: true,
      highestRolePosition: 9,
      roles: {
        member: assignable(UNC, "UNC"),
        founder: assignable(FOUNDER, "Founder"),
        supporter: assignable(SUPPORTER, "Supporter"),
      },
    })),
    member: jest.fn(
      async (_guildId: string, userId: string): Promise<RoleMember | null> => members.get(userId) ?? null,
    ),
  };
  const addMember = (id: string, roles: string[] = [], joinedAt = new Date(Date.now() - 86_400_000)) => {
    const set = new Set(roles);
    const member: FakeMember = {
      id,
      joinedAt,
      roles: set,
      has: (roleId) => set.has(roleId),
      add: jest.fn(async (roleId: string) => {
        order.push(`discord:add:${id}:${roleId}`);
        set.add(roleId);
      }),
      remove: jest.fn(async (roleId: string) => {
        order.push(`discord:remove:${id}:${roleId}`);
        set.delete(roleId);
      }),
    };
    members.set(id, member);
    return member;
  };
  const service = new TestRolesService(
    store as unknown as DiscordRolesStore,
    discord as unknown as DiscordRolesDiscord,
    { get: (key: string) => values[key] } as unknown as EnvService,
  );
  services.push(service);
  const status = () => service.status(admin);
  return { service, store, discord, ledger, state, order, addMember, members, values, status };
}
const reconcile = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  reason: "Checked the role setup",
  ...overrides,
});

describe("Discord role passes", () => {
  it("adds earned roles, records each change before Discord and spaces the writes", async () => {
    const { service, state, addMember, ledger, order, status } = fixture();
    state.member.set(A, "application-a");
    state.founder.set(A, "supporter-a");
    const member = addMember(A);
    service.applicationChanged(A);
    await service.tick();
    expect(member.add).toHaveBeenCalledWith(UNC, "Gramps: UNC member application approved");
    expect(member.add).toHaveBeenCalledWith(FOUNDER, "Gramps: founding supporter");
    expect(order).toEqual([
      `begin:add:${A}:member`,
      `discord:add:${A}:${UNC}`,
      `begin:add:${A}:founder`,
      `discord:add:${A}:${FOUNDER}`,
    ]);
    expect(ledger).toMatchObject([
      {
        roleKind: "member",
        operation: "add",
        state: "applied",
        changed: true,
        basisType: "application",
        basisId: "application-a",
        trigger: "event",
      },
      {
        roleKind: "founder",
        operation: "add",
        state: "applied",
        changed: true,
        basisType: "founder",
        basisId: "supporter-a",
      },
    ]);
    expect(ledger.every((row) => row.guildId === GUILD && row.roleId)).toBe(true);
    expect(service.sleeps).toEqual([1100]);
    expect((await status()).lastPass).toMatchObject({ trigger: "event", added: 2, failed: 0, users: 1 });
  });

  it("notes a role that was already present and never removes it after revocation", async () => {
    const { service, state, addMember, ledger } = fixture();
    state.member.set(A, "application-a");
    const member = addMember(A, [UNC]);
    service.applicationChanged(A);
    await service.tick();
    expect(member.add).not.toHaveBeenCalled();
    expect(ledger).toMatchObject([{ operation: "note", changed: false, state: "applied" }]);
    state.member.delete(A);
    state.revoked.set(A, "application-a");
    service.applicationChanged(A);
    await service.tick();
    expect(member.remove).not.toHaveBeenCalled();
    expect(member.roles.has(UNC)).toBe(true);
  });

  it("removes only the UNC role it added after the application is revoked, and keeps the Founder role", async () => {
    const { service, state, addMember, ledger } = fixture();
    state.member.set(A, "application-a");
    state.founder.set(A, "supporter-a");
    const member = addMember(A);
    service.applicationChanged(A);
    await service.tick();
    state.member.delete(A);
    state.revoked.set(A, "application-a");
    service.applicationChanged(A);
    await service.tick();
    expect(member.remove).toHaveBeenCalledTimes(1);
    expect(member.remove).toHaveBeenCalledWith(UNC, "Gramps: UNC application revoked");
    expect(member.roles.has(FOUNDER)).toBe(true);
    expect(ledger.at(-1)).toMatchObject({
      operation: "remove",
      state: "applied",
      changed: true,
      basisId: "application-a",
    });
  });

  it("respects a manual removal for the current membership and restores the role after rejoining", async () => {
    const { service, state, addMember, ledger, status } = fixture();
    state.member.set(A, "application-a");
    const member = addMember(A);
    service.applicationChanged(A);
    await service.tick();
    member.roles.delete(UNC);
    service.applicationChanged(A);
    await service.tick();
    expect(member.add).toHaveBeenCalledTimes(1);
    expect((await status()).attention).toContainEqual(
      expect.objectContaining({ kind: "removed_in_discord", discordUserId: A, roleKind: "member" }),
    );
    const rejoined = addMember(A, [], new Date(Date.now() + 1_000));
    service.memberJoined(GUILD, A);
    await service.tick();
    expect(rejoined.add).toHaveBeenCalledWith(UNC, "Gramps: UNC member application approved");
    expect(ledger.at(-1)).toMatchObject({ trigger: "member-join", operation: "add", state: "applied" });
  });

  it("ignores joins to other servers and anything queued while switched off", async () => {
    const { service, state, addMember, store } = fixture();
    state.member.set(A, "application-a");
    addMember(A);
    service.memberJoined("999999999999999999", A);
    service.applicationChanged("not-a-snowflake");
    await service.tick();
    expect(store.desired).not.toHaveBeenCalled();
    const off = fixture({ DISCORD_ROLES_ENABLED: false });
    off.state.member.set(A, "application-a");
    off.addMember(A);
    off.service.applicationChanged(A);
    off.service.onApplicationBootstrap();
    await off.service.tick();
    expect(off.store.desired).not.toHaveBeenCalled();
  });

  it("confirms an unknown add when the role is found present instead of adding again", async () => {
    const { service, state, addMember, ledger } = fixture();
    state.member.set(A, "application-a");
    const member = addMember(A, [UNC]);
    ledger.push({
      id: "unknown-add",
      trigger: "event",
      requestedBy: null,
      guildId: GUILD,
      discordUserId: A,
      roleKind: "member",
      roleId: UNC,
      operation: "add",
      basisType: "application",
      basisId: "application-a",
      state: "unknown",
      changed: false,
      message: "Unknown",
      createdAt: new Date(),
    });
    service.applicationChanged(A);
    await service.tick();
    expect(member.add).not.toHaveBeenCalled();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ state: "applied", changed: true });
  });

  it("blocks a role for the rest of the pass after a permission error, keeps the other role and warns once", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, state, addMember, ledger } = fixture();
    for (const user of [A, B]) {
      state.member.set(user, `application-${user}`);
      state.founder.set(user, `supporter-${user}`);
    }
    const first = addMember(A);
    const second = addMember(B);
    first.add.mockImplementation(async (roleId: string) => {
      if (roleId === UNC) throw Object.assign(new Error("Missing Permissions"), { code: 50013, status: 403 });
    });
    await service.reconcile(admin, reconcile());
    expect(second.add).not.toHaveBeenCalledWith(UNC, expect.any(String));
    expect(second.add).toHaveBeenCalledWith(FOUNDER, "Gramps: founding supporter");
    expect(ledger.find((row) => row.discordUserId === A && row.roleKind === "member")).toMatchObject({
      state: "failed",
      message: expect.stringContaining("cannot manage this role"),
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("records a member who left mid-pass as failed without a retry", async () => {
    const { service, state, addMember, ledger, status } = fixture();
    state.member.set(A, "application-a");
    addMember(A).add.mockRejectedValue(Object.assign(new Error("Unknown Member"), { code: 10007, status: 404 }));
    service.applicationChanged(A);
    await service.tick();
    expect(ledger).toMatchObject([{ state: "failed", message: expect.stringContaining("left the server") }]);
    expect((await status()).nextRetryAt).toBeNull();
  });

  it("reports people who are not in the server without writing a ledger row", async () => {
    const { service, state, ledger, status } = fixture();
    state.founder.set(B, "supporter-b");
    service.supporterChanged(B);
    await service.tick();
    expect(ledger).toHaveLength(0);
    expect((await status()).attention).toContainEqual(
      expect.objectContaining({ kind: "not_in_server", discordUserId: B }),
    );
  });

  it("makes at most 50 role writes per pass and queues the rest for a follow-up in a minute", async () => {
    const { service, state, addMember, ledger, status } = fixture();
    const users = Array.from({ length: 52 }, (_, index) => `3000000000000001${String(index).padStart(2, "0")}`);
    for (const user of users) {
      state.member.set(user, `application-${user}`);
      addMember(user);
    }
    const before = Date.now();
    const result = await service.reconcile(admin, reconcile());
    expect(result.summary).toMatchObject({ added: 50, deferred: 2 });
    expect(ledger).toHaveLength(50);
    expect(service.sleeps).toHaveLength(49);
    const view = await status();
    expect(view.queued).toBe(2);
    expect(Date.parse(view.nextRetryAt!)).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("leaves an unconfirmed change unknown and backs off that member for 1 minute, then 5 minutes", async () => {
    const { service, state, addMember, ledger, status } = fixture();
    state.member.set(A, "application-a");
    const member = addMember(A);
    member.add.mockRejectedValue(Object.assign(new Error("Service Unavailable"), { status: 503 }));
    let now = Date.parse("2026-10-02T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    service.applicationChanged(A);
    await service.tick();
    expect(ledger).toMatchObject([{ operation: "add", state: "unknown" }]);
    expect((await status()).nextRetryAt).toBe(new Date(now + 60_000).toISOString());
    // Still backing off: a new event does not contact Discord again.
    service.applicationChanged(A);
    await service.tick();
    expect(member.add).toHaveBeenCalledTimes(1);
    now += 61_000;
    await service.tick();
    expect(member.add).toHaveBeenCalledTimes(2);
    expect((await status()).nextRetryAt).toBe(new Date(now + 300_000).toISOString());
  });

  it("retries an unconfirmed UNC removal after the backoff until the role is gone", async () => {
    const { service, state, addMember, ledger } = fixture();
    state.member.set(A, "application-a");
    const member = addMember(A);
    let now = Date.parse("2026-10-02T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    service.applicationChanged(A);
    await service.tick();
    state.member.delete(A);
    state.revoked.set(A, "application-a");
    member.remove.mockRejectedValueOnce(transient());
    service.applicationChanged(A);
    await service.tick();
    expect(ledger.at(-1)).toMatchObject({ operation: "remove", state: "unknown" });
    expect(member.roles.has(UNC)).toBe(true);
    now += 61_000;
    await service.tick();
    expect(member.remove).toHaveBeenCalledTimes(2);
    expect(member.roles.has(UNC)).toBe(false);
    expect(ledger.at(-1)).toMatchObject({ operation: "remove", state: "applied", changed: true });
  });

  it("confirms an unconfirmed UNC removal that took effect instead of removing again", async () => {
    const { service, state, addMember, ledger, status } = fixture();
    state.revoked.set(A, "application-a");
    const member = addMember(A, [UNC]);
    ledger.push(history({ discordUserId: A }));
    member.remove.mockImplementationOnce(async (roleId: string) => {
      member.roles.delete(roleId);
      throw transient();
    });
    let now = Date.parse("2026-10-02T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    service.applicationChanged(A);
    await service.tick();
    expect(ledger.at(-1)).toMatchObject({ operation: "remove", state: "unknown" });
    now += 61_000;
    await service.tick();
    expect(member.remove).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(2);
    expect(ledger.at(-1)).toMatchObject({ operation: "remove", state: "applied", changed: true });
    expect((await status()).lastPass).toMatchObject({ confirmed: 1, failed: 0 });
  });

  it("ignores ledger history recorded for a different role ID", async () => {
    const OLD_UNC = "200000000000000009";
    const { service, state, addMember, ledger } = fixture();
    state.member.set(A, "application-a");
    state.revoked.set(B, "application-b");
    const first = addMember(A);
    const second = addMember(B, [UNC]);
    ledger.push(history({ discordUserId: A, roleId: OLD_UNC }));
    ledger.push(history({ discordUserId: B, roleId: OLD_UNC, basisId: "application-b" }));
    service.applicationChanged(A);
    service.applicationChanged(B);
    await service.tick();
    // A's add under the old role is not a manual removal of the new one.
    expect(first.add).toHaveBeenCalledWith(UNC, "Gramps: UNC member application approved");
    // Gramps never added the new role for B, so revocation leaves it alone.
    expect(second.remove).not.toHaveBeenCalled();
    expect(second.roles.has(UNC)).toBe(true);
  });

  it("runs the follow-up for people left over by a staff run without waiting for another event", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-02T12:00:00Z") });
    const { service, state, addMember, ledger } = fixture();
    const users = Array.from({ length: 52 }, (_, index) => `3000000000000003${String(index).padStart(2, "0")}`);
    for (const user of users) {
      state.member.set(user, `application-${user}`);
      addMember(user);
    }
    const ticks: Promise<void>[] = [];
    const tick = service.tick.bind(service);
    jest.spyOn(service, "tick").mockImplementation(() => {
      const run = tick();
      ticks.push(run);
      return run;
    });
    expect((await service.reconcile(admin, reconcile())).summary).toMatchObject({ added: 50, deferred: 2 });
    await jest.advanceTimersByTimeAsync(59_000);
    expect(ledger).toHaveLength(50);
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.all(ticks);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ledger).toHaveLength(52);
    expect(ledger.every((row) => row.state === "applied")).toBe(true);
  });

  it("keeps earlier failures in the attention list until that person is checked again", async () => {
    const { service, state, addMember, status } = fixture();
    state.member.set(A, "application-a");
    const member = addMember(A);
    member.add.mockRejectedValueOnce(Object.assign(new Error("Invalid Form Body"), { code: 50035, status: 400 }));
    state.founder.set(B, "supporter-b");
    await service.reconcile(admin, reconcile());
    // Someone with no application joins: a check with no candidates.
    service.memberJoined(GUILD, "300000000000000099");
    await service.tick();
    let view = await status();
    expect(view.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "failed", discordUserId: A, roleKind: "member" }),
        expect.objectContaining({ kind: "not_in_server", discordUserId: B }),
      ]),
    );
    expect(view.lastPass).toMatchObject({ trigger: "admin", failed: 1 });
    expect(view.lastFullPass).toMatchObject({ trigger: "admin", failed: 1 });
    // A later successful check for A clears A's item and keeps B's.
    service.applicationChanged(A);
    await service.tick();
    view = await status();
    expect(member.roles.has(UNC)).toBe(true);
    expect(view.attention).not.toContainEqual(expect.objectContaining({ kind: "failed", discordUserId: A }));
    expect(view.attention).toContainEqual(expect.objectContaining({ kind: "not_in_server", discordUserId: B }));
    expect(view.lastPass).toMatchObject({ trigger: "event", added: 1 });
    expect(view.lastFullPass).toMatchObject({ trigger: "admin" });
  });

  it("logs a fixed warning without database or Discord error text when a pass stops early", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, state, store } = fixture();
    state.member.set(A, "application-a");
    store.desired.mockRejectedValueOnce(
      new Error(`Failed query: select discord_user_id from whitelist_applications\nparams: ${A},${admin.id}`),
    );
    service.applicationChanged(A);
    await service.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("Discord role pass (event) did not finish");
    expect(message).not.toContain(A);
    expect(message).not.toContain(admin.id);
    expect(message).not.toContain("Failed query");
  });

  it("processes a role whose setup passes while another role is refused by the checks", async () => {
    const { service, state, addMember, discord } = fixture();
    discord.check.mockResolvedValue({
      manageRoles: true,
      highestRolePosition: 9,
      roles: {
        member: { ...assignable(UNC, "UNC"), assignable: false, privileged: true, problem: "Privileged" },
        founder: assignable(FOUNDER, "Founder"),
        supporter: assignable(SUPPORTER, "Supporter"),
      },
    });
    state.member.set(A, "application-a");
    state.founder.set(A, "supporter-a");
    const member = addMember(A);
    const { summary } = await service.reconcile(admin, reconcile());
    expect(member.add).toHaveBeenCalledTimes(1);
    expect(member.add).toHaveBeenCalledWith(FOUNDER, expect.any(String));
    expect(summary).toMatchObject({ added: 1, blocked: 1 });
  });

  it("waits for Discord before a pass", async () => {
    const { service, state, addMember, discord, store } = fixture();
    discord.ready.mockReturnValue(false);
    state.member.set(A, "application-a");
    addMember(A);
    service.applicationChanged(A);
    await service.tick();
    expect(store.desired).not.toHaveBeenCalled();
    await expect(service.reconcile(admin, reconcile())).rejects.toMatchObject({ status: 503 });
  });
});

describe("the Supporter role", () => {
  const withSupporter = { DISCORD_SUPPORTER_ROLE_ID: SUPPORTER };

  it("is skipped entirely while DISCORD_SUPPORTER_ROLE_ID is not set", async () => {
    const { service, state, addMember, store, ledger, status } = fixture();
    state.supporter.set(A, "supporter-a");
    const member = addMember(A);
    service.supporterChanged(A);
    await service.tick();
    await service.reconcile(admin, reconcile());
    expect(store.supporterDesired).not.toHaveBeenCalled();
    expect(store.heldBasis).not.toHaveBeenCalled();
    expect(member.add).not.toHaveBeenCalled();
    expect(ledger).toHaveLength(0);
    const view = await status();
    expect(view).toMatchObject({ configured: { supporterRole: false }, summary: { supporterEligible: null } });
    expect(view.lastFullPass).toMatchObject({ error: null, blocked: 0 });
  });

  it("adds the Supporter role beside the Founder role and removes only the Supporter role once support lapses", async () => {
    const { service, state, addMember, ledger } = fixture(withSupporter);
    state.founder.set(A, "supporter-a");
    state.supporter.set(A, "supporter-a");
    const member = addMember(A);
    service.supporterChanged(A);
    await service.tick();
    expect(member.add).toHaveBeenCalledWith(FOUNDER, "Gramps: founding supporter");
    expect(member.add).toHaveBeenCalledWith(SUPPORTER, "Gramps: active supporter");
    expect(ledger.at(-1)).toMatchObject({
      roleKind: "supporter",
      roleId: SUPPORTER,
      operation: "add",
      basisType: "supporter",
      basisId: "supporter-a",
      state: "applied",
    });
    state.supporter.delete(A);
    service.supporterChanged(A);
    await service.tick();
    expect(member.remove).toHaveBeenCalledTimes(1);
    expect(member.remove).toHaveBeenCalledWith(SUPPORTER, "Gramps: support ended");
    expect(member.roles.has(FOUNDER)).toBe(true);
    expect(member.roles.has(SUPPORTER)).toBe(false);
    expect(ledger.at(-1)).toMatchObject({
      roleKind: "supporter",
      operation: "remove",
      basisType: "supporter",
      basisId: "supporter-a",
      state: "applied",
      changed: true,
    });
    // Support that starts again adds the role again.
    state.supporter.set(A, "supporter-a");
    service.supporterChanged(A);
    await service.tick();
    expect(member.add).toHaveBeenCalledTimes(3);
    expect(member.roles.has(SUPPORTER)).toBe(true);
  });

  it("never removes a Supporter role that was already present and never re-adds one staff removed", async () => {
    const { service, state, addMember, ledger, status } = fixture(withSupporter);
    state.supporter.set(A, "supporter-a");
    state.supporter.set(B, "supporter-b");
    const present = addMember(A, [SUPPORTER]);
    const added = addMember(B);
    await service.reconcile(admin, reconcile());
    expect(present.add).not.toHaveBeenCalled();
    expect(ledger.find((row) => row.discordUserId === A)).toMatchObject({ operation: "note", changed: false });
    expect(added.add).toHaveBeenCalledWith(SUPPORTER, "Gramps: active supporter");
    // Staff remove B's role by hand; A's support lapses.
    added.roles.delete(SUPPORTER);
    state.supporter.delete(A);
    service.supporterChanged(A);
    service.supporterChanged(B);
    await service.tick();
    expect(present.remove).not.toHaveBeenCalled();
    expect(present.roles.has(SUPPORTER)).toBe(true);
    expect(added.add).toHaveBeenCalledTimes(1);
    expect((await status()).attention).toContainEqual(
      expect.objectContaining({ kind: "removed_in_discord", discordUserId: B, roleKind: "supporter" }),
    );
  });

  it("notices a lapsed PayPal payment on the six-hour safety pass without any event", async () => {
    const paidAt = Date.parse("2026-11-01T12:00:00Z");
    // Paid 31 days ago, less three hours: still supporting at startup, lapsed by the first safety pass.
    jest.useFakeTimers({ now: paidAt + PAYPAL_SUPPORT_MS - 3 * 3_600_000 });
    const record: SupportFacts = {
      provider: "paypal",
      patronStatus: null,
      lastChargeStatus: null,
      lastChargeAt: null,
      payments: [
        { source: "paypal", paidAt: new Date(paidAt), amountCents: 500, currency: "USD", minimumConfirmed: false },
      ],
    };
    const { service, store, addMember, ledger } = fixture(withSupporter);
    store.supporterDesired.mockImplementation(async () =>
      supportActive(record, Date.now()) ? new Map([[A, "paypal-a"]]) : new Map<string, string>(),
    );
    const member = addMember(A);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(member.add).toHaveBeenCalledWith(SUPPORTER, "Gramps: active supporter");
    expect(ledger).toMatchObject([{ trigger: "startup", operation: "add", basisId: "paypal-a" }]);
    // The safety timer queues a full pass, which starts on the next timer turn.
    await jest.advanceTimersByTimeAsync(SAFETY_PASS_MS);
    await jest.advanceTimersByTimeAsync(1);
    expect(member.remove).toHaveBeenCalledWith(SUPPORTER, "Gramps: support ended");
    expect(ledger.at(-1)).toMatchObject({ trigger: "schedule", operation: "remove", basisId: "paypal-a" });
    expect(store.heldBasis).toHaveBeenLastCalledWith(GUILD, "supporter", SUPPORTER, undefined);
  });

  it("does not flag a lapsed supporter who left the server", async () => {
    const { service, ledger, status, store } = fixture(withSupporter);
    ledger.push(
      history({
        discordUserId: B,
        roleKind: "supporter",
        roleId: SUPPORTER,
        basisType: "supporter",
        basisId: "supporter-b",
      }),
    );
    const { summary } = await service.reconcile(admin, reconcile());
    expect(store.heldBasis).toHaveBeenCalledWith(GUILD, "supporter", SUPPORTER, undefined);
    expect(summary).toMatchObject({ users: 1, added: 0, removed: 0, failed: 0 });
    expect((await status()).attention).not.toContainEqual(expect.objectContaining({ discordUserId: B }));
    expect(ledger).toHaveLength(1);
  });

  it("reports the Supporter role setup and how many people support right now", async () => {
    const { service, state } = fixture(withSupporter);
    state.supporter.set(A, "supporter-a");
    await expect(service.status(admin)).resolves.toMatchObject({
      configured: { supporterRole: true },
      roles: { supporter: { id: SUPPORTER, assignable: true } },
      ready: true,
      summary: { supporterEligible: 1 },
      note: expect.stringContaining("Supporter role is a Discord role only"),
    });
  });
});

describe("staff role controls", () => {
  it("previews changes while switched off and refuses a real run", async () => {
    const { service, state, addMember, store } = fixture({ DISCORD_ROLES_ENABLED: false });
    state.member.set(A, "application-a");
    state.founder.set(B, "supporter-b");
    const member = addMember(A);
    await expect(service.reconcile(admin, reconcile())).rejects.toMatchObject({
      status: 503,
      message: "Discord roles are switched off (DISCORD_ROLES_ENABLED=false).",
    });
    const preview = await service.reconcile(admin, reconcile({ dryRun: true }));
    expect(preview.summary.plan).toEqual([
      { discordUserId: A, roleKind: "member", op: "add", why: "desired" },
      { discordUserId: B, roleKind: null, op: "none", why: "not-in-server" },
    ]);
    expect(store.begin).not.toHaveBeenCalled();
    expect(store.note).not.toHaveBeenCalled();
    expect(member.add).not.toHaveBeenCalled();
    // A dry run is not the last real pass.
    expect((await service.status(admin)).lastPass).toBeNull();
  });

  it("limits a preview to 100 entries and a targeted preview to one person", async () => {
    const { service, state, addMember } = fixture();
    for (let index = 0; index < 120; index++) {
      const user = `3000000000000002${String(index).padStart(2, "0")}`;
      state.member.set(user, `application-${index}`);
      addMember(user);
    }
    expect((await service.reconcile(admin, reconcile({ dryRun: true }))).summary.plan).toHaveLength(100);
    const second = fixture();
    second.state.member.set(A, "application-a");
    second.addMember(A);
    expect((await second.service.reconcile(admin, reconcile({ dryRun: true, discordUserId: B }))).summary.plan).toEqual(
      [{ discordUserId: B, roleKind: null, op: "none", why: "no-basis" }],
    );
  });

  it("records who asked for a run, replays the same action ID and enforces the 30 second spacing", async () => {
    const { service, state, addMember, ledger } = fixture();
    state.member.set(A, "application-a");
    addMember(A);
    const body = reconcile({ discordUserId: A });
    const first = await service.reconcile(admin, body);
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      summary: { trigger: "admin", requestedBy: admin.id, added: 1 },
    });
    expect(ledger).toMatchObject([{ trigger: "admin", requestedBy: admin.id }]);
    expect(await service.reconcile(admin, body)).toEqual({ ...first, replayed: true });
    await expect(service.reconcile(admin, { ...body, reason: "A different reason" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(service.reconcile({ ...admin, id: "400000000000000002" }, body)).rejects.toMatchObject({
      status: 409,
    });
    await expect(service.reconcile(admin, reconcile())).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a run while another pass is running", async () => {
    const { service, state, addMember, discord } = fixture();
    state.member.set(A, "application-a");
    addMember(A);
    let release!: () => void;
    discord.member.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    service.applicationChanged(A);
    const running = service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.reconcile(admin, reconcile())).rejects.toMatchObject({ status: 409 });
    release();
    await running;
  });

  it.each(["moderator", "viewer"] as const)("refuses %s staff", async (role) => {
    const { service, store } = fixture();
    await expect(service.status({ ...admin, role })).rejects.toMatchObject({ status: 403 });
    await expect(service.reconcile({ ...admin, role }, reconcile())).rejects.toMatchObject({ status: 403 });
    expect(store.summary).not.toHaveBeenCalled();
  });

  it.each([
    [{ reason: "x" }],
    [{ id: "not-a-uuid" }],
    [{ discordUserId: "123" }],
    [{ dryRun: "yes" }],
    [{ extra: true }],
  ])("rejects an invalid run request %p", async (change) => {
    const { service } = fixture();
    await expect(service.reconcile(admin, reconcile(change))).rejects.toMatchObject({ status: 400 });
  });

  it("reports setup, readiness, counts and founders without a linked Discord account", async () => {
    const { service, discord } = fixture({ DISCORD_ROLES_ENABLED: false });
    await expect(service.status(admin)).resolves.toMatchObject({
      enabled: false,
      configured: { guild: true, memberRole: true, founderRole: true },
      discordReady: true,
      bot: { manageRoles: true, highestRolePosition: 9 },
      roles: { member: { id: UNC, assignable: true }, founder: { id: FOUNDER, assignable: true } },
      ready: true,
      lastPass: null,
      queued: 0,
      summary: { founders: 2, foundersWithoutDiscord: 1 },
      attention: [{ kind: "founder_without_discord", supporterId: "supporter-1", provider: "paypal" }],
      recent: [],
    });
    discord.check.mockRejectedValueOnce(new Error("Missing Access"));
    await expect(service.status(admin)).resolves.toMatchObject({
      ready: false,
      roles: { member: { assignable: false, problem: expect.stringContaining("could not be read") } },
    });
    const unset = fixture({
      DISCORD_MEMBER_ROLE_ID: undefined,
      DISCORD_FOUNDER_ROLE_ID: undefined,
      ADMIN_GUILD_ID: undefined,
    });
    await expect(unset.service.status(admin)).resolves.toMatchObject({
      configured: { guild: false, memberRole: false, founderRole: false },
      ready: false,
      roles: { member: { problem: expect.stringContaining("ADMIN_GUILD_ID") } },
    });
  });
});
