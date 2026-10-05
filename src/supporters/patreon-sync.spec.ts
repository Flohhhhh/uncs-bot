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
  PATREON_PAGE_DELAY_MS,
  PATREON_TOKEN_REJECTED,
  PatreonApiError,
  PatreonClient,
  type PatreonPledgeEvent,
} from "./patreon.client";
import { PATREON_SYNC_STARTUP_DELAY_MS, PatreonSyncService } from "./patreon-sync.service";
import type { SupporterMatchService } from "./supporter-match.service";
import type { ApiImportResult, SupportersStore } from "./supporters.store";

const token = "creator-token-PRIVATE-0123456789abcdef";
const campaign = "16880209";
const discordId = "123456789012345678";

type EventInput = {
  id: string;
  date: string;
  status: string;
  amount?: number;
  currency?: string;
  type?: string;
  /** The event's `tier_id`, exactly as Patreon would send it. Left out, the event names no tier. */
  tier?: unknown;
};
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
      ...("tier" in input ? { tier_id: input.tier } : {}),
    },
  };
}
const tier = (id: unknown, amount: unknown) => ({ id, type: "tier", attributes: { amount_cents: amount } });
/** The campaign with its tiers, as `include=tiers&fields[tier]=amount_cents` returns it. */
function tiers(included: unknown[], id: unknown = campaign) {
  return {
    data: { id, type: "campaign", attributes: {}, relationships: { tiers: { data: [] } } },
    included,
  };
}
/** A first payment in Canadian dollars on the tier with this ID. */
const cad = (id: string, tierId: unknown = "111"): EventInput => ({
  ...start(id),
  amount: 750,
  currency: "CAD",
  tier: tierId,
});
type Paced = { pause: () => Promise<void> };
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
  tierConfirmed: 0,
  tierConfirmedNew: 0,
  tierUnconfirmed: 0,
  discordLinked: false,
  conflict: null,
  discordId: null,
  patreonDiscordChanged: false,
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
  const match = { sweep: jest.fn(async (_trigger: string) => undefined) };
  const service = new PatreonSyncService(
    new PatreonClient(),
    store as unknown as SupportersStore,
    { get: (key: string) => values[key] } as EnvService,
    roles as DiscordRolesService,
    match as unknown as SupporterMatchService,
  );
  return { service, store, roles, match };
}
let fetchMock: jest.SpyInstance;
/** The client's wait between requests, skipped here so no test waits in real time. */
let pause: jest.SpyInstance;
let warn: jest.SpyInstance;
let log: jest.SpyInstance;
const services: PatreonSyncService[] = [];
beforeEach(() => {
  // A request no test prepared fails here instead of reaching the network.
  fetchMock = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No response was prepared."));
  pause = jest.spyOn(PatreonClient.prototype as unknown as Paced, "pause").mockResolvedValue(undefined);
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
    expect(first.searchParams.get("fields[pledge-event]")).toBe(
      "amount_cents,currency_code,date,payment_status,type,tier_id",
    );
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
    // Every payment is in US dollars, so no tier prices are requested.
    expect(result.tierPrices).toBe("not_requested");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // One wait, between the two pages.
    expect(pause).toHaveBeenCalledTimes(1);
  });
  it("waits long enough between requests to stay under 100 a minute", async () => {
    pause.mockRestore();
    jest.useFakeTimers();
    const done = jest.fn();
    void (new PatreonClient() as unknown as Paced).pause().then(done);
    await jest.advanceTimersByTimeAsync(PATREON_PAGE_DELAY_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(PATREON_PAGE_DELAY_MS).toBeGreaterThan(60_000 / 100);
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
      discordKnown: true,
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
  it("ignores a malformed Discord connection instead of linking it, and reports it as unknown", async () => {
    fetchMock.mockResolvedValueOnce(
      json(page([member("member-1", [], { user: "user-1" })], [user("user-1", { user_id: "not-a-snowflake" })])),
    );
    expect((await new PatreonClient().members(campaign, token)).members[0]).toMatchObject({
      discordId: null,
      discordKnown: false,
    });
  });
  it.each([
    ["no Discord connection", [user("user-1", null)], { discordId: null, discordKnown: true }],
    [
      "a Discord connection without an ID",
      [user("user-1", { user_id: null })],
      { discordId: null, discordKnown: true },
    ],
    [
      "no connections at all",
      [{ id: "user-1", type: "user", attributes: { social_connections: null } }],
      { discordId: null, discordKnown: true },
    ],
    [
      "connections left out of the response",
      [{ id: "user-1", type: "user", attributes: {} }],
      { discordId: null, discordKnown: false },
    ],
    [
      "malformed connections",
      [{ id: "user-1", type: "user", attributes: { social_connections: "discord" } }],
      { discordId: null, discordKnown: false },
    ],
    ["a user missing from the response", [], { discordId: null, discordKnown: false }],
  ])("tells a disconnected Discord from an unreadable one: %s", async (_name, included, expected) => {
    fetchMock.mockResolvedValueOnce(json(page([member("member-1", [], { user: "user-1" })], included)));
    expect((await new PatreonClient().members(campaign, token)).members[0]).toMatchObject(expected);
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
    // The same answer to the request with the tier field and to the original request it falls back to.
    fetchMock.mockImplementation(async () => json(body));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "schema" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized responses and repeated pagination cursors", async () => {
    const oversized = async () => new Response("{}", { headers: { "Content-Length": String(9 * 1024 * 1024) } });
    fetchMock.mockImplementationOnce(oversized).mockImplementationOnce(oversized);
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "schema" });
    for (let attempt = 0; attempt < 2; attempt++)
      fetchMock
        .mockResolvedValueOnce(json(page([member("member-1")], [], "same")))
        .mockResolvedValueOnce(json(page([member("member-2")], [], "same")));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "schema" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => new Response("oops", { status: 502 }));
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

describe("Patreon tier prices", () => {
  const cadPage = (tierId: unknown = "111") =>
    json(page([member("member-1", [cad("pledge_start:1", tierId)])], [event(cad("pledge_start:1", tierId))]));
  const events = async () => (await new PatreonClient().members(campaign, token)).members[0].events;

  it("reads each paid event's tier and the campaign's tier prices with one paced, read-only request", async () => {
    fetchMock.mockResolvedValueOnce(cadPage()).mockResolvedValueOnce(json(tiers([tier("111", 500), tier("222", 300)])));
    const result = await new PatreonClient().members(campaign, token);
    expect(result).toMatchObject({ complete: true, tierPrices: "read" });
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.members[0].events).toEqual([
      expect.objectContaining({ id: "pledge_start:1", amountCents: 750, currency: "CAD", tierId: "111" }),
    ]);
    expect(result.members[0].events[0].tierAmountCents).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(`https://www.patreon.com/api/oauth2/v2/campaigns/${campaign}`);
    expect([...url.searchParams.keys()].sort()).toEqual(["fields[tier]", "include"]);
    expect(url.searchParams.get("include")).toBe("tiers");
    expect(url.searchParams.get("fields[tier]")).toBe("amount_cents");
    expect(init.method).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "User-Agent": expect.stringMatching(/UNCs/),
    });
    // One wait between the member page and the tier request, like the wait between pages.
    expect(pause).toHaveBeenCalledTimes(1);
  });
  it("does not ask for tier prices when no paid event in another currency names a tier", async () => {
    const usd = { ...start("pledge_start:1"), tier: "111" };
    const declined = { ...cad("subscription:2"), status: "Declined", type: "subscription" };
    const noTier = { ...cad("subscription:3"), type: "subscription" };
    delete noTier.tier;
    fetchMock.mockResolvedValueOnce(
      json(page([member("member-1", [usd, declined, noTier])], [event(usd), event(declined), event(noTier)])),
    );
    const result = await new PatreonClient().members(campaign, token);
    expect(result.tierPrices).toBe("not_requested");
    expect(result.members[0].events.map((item) => [item.id, item.tierId, item.tierAmountCents])).toEqual([
      ["pledge_start:1", "111", undefined],
      ["subscription:2", "111", undefined],
      ["subscription:3", undefined, undefined],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });
  it.each([
    ["a number", 111, "111"],
    ["null", null, undefined],
    ["an empty string", "", undefined],
    ["an object", { id: "111" }, undefined],
    ["text that is not an ID", "tier 111!", undefined],
    ["an overlong ID", "1".repeat(65), undefined],
  ])("reads an event's tier leniently and never rejects the page: %s", async (_name, value, expected) => {
    fetchMock.mockResolvedValueOnce(cadPage(value)).mockResolvedValueOnce(json(tiers([tier("111", 500)])));
    const [first] = await events();
    expect(first).toMatchObject({ id: "pledge_start:1", amountCents: 750, currency: "CAD" });
    expect(first.tierId).toBe(expected);
  });
  it("leaves out tiers it cannot read and events whose tier has no price", async () => {
    const known = cad("pledge_start:1", "111");
    const unknown = { ...cad("subscription:2", "999"), type: "subscription" };
    fetchMock
      .mockResolvedValueOnce(json(page([member("member-1", [known, unknown])], [event(known), event(unknown)])))
      .mockResolvedValueOnce(
        json(
          tiers([
            tier(111, 500),
            tier("222", "500"),
            tier("333", -1),
            tier("444", 5.5),
            tier({ id: "555" }, 500),
            { id: "666", type: "tier" },
            { id: "999", type: "benefit", attributes: { amount_cents: 900 } },
            "tier",
            null,
          ]),
        ),
      );
    const result = await new PatreonClient().members(campaign, token);
    expect(result.tierPrices).toBe("read");
    expect(result.members[0].events.map((item) => [item.tierId, item.tierAmountCents])).toEqual([
      ["111", 500],
      ["999", undefined],
    ]);
  });
  it.each<[string, () => unknown]>([
    ["a network error", () => Promise.reject(new TypeError(`fetch failed for ${token}`))],
    ["a server error", () => new Response("oops", { status: 502 })],
    ["a refused token", () => json({ errors: [{ detail: token }] }, { status: 403 })],
    ["a refused request", () => json({ errors: [{ detail: "bad include" }] }, { status: 400 })],
    ["a missing campaign", () => json({}, { status: 404 })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["an unexpected body", () => json({ data: [], included: [tier("111", 500)] })],
    ["another campaign's tiers", () => json(tiers([tier("111", 500)], "999"))],
    ["an oversized body", () => new Response("{}", { headers: { "Content-Length": String(2 * 1024 * 1024) } })],
  ])("keeps the whole member list when the tier request ends in %s", async (_name, response) => {
    fetchMock.mockResolvedValueOnce(cadPage()).mockImplementationOnce(async () => response());
    const result = await new PatreonClient().members(campaign, token);
    expect(result).toMatchObject({ complete: true, tierPrices: "unavailable" });
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({ patreonMemberId: "member-1", historyComplete: true });
    expect(result.members[0].events[0]).toMatchObject({ id: "pledge_start:1", tierId: "111" });
    expect(result.members[0].events[0].tierAmountCents).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("reports Patreon's wait when only the tier request is rate limited", async () => {
    fetchMock
      .mockResolvedValueOnce(cadPage())
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "90" } }));
    const result = await new PatreonClient().members(campaign, token);
    expect(result).toMatchObject({ tierPrices: "unavailable", retryAfterMs: 90_000 });
    expect(result.members).toHaveLength(1);
  });
  it("repeats the sync with the original request when Patreon refuses the tier field", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ errors: [{ status: "400", detail: `Invalid field for ${token}` }] }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        json(page([member("member-1", [cad("pledge_start:1")])], [event(cad("pledge_start:1"))], "cursor-2")),
      )
      .mockResolvedValueOnce(
        json(page([member("member-2", [start("pledge_start:2")])], [event(start("pledge_start:2"))])),
      );
    const result = await new PatreonClient().members(campaign, token);
    expect(result).toMatchObject({ complete: true, tierPrices: "refused" });
    expect(result.members.map((item) => item.patreonMemberId)).toEqual(["member-1", "member-2"]);
    // No tier is read from a request that did not ask for one, and no tier prices are requested.
    expect(result.members.flatMap((item) => item.events).map((item) => item.tierId ?? null)).toEqual([null, null]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([url]) => url as URL);
    expect(urls.map((url) => url.pathname)).toEqual(Array(3).fill(`/api/oauth2/v2/campaigns/${campaign}/members`));
    expect(urls.map((url) => url.searchParams.get("fields[pledge-event]"))).toEqual([
      "amount_cents,currency_code,date,payment_status,type,tier_id",
      "amount_cents,currency_code,date,payment_status,type",
      "amount_cents,currency_code,date,payment_status,type",
    ]);
    // The repeated request is the one the import sent before tiers were read.
    expect([...urls[1].searchParams.entries()]).toEqual([
      ["include", "user,pledge_history"],
      ["fields[member]", "full_name,patron_status,last_charge_status,last_charge_date"],
      ["fields[user]", "social_connections"],
      ["fields[pledge-event]", "amount_cents,currency_code,date,payment_status,type"],
      ["page[count]", "50"],
    ]);
    expect(urls[2].searchParams.get("page[cursor]")).toBe("cursor-2");
    // Paced before the repeat and between its pages.
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it.each<[string, () => Response]>([
    ["a server error", () => new Response("oops", { status: 500 })],
    ["an unavailable service", () => new Response("", { status: 503 })],
    ["an unexpected status", () => new Response("", { status: 422 })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a member list it cannot use", () => json({ data: [{ id: "x", type: "campaign" }] })],
    ["an oversized page", () => new Response("{}", { headers: { "Content-Length": String(9 * 1024 * 1024) } })],
  ])("also repeats the sync with the original request after %s", async (_name, failure) => {
    fetchMock
      .mockImplementationOnce(async () => failure())
      .mockResolvedValueOnce(json(page([member("member-1", [cad("pledge_start:1")])], [event(cad("pledge_start:1"))])));
    const result = await new PatreonClient().members(campaign, token);
    expect(result).toMatchObject({ complete: true, tierPrices: "refused" });
    expect(result.members.map((item) => item.patreonMemberId)).toEqual(["member-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, repeated] = fetchMock.mock.calls.map(([url]) => url as URL);
    expect(repeated.searchParams.get("fields[pledge-event]")).toBe(
      "amount_cents,currency_code,date,payment_status,type",
    );
    expect(pause).toHaveBeenCalledTimes(1);
  });
  it("fails as before when Patreon also refuses the original request", async () => {
    fetchMock.mockImplementation(async () => json({ errors: [{ status: "400" }] }, { status: 400 }));
    await expect(new PatreonClient().members(campaign, token)).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each<[string, () => unknown]>([
    ["a refused token (401)", () => json({}, { status: 401 })],
    ["a refused token (403)", () => json({}, { status: 403 })],
    ["a missing campaign", () => json({}, { status: 404 })],
    ["a rate limit", () => json({}, { status: 429 })],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("does not repeat the member request after %s", async (_name, failure) => {
    fetchMock.mockImplementationOnce(async () => failure());
    await expect(new PatreonClient().members(campaign, token)).rejects.toBeInstanceOf(PatreonApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
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
    // A declined refund still means an earlier charge was taken.
    for (const status of [
      "Refunded",
      "Partially Refunded",
      "Fraud",
      "Refunded by Patreon",
      "Refund Pending",
      "Refund Declined",
      "Other",
    ])
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
  it("counts who Patreon reported a Discord account for and who has a completed payment", async () => {
    const { service } = tracked();
    const declined = { ...start("pledge_start:3"), status: "Declined" };
    fetchMock.mockResolvedValueOnce(
      json(
        page(
          [
            member("member-1", [start("pledge_start:1")], { user: "user-1" }),
            member("member-2", [start("pledge_start:2")], { user: "user-2" }),
            member("member-3", [declined], { user: "user-3" }),
            member("member-4"),
          ],
          [
            event(start("pledge_start:1")),
            event(start("pledge_start:2")),
            event(declined),
            user("user-1"),
            user("user-2", null),
            user("user-3", null),
          ],
        ),
      ),
    );
    expect(await service.sync()).toMatchObject({ members: 4, paidMembers: 2, discordReported: 1 });
    // The live case: paying members, and Patreon reports a Discord account for none of them.
    fetchMock.mockResolvedValueOnce(
      json(
        page(
          [member("member-1", [start("pledge_start:1")], { user: "user-1" })],
          [event(start("pledge_start:1")), user("user-1", null)],
        ),
      ),
    );
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect(await service.sync()).toMatchObject({ members: 1, paidMembers: 1, discordReported: 0 });
  });
  it("hands each payment's tier price to the store and reports what it counted, logging the result once", async () => {
    const { service, store } = tracked();
    const cadSync = () =>
      fetchMock
        .mockResolvedValueOnce(
          json(page([member("member-1", [cad("pledge_start:1")])], [event(cad("pledge_start:1"))])),
        )
        .mockResolvedValueOnce(json(tiers([tier("111", 500)])));
    cadSync();
    store.importApiMember.mockResolvedValueOnce(
      imported({ created: false, payments: 0, tierConfirmed: 2, tierConfirmedNew: 1, tierUnconfirmed: 1 }),
    );
    const status = await service.sync();
    expect(status).toMatchObject({
      lastError: null,
      tierPrices: "read",
      tierConfirmed: 2,
      tierConfirmedNew: 1,
      tierUnconfirmed: 1,
    });
    const [, snapshot] = store.importApiMember.mock.calls[0] as [string, { events: PatreonPledgeEvent[] }];
    expect(snapshot.events).toEqual([
      expect.objectContaining({ currency: "CAD", tierId: "111", tierAmountCents: 500 }),
    ]);
    // Nothing else changed, and the counted payment alone is logged.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "2 other-currency payments counted by tier price (1 new), 1 not confirmed, tier prices read.",
      ),
    );
    // The same result on the next sync is not logged again.
    cadSync();
    store.importApiMember.mockResolvedValueOnce(
      imported({ created: false, payments: 0, tierConfirmed: 2, tierConfirmedNew: 0, tierUnconfirmed: 1 }),
    );
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect(await service.sync()).toMatchObject({ tierConfirmed: 2, tierConfirmedNew: 0, tierUnconfirmed: 1 });
    expect(log).toHaveBeenCalledTimes(1);
    expectNoToken();
  });
  it("imports every member and logs why when tier prices could not be read", async () => {
    const { service, store } = tracked();
    fetchMock
      .mockResolvedValueOnce(json(page([member("member-1", [cad("pledge_start:1")])], [event(cad("pledge_start:1"))])))
      .mockResolvedValueOnce(json({ errors: [{ detail: `tiers failed for ${token}` }] }, { status: 500 }));
    store.importApiMember.mockResolvedValueOnce(imported({ created: false, payments: 0, tierUnconfirmed: 1 }));
    const status = await service.sync();
    expect(status).toMatchObject({
      lastError: null,
      tokenRejected: false,
      members: 1,
      tierPrices: "unavailable",
      tierConfirmed: 0,
      tierUnconfirmed: 1,
    });
    expect(status.lastSuccessAt).not.toBeNull();
    expect(store.importApiMember).toHaveBeenCalledTimes(1);
    const [, snapshot] = store.importApiMember.mock.calls[0] as [string, { events: PatreonPledgeEvent[] }];
    expect(snapshot.events[0].tierAmountCents).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "0 other-currency payments counted by tier price (0 new), 1 not confirmed, tier prices unavailable.",
      ),
    );
    expect(warn).not.toHaveBeenCalled();
    expectNoToken();
  });
  it("imports with the original request when Patreon refuses the tier field", async () => {
    const { service, store } = tracked();
    fetchMock
      .mockResolvedValueOnce(json({ errors: [{ status: "400" }] }, { status: 400 }))
      .mockResolvedValueOnce(onePage());
    const status = await service.sync();
    expect(status).toMatchObject({ lastError: null, members: 1, newMembers: 1, payments: 1, tierPrices: "refused" });
    expect(store.importApiMember).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("finishes the import and waits for Patreon when only the tier request is rate limited", async () => {
    const { service, store } = tracked({ PATREON_SYNC_INTERVAL_MINUTES: 10 });
    fetchMock
      .mockResolvedValueOnce(json(page([member("member-1", [cad("pledge_start:1")])], [event(cad("pledge_start:1"))])))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
    const status = await service.sync();
    expect(status).toMatchObject({ lastError: null, members: 1, tierPrices: "unavailable" });
    expect(store.importApiMember).toHaveBeenCalledTimes(1);
    expect(Date.parse(status.nextAttemptAt!) - Date.now()).toBeGreaterThan(3_590_000);
    await service.sync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("runs automatic supporter matching after the import and before the founder reviews, without changing the status", async () => {
    const { service, store, match } = tracked();
    fetchMock.mockResolvedValueOnce(onePage());
    match.sweep.mockImplementationOnce(async () => {
      throw new Error("never rejects in production");
    });
    const failing = await service.sync();
    // A sweep failure is reported by the match service, never as a failed sync.
    expect(failing).toMatchObject({ lastError: expect.any(String) });
    fetchMock.mockResolvedValueOnce(onePage());
    match.sweep.mockResolvedValueOnce(undefined);
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const status = await service.sync();
    expect(status).toMatchObject({ lastError: null, members: 1 });
    expect(match.sweep).toHaveBeenLastCalledWith("sync");
    const order = (mock: jest.Mock) => mock.mock.invocationCallOrder.at(-1)!;
    expect(order(store.importApiMember)).toBeLessThan(order(match.sweep));
    expect(order(match.sweep)).toBeLessThan(order(store.founderReviews));
  });
  it("skips automatic matching after a failed import or a shutdown mid-sync", async () => {
    const failed = tracked();
    fetchMock.mockResolvedValueOnce(json({}, { status: 503 }));
    await failed.service.sync();
    expect(failed.match.sweep).not.toHaveBeenCalled();
    const stopped = tracked();
    fetchMock.mockResolvedValueOnce(onePage());
    stopped.store.importApiMember.mockImplementationOnce(async () => {
      stopped.service.onModuleDestroy();
      return imported();
    });
    await stopped.service.sync();
    expect(stopped.match.sweep).not.toHaveBeenCalled();
    expect(stopped.store.founderReviews).not.toHaveBeenCalled();
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
    // The request with the tier field and the original request it falls back to get the same unusable answer.
    for (let attempt = 0; attempt < 2; attempt++)
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
