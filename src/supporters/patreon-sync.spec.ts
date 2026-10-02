import { Logger } from "@nestjs/common";
import type { DiscordRolesDiscord, RoleMember } from "../discord-roles/discord-roles.discord";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import type { DiscordRolesStore } from "../discord-roles/discord-roles.store";
import type { RoleCheckView } from "../discord-roles/discord-roles.types";
import { Env } from "../env/env";
import type { EnvService } from "../env/env.service";
import {
  firstPaidEventId,
  PATREON_HISTORY_CAP,
  PATREON_TOKEN_REJECTED,
  PatreonApiError,
  PatreonClient,
  type PatreonPledgeEvent,
} from "./patreon.client";
import { PATREON_SYNC_STARTUP_DELAY_MS, PatreonSyncService } from "./patreon-sync.service";
import type { ApiImportResult, SupportersStore } from "./supporters.store";

const token = "creator-token-PRIVATE-0123456789abcdef";
const campaign = "16880209";
const discordId = "123456789012345678";

type EventInput = { id: string; date: string; status: string; amount?: number; currency?: string; type?: string };
function member(id: string, events: EventInput[] = [], options: { name?: unknown; user?: string } = {}) {
  return {
    id,
    type: "member",
    attributes: {
      full_name: "name" in options ? options.name : `Patron ${id}`,
      patron_status: "active_patron",
      last_charge_status: "Paid",
      last_charge_date: "2026-10-01T12:00:00.000+00:00",
      email: "private@example.test",
      note: "private creator note",
    },
    relationships: {
      user: { data: options.user ? { id: options.user, type: "user" } : null },
      pledge_history: { data: events.map((event) => ({ id: event.id, type: "pledge-event" })) },
      address: { data: { id: "address-1", type: "address" } },
    },
  };
}
function event(input: EventInput) {
  return {
    id: input.id,
    type: "pledge-event",
    attributes: {
      amount_cents: input.amount ?? 500,
      currency_code: input.currency ?? "USD",
      date: input.date,
      payment_status: input.status,
      type: input.type ?? "subscription",
      tier_title: "Supporter",
    },
  };
}
function user(id: string, discord: unknown = { user_id: discordId, scopes: ["identify"] }) {
  return {
    id,
    type: "user",
    attributes: {
      social_connections: { discord, twitter: { user_id: "private-twitter" }, youtube: null },
      email: "private@example.test",
    },
  };
}
const start = (id: string, date = "2026-10-01T12:00:00.000+00:00"): EventInput => ({
  id,
  date,
  status: "Paid",
  type: "pledge_start",
});
function page(members: unknown[], included: unknown[] = [], next: string | null = null) {
  return { data: members, included, meta: { pagination: { cursors: { next }, total: members.length } } };
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const imported = (overrides: Partial<ApiImportResult> = {}): ApiImportResult => ({
  memberId: "00000000-0000-4000-8000-000000000001",
  patreonMemberId: "member-1",
  created: true,
  updated: false,
  payments: 1,
  revoked: 0,
  discordLinked: false,
  conflict: null,
  discordId: null,
  ...overrides,
});
function fixture(
  overrides: Record<string, unknown> = {},
  roles: Pick<DiscordRolesService, "supporterChanged"> = { supporterChanged: jest.fn() },
) {
  const values: Record<string, unknown> = {
    PATREON_ENABLED: true,
    PATREON_CAMPAIGN_ID: campaign,
    PATREON_CREATOR_ACCESS_TOKEN: token,
    PATREON_SYNC_INTERVAL_MINUTES: 30,
    ADMIN_SESSION_SECRET: "s".repeat(40),
    ...overrides,
  };
  const store = {
    importApiMember: jest.fn().mockResolvedValue(imported()),
    founderReviews: jest.fn().mockResolvedValue([]),
  };
  const service = new PatreonSyncService(
    new PatreonClient(),
    store as unknown as SupportersStore,
    { get: (key: string) => values[key] } as EnvService,
    roles as DiscordRolesService,
  );
  return { service, store, roles };
}
let fetchMock: jest.SpyInstance;
let warn: jest.SpyInstance;
let log: jest.SpyInstance;
const services: PatreonSyncService[] = [];
beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, "fetch");
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const service of services.splice(0)) service.onModuleDestroy();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
function tracked(overrides: Record<string, unknown> = {}, roles?: Pick<DiscordRolesService, "supporterChanged">) {
  const result = fixture(overrides, roles);
  services.push(result.service);
  return result;
}
async function settle(service: PatreonSyncService) {
  while (service.status().running) await new Promise((resolve) => setImmediate(resolve));
}
function expectNoToken() {
  const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
  expect(logged).not.toContain(token);
}

describe("Patreon API client", () => {
  it("requests only the import fields with a bounded page size, bearer token and descriptive user agent", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(page([member("member-1", [start("pledge_start:1")])], [event(start("pledge_start:1"))], "cursor-2")),
      )
      .mockResolvedValueOnce(json(page([member("member-2")])));
    const result = await new PatreonClient().members(campaign, token);
    expect(result.complete).toBe(true);
    expect(result.members.map((item) => item.patreonMemberId)).toEqual(["member-1", "member-2"]);
    const [first, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(first.origin + first.pathname).toBe(`https://www.patreon.com/api/oauth2/v2/campaigns/${campaign}/members`);
    expect(first.searchParams.get("include")).toBe("user,pledge_history");
    expect(first.searchParams.get("fields[member]")).toBe(
      "full_name,patron_status,last_charge_status,last_charge_date",
    );
    expect(first.searchParams.get("fields[user]")).toBe("social_connections");
    expect(first.searchParams.get("fields[pledge-event]")).toBe("amount_cents,currency_code,date,payment_status,type");
    expect(first.searchParams.get("page[count]")).toBe("50");
    expect(first.searchParams.has("page[cursor]")).toBe(false);
    expect(first.toString()).not.toMatch(/email|address|note/);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "User-Agent": expect.stringMatching(/UNCs/),
    });
    const [second] = fetchMock.mock.calls[1] as [URL];
    expect(second.searchParams.get("page[cursor]")).toBe("cursor-2");
  });
  it("keeps only the display name, statuses, charges and connected Discord ID", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        page(
          [member("member-1", [start("pledge_start:1")], { user: "user-1" })],
          [event(start("pledge_start:1")), user("user-1")],
        ),
      ),
    );
    const { members } = await new PatreonClient().members(campaign, token);
    expect(members[0]).toEqual({
      patreonMemberId: "member-1",
      displayName: "Patron member-1",
      patronStatus: "active_patron",
      lastChargeStatus: "Paid",
      lastChargeAt: new Date("2026-10-01T12:00:00Z"),
      discordId,
      events: [
        {
          id: "pledge_start:1",
          date: new Date("2026-10-01T12:00:00Z"),
          amountCents: 500,
          currency: "USD",
          paymentStatus: "Paid",
          type: "pledge_start",
        },
      ],
      historyComplete: true,
    });
    expect(JSON.stringify(members)).not.toMatch(/private|twitter|Supporter|address/);
  });
  it.each([
    ["", null],
    [null, null],
    ["x".repeat(500), null],
  ])("allows hidden or unusable names without rejecting the page: %p", async (name, expected) => {
    fetchMock.mockResolvedValueOnce(json(page([member("member-1", [], { name })])));
    const { members } = await new PatreonClient().members(campaign, token);
    expect(members[0].displayName).toBe(expected);
  });
  it("ignores a malformed Discord connection instead of linking it", async () => {
    fetchMock.mockResolvedValueOnce(
      json(page([member("member-1", [], { user: "user-1" })], [user("user-1", { user_id: "not-a-snowflake" })])),
    );
    expect((await new PatreonClient().members(campaign, token)).members[0].discordId).toBeNull();
  });
  it.each([
    ["a non-member resource", page([{ ...member("member-1"), type: "user" }])],
    ["an invalid member ID", page([member("member/../1")])],
    [
      "a malformed pledge event",
      page(
        [member("member-1", [start("pledge_start:1")])],
        [{ ...event(start("pledge_start:1")), attributes: { date: "yesterday" } }],
      ),
    ],
    ["an invalid amount", page([member("member-1")], [event({ ...start("pledge_start:1"), amount: -5 })])],
    ["a missing data array", { included: [] }],
  ])("rejects %s before importing anything", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(json(body));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "schema" });
  });
  it("rejects oversized responses and repeated pagination cursors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { headers: { "Content-Length": String(9 * 1024 * 1024) } }));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "schema" });
    fetchMock
      .mockResolvedValueOnce(json(page([member("member-1")], [], "same")))
      .mockResolvedValueOnce(json(page([member("member-2")], [], "same")));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "schema" });
  });
  it.each([401, 403])("maps %s to a token rejection with renewal instructions", async (status) => {
    fetchMock.mockResolvedValueOnce(json({ errors: [{ status: String(status), detail: token }] }, { status }));
    const error = await new PatreonClient().members(campaign, token).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PatreonApiError);
    expect(error).toMatchObject({ kind: "token", message: PATREON_TOKEN_REJECTED });
    expect(String((error as Error).message)).toMatch(/Creator's Access Token.*Railway/);
    expect(JSON.stringify(error)).not.toContain(token);
  });
  it("honours Retry-After seconds and Patreon's retry_after_seconds body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "120" } }));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({
      kind: "rate",
      retryAfterMs: 120_000,
    });
    fetchMock.mockResolvedValueOnce(
      json({ errors: [{ code_name: "RequestThrottled", retry_after_seconds: 9, status: "429" }] }, { status: 429 }),
    );
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ retryAfterMs: 9_000 });
  });
  it("maps network failures and server errors to a retryable outage", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${token}`));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "unavailable" });
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 502 }));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("marks histories incomplete when events are missing, capped or do not start with the pledge", async () => {
    const many = Array.from({ length: PATREON_HISTORY_CAP }, (_, index) => ({
      id: `subscription:${index}`,
      date: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
      status: "Paid",
      type: index ? "subscription" : "pledge_start",
    }));
    const midChain: EventInput = { id: "subscription:9", date: "2026-10-01T00:00:00Z", status: "Paid" };
    fetchMock.mockResolvedValueOnce(
      json(
        page(
          [
            member("missing", [start("pledge_start:1"), start("pledge_start:2")]),
            member("capped", many),
            member("mid-chain", [midChain]),
            member("complete", [start("pledge_start:3")]),
          ],
          [event(start("pledge_start:1")), ...many.map(event), event(midChain), event(start("pledge_start:3"))],
        ),
      ),
    );
    const { members } = await new PatreonClient().members(campaign, token);
    expect(members.map((item) => [item.patreonMemberId, item.historyComplete])).toEqual([
      ["missing", false],
      ["capped", false],
      ["mid-chain", false],
      ["complete", true],
    ]);
  });
});

describe("Patreon import settings", () => {
  it("bounds the interval and never rejects the bot's configuration over the token's shape", () => {
    expect(Env.shape.PATREON_SYNC_INTERVAL_MINUTES.parse(undefined)).toBe(30);
    expect(Env.shape.PATREON_SYNC_INTERVAL_MINUTES.parse("10")).toBe(10);
    expect(Env.shape.PATREON_SYNC_INTERVAL_MINUTES.parse("1440")).toBe(1440);
    for (const value of ["9", "1441", "15.5"])
      expect(Env.shape.PATREON_SYNC_INTERVAL_MINUTES.safeParse(value).success).toBe(false);
    expect(Env.shape.PATREON_CREATOR_ACCESS_TOKEN.parse(undefined)).toBeUndefined();
    expect(Env.shape.PATREON_CREATOR_ACCESS_TOKEN.parse("   ")).toBeUndefined();
    expect(Env.shape.PATREON_CREATOR_ACCESS_TOKEN.parse(` ${token} `)).toBe(token);
    expect(Env.shape.PATREON_CREATOR_ACCESS_TOKEN.safeParse("x".repeat(5000)).success).toBe(true);
  });
});

describe("first successful payment derivation", () => {
  const at = (id: string, date: string, paymentStatus: string, type = "subscription"): PatreonPledgeEvent => ({
    id,
    date: new Date(date),
    amountCents: 500,
    currency: "USD",
    paymentStatus,
    type,
  });
  it("uses the earliest Paid event of a complete history only", () => {
    const events = [
      at("subscription:2", "2026-11-01T00:00:00Z", "Paid"),
      at("pledge_start:1", "2026-10-01T00:00:00Z", "Paid", "pledge_start"),
    ];
    expect(firstPaidEventId(events, true)).toBe("pledge_start:1");
    expect(firstPaidEventId(events, false)).toBeNull();
  });
  it("skips declined attempts but refuses to guess after an earlier refund, fraud or tie", () => {
    const paid = at("subscription:2", "2026-10-02T00:00:00Z", "Paid");
    expect(firstPaidEventId([at("pledge_start:1", "2026-10-01T00:00:00Z", "Declined"), paid], true)).toBe(
      "subscription:2",
    );
    for (const status of ["Refunded", "Partially Refunded", "Fraud", "Refunded by Patreon"])
      expect(firstPaidEventId([at("pledge_start:1", "2026-10-01T00:00:00Z", status), paid], true)).toBeNull();
    expect(firstPaidEventId([paid, at("subscription:3", "2026-10-02T00:00:00Z", "Paid")], true)).toBeNull();
    expect(firstPaidEventId([], true)).toBeNull();
  });
});

describe("Patreon sync worker", () => {
  const onePage = () =>
    json(
      page(
        [member("member-1", [start("pledge_start:1")], { user: "user-1" })],
        [event(start("pledge_start:1")), user("user-1")],
      ),
    );
  it("imports every member through the store and reports additive status counts", async () => {
    const { service, store } = tracked();
    store.importApiMember.mockResolvedValueOnce(imported({ discordLinked: true }));
    fetchMock.mockResolvedValueOnce(onePage());
    const status = await service.sync();
    expect(store.importApiMember).toHaveBeenCalledWith(
      campaign,
      expect.objectContaining({ patreonMemberId: "member-1", discordId, historyComplete: true }),
      expect.any(Date),
    );
    expect(status).toMatchObject({
      configured: true,
      running: false,
      lastError: null,
      tokenRejected: false,
      members: 1,
      newMembers: 1,
      updated: 0,
      payments: 1,
      discordLinks: 1,
      conflicts: 0,
      truncated: 0,
      memberListComplete: true,
    });
    expect(status.lastSuccessAt).not.toBeNull();
    expect(store.founderReviews).toHaveBeenCalledWith(campaign);
    expectNoToken();
  });
  it("asks the role service to check linked Discord accounts whose supporter record changed", async () => {
    const { service, store, roles } = tracked();
    store.importApiMember.mockResolvedValueOnce(imported({ discordLinked: true, discordId }));
    fetchMock.mockResolvedValueOnce(onePage());
    await service.sync();
    expect(roles.supporterChanged).toHaveBeenCalledTimes(1);
    expect(roles.supporterChanged).toHaveBeenCalledWith(discordId);
    // A changed status on a record staff already linked can start or end support for the Supporter role.
    const linked = "223456789012345678";
    store.importApiMember.mockResolvedValueOnce(
      imported({ created: false, updated: true, payments: 0, discordId: linked, conflict: "discord-differs" }),
    );
    fetchMock.mockResolvedValueOnce(onePage());
    await service.sync();
    expect(roles.supporterChanged).toHaveBeenCalledTimes(2);
    expect(roles.supporterChanged).toHaveBeenLastCalledWith(linked);
    // An unchanged record, or a changed one without a linked Discord account, queues nothing.
    store.importApiMember.mockResolvedValueOnce(imported({ created: false, payments: 0, discordId: linked }));
    fetchMock.mockResolvedValueOnce(onePage());
    await service.sync();
    store.importApiMember.mockResolvedValueOnce(imported({ discordLinked: false, conflict: "discord-in-use" }));
    fetchMock.mockResolvedValueOnce(onePage());
    await service.sync();
    expect(roles.supporterChanged).toHaveBeenCalledTimes(2);
  });
  it("keeps importing when the role service throws", async () => {
    const roles = {
      supporterChanged: jest.fn(() => {
        throw new Error("role queue unavailable");
      }),
    };
    const { service, store } = tracked({}, roles);
    store.importApiMember.mockResolvedValueOnce(imported({ discordLinked: true, discordId }));
    fetchMock.mockResolvedValueOnce(onePage());
    expect(await service.sync()).toMatchObject({ lastError: null, discordLinks: 1 });
    expect(roles.supporterChanged).toHaveBeenCalledWith(discordId);
  });
  it("gives the Founder role to a Patreon API founder whose Discord ID the sync linked", async () => {
    const guild = "100000000000000001";
    const founderRole = "200000000000000002";
    // The supporter was awarded on an imported payment before Patreon reported their Discord account, so the
    // role service only learns who they are from the sync's link.
    const roleStore = {
      desired: jest.fn(async (users?: string[]) => ({
        member: new Map<string, string>(),
        founder: new Map(users?.includes(discordId) ? [[discordId, "patreon-api-founder"]] : []),
      })),
      revokedBasis: jest.fn(async () => new Map<string, string>()),
      lastEffective: jest.fn(async () => null),
      begin: jest.fn(async () => "role-action-1"),
      finish: jest.fn(async () => undefined),
    };
    const view = (id: string | null, assignable: boolean): RoleCheckView => ({
      id,
      name: assignable ? "Founder" : null,
      exists: assignable,
      position: 1,
      managed: false,
      privileged: false,
      staffRole: false,
      assignable,
      problem: assignable ? null : "Not configured.",
    });
    const discordMember = {
      id: discordId,
      joinedAt: new Date(Date.now() - 86_400_000),
      has: () => false,
      add: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    } satisfies RoleMember;
    const discord = {
      ready: () => true,
      check: jest.fn(async () => ({
        manageRoles: true,
        highestRolePosition: 9,
        roles: { member: view(null, false), founder: view(founderRole, true) },
      })),
      member: jest.fn(async (_guild: string, userId: string) => (userId === discordId ? discordMember : null)),
    };
    const settings: Record<string, unknown> = {
      DISCORD_ROLES_ENABLED: true,
      ADMIN_GUILD_ID: guild,
      DISCORD_FOUNDER_ROLE_ID: founderRole,
    };
    const roles = new DiscordRolesService(
      roleStore as unknown as DiscordRolesStore,
      discord as unknown as DiscordRolesDiscord,
      { get: (key: string) => settings[key] } as unknown as EnvService,
    );
    try {
      const { service, store } = tracked({}, roles);
      store.importApiMember.mockResolvedValueOnce(
        imported({ created: false, payments: 0, discordLinked: true, discordId }),
      );
      fetchMock.mockResolvedValueOnce(onePage());
      await service.sync();
      await roles.tick();
      expect(roleStore.desired).toHaveBeenCalledWith([discordId]);
      expect(discordMember.add).toHaveBeenCalledWith(founderRole, "Gramps: founding supporter");
      expect(roleStore.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          discordUserId: discordId,
          roleKind: "founder",
          roleId: founderRole,
          operation: "add",
          basisType: "founder",
          basisId: "patreon-api-founder",
        }),
      );
      expect(roleStore.finish).toHaveBeenCalledWith("role-action-1", "applied", true, "Role added.");
    } finally {
      roles.onModuleDestroy();
    }
  });
  it("reports Discord conflicts and incomplete histories without failing the sync", async () => {
    const { service, store } = tracked();
    store.importApiMember.mockResolvedValueOnce(
      imported({ created: false, updated: true, payments: 0, conflict: "discord-in-use" }),
    );
    fetchMock.mockResolvedValueOnce(
      json(
        page(
          [member("member-1", [{ ...start("pledge_start:1"), type: "subscription" }])],
          [event({ ...start("pledge_start:1"), type: "subscription" })],
        ),
      ),
    );
    expect(await service.sync()).toMatchObject({
      updated: 1,
      conflicts: 1,
      truncated: 1,
      conflictDetails: [{ patreonMemberId: "member-1", reason: "discord-in-use" }],
    });
  });
  it("joins a running sync instead of starting another", async () => {
    const { service, store } = tracked();
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    const first = service.sync();
    const second = service.sync();
    const staff = service.staffSync();
    expect(service.status().running).toBe(true);
    release(onePage());
    const [a, b, c] = await Promise.all([first, second, staff]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.importApiMember).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(c).toMatchObject({ joined: true, sync: a });
    expect(await service.staffSync()).toMatchObject({ joined: false, recent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("marks a rejected token, keeps earlier records and never exposes the token", async () => {
    const { service, store } = tracked();
    fetchMock.mockResolvedValueOnce(onePage());
    const good = await service.sync();
    fetchMock.mockResolvedValueOnce(json({ errors: [{ detail: `bad token ${token}` }] }, { status: 401 }));
    const status = await service.sync();
    expect(status).toMatchObject({
      tokenRejected: true,
      lastError: PATREON_TOKEN_REJECTED,
      lastSuccessAt: good.lastSuccessAt,
      members: 1,
      payments: 1,
    });
    expect(store.importApiMember).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status)).not.toContain(token);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Creator's Access Token"));
    expectNoToken();
  });
  it("waits for Patreon's Retry-After before calling again", async () => {
    const { service } = tracked({ PATREON_SYNC_INTERVAL_MINUTES: 10 });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
    const limited = await service.sync();
    expect(limited.lastError).toMatch(/slow down.*3600 seconds/);
    expect(Date.parse(limited.nextAttemptAt!) - Date.now()).toBeGreaterThan(3_590_000);
    await service.sync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps the last good data on network errors and unexpected responses", async () => {
    const { service, store } = tracked();
    fetchMock.mockResolvedValueOnce(onePage());
    await service.sync();
    store.importApiMember.mockClear();
    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${token}`));
    const offline = await service.sync();
    expect(offline).toMatchObject({ members: 1, tokenRejected: false });
    expect(offline.lastError).toMatch(/could not be reached.*kept/);
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: "x", type: "campaign" }] }));
    expect((await service.sync()).lastError).toMatch(/unexpected/);
    expect(store.importApiMember).not.toHaveBeenCalled();
    expectNoToken();
  });
  it("records a safe message when saving fails, without the database error", async () => {
    const { service, store } = tracked();
    store.importApiMember.mockRejectedValueOnce(new Error(`postgres://user:${token}@db failed`));
    fetchMock.mockResolvedValueOnce(onePage());
    const status = await service.sync();
    expect(status.lastError).toMatch(/could not be saved/);
    expect(JSON.stringify(status)).not.toMatch(/postgres|PRIVATE/);
    expectNoToken();
  });
  it.each([
    [{ PATREON_CREATOR_ACCESS_TOKEN: undefined }, null],
    [{ PATREON_ENABLED: false }, null],
    [{ PATREON_CAMPAIGN_ID: undefined }, null],
    [{ ADMIN_SESSION_SECRET: token }, /matches another configured secret/],
    [{ PATREON_WEBHOOK_SECRET: token }, /matches another configured secret/],
    [{ WARDOGS_SERVERS: [{ password: token }] }, /matches another configured secret/],
    [{ PATREON_CREATOR_ACCESS_TOKEN: "short" }, /does not look like/],
    [{ PATREON_CREATOR_ACCESS_TOKEN: "has whitespace inside the token" }, /does not look like/],
    [{ PATREON_CREATOR_ACCESS_TOKEN: "x".repeat(2049) }, /does not look like/],
  ])("stays unconfigured and never calls Patreon for %p", async (overrides, message) => {
    const { service } = tracked(overrides);
    service.onApplicationBootstrap();
    const status = await service.sync();
    expect(status).toMatchObject({ configured: false, lastAttemptAt: null, nextAttemptAt: null });
    if (message) expect(status.lastError).toMatch(message);
    else expect(status.lastError).toBeNull();
    expect(JSON.stringify(status)).not.toContain(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("runs once shortly after startup and then on the configured interval", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const { service } = tracked({ PATREON_SYNC_INTERVAL_MINUTES: 45 });
    fetchMock.mockImplementation(async () => onePage());
    service.onApplicationBootstrap();
    expect(Date.parse(service.status().nextAttemptAt!) - Date.now()).toBe(PATREON_SYNC_STARTUP_DELAY_MS);
    await jest.advanceTimersByTimeAsync(PATREON_SYNC_STARTUP_DELAY_MS);
    await settle(service);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({ intervalMinutes: 45, lastError: null });
    expect(Date.parse(service.status().nextAttemptAt!) - Date.now()).toBe(45 * 60_000);
    await jest.advanceTimersByTimeAsync(45 * 60_000);
    await settle(service);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(45 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
