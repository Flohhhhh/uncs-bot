import { Global, Logger, Module, type INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Client } from "discord.js";
import request from "supertest";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { AppExceptionFilter } from "../common/filters/app-exception.filter";
import { DATABASE } from "../database/database.types";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import { PatreonSyncService } from "../supporters/patreon-sync.service";
import { SupporterMatchService } from "../supporters/supporter-match.service";
import { SupporterMatchStore } from "../supporters/supporter-match.store";
import { SupportersService } from "../supporters/supporters.service";
import { SupportersStore } from "../supporters/supporters.store";
import { PATRON_LINK_CSP, PatronLinkModule } from "./patron-link.module";
import { PATRON_LINK_FAILED } from "./patron-link.service";
import { PATRON_LINK_LEGS_PER_ACCOUNT, PATRON_LINK_TICKET_MS, PatronLinkState } from "./patron-link.state";
import { PatronLinkStore } from "./patron-link.store";

const ORIGIN = "https://admin.theuncs.example";
const GUILD = "200000000000000001";
const PATRON = "500000000000000001";
const STRANGER = "500000000000000002";
const CAMPAIGN = "16880209";
const MEMBER = "a1b2c3d4-0000-4000-8000-000000000001";
const PATREON_USER = "98765432";
const RECORD = "00000000-0000-4000-8000-0000000000c1";
const DISCORD_CLIENT_ID = "600000000000000001";
const PATREON_CLIENT_ID = "patreon-client-id-0123456789";
const SECRETS = {
  creator: "creator-token-PRIVATE-0123456789",
  patreonClient: "patreon-client-PRIVATE-0123456789",
  discordClient: "discord-client-PRIVATE-0123456789",
  session: "session-PRIVATE-".padEnd(40, "s"),
  webhook: "patreon-webhook-PRIVATE-0123456789",
  bot: "discord-bot-PRIVATE-0123456789",
  discordAccess: "discord-access-PRIVATE-0123456789",
  discordRefresh: "discord-refresh-PRIVATE-0123456789",
  patreonAccess: "patreon-access-PRIVATE-0123456789",
  patreonRefresh: "patreon-refresh-PRIVATE-0123456789",
  discordCode: "discord-code-PRIVATE-0123456789",
  patreonCode: "patreon-code-PRIVATE-0123456789",
};
const values: Record<string, unknown> = {};
function reset(overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(values)) delete values[key];
  Object.assign(values, {
    PATREON_LINK_ENABLED: true,
    PATREON_ENABLED: true,
    PATREON_CAMPAIGN_ID: CAMPAIGN,
    PATREON_CREATOR_ACCESS_TOKEN: SECRETS.creator,
    PATREON_WEBHOOK_SECRET: SECRETS.webhook,
    PATREON_CLIENT_ID,
    PATREON_CLIENT_SECRET: SECRETS.patreonClient,
    ADMIN_ORIGIN: ORIGIN,
    ADMIN_DISCORD_CLIENT_ID: DISCORD_CLIENT_ID,
    ADMIN_DISCORD_CLIENT_SECRET: SECRETS.discordClient,
    ADMIN_SESSION_SECRET: SECRETS.session,
    ADMIN_GUILD_ID: GUILD,
    ADMIN_OWNER_IDS: "",
    ADMIN_ADMIN_ROLE_IDS: "",
    ADMIN_MODERATOR_ROLE_IDS: "",
    ADMIN_VIEWER_ROLE_IDS: "",
    DISCORD_ROLES_ENABLED: true,
    DISCORD_SUPPORTER_ROLE_ID: "300000000000000009",
    DISCORD_BOT_TOKEN: SECRETS.bot,
    DATABASE_URL: "postgres://localhost/unused",
    NEST_ENV: "production",
    ...overrides,
  });
}

@Global()
@Module({
  providers: [
    { provide: EnvService, useValue: { get: (key: string) => values[key] } },
    { provide: Client, useValue: {} },
    { provide: DATABASE, useValue: {} },
  ],
  exports: [EnvService, Client, DATABASE],
})
class TestDependenciesModule {}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** One member as Patreon's member endpoint returns it, with its user and campaign. */
function patreonMember(campaignId = CAMPAIGN, userId = PATREON_USER) {
  return {
    data: {
      id: MEMBER,
      type: "member",
      attributes: {
        full_name: "Patron",
        patron_status: "active_patron",
        last_charge_status: "Paid",
        last_charge_date: "2026-10-01T12:00:00.000+00:00",
      },
      relationships: {
        user: { data: { id: userId, type: "user" } },
        campaign: { data: { id: campaignId, type: "campaign" } },
        pledge_history: { data: [{ id: "pledge_start:1", type: "pledge-event" }] },
      },
    },
    included: [
      { id: userId, type: "user", attributes: { social_connections: null } },
      { id: campaignId, type: "campaign" },
      {
        id: "pledge_start:1",
        type: "pledge-event",
        attributes: {
          amount_cents: 500,
          currency_code: "USD",
          date: "2026-10-01T12:00:00.000+00:00",
          payment_status: "Paid",
          type: "pledge_start",
        },
      },
    ],
  };
}
type Upstream = "discordToken" | "discordUser" | "patreonToken" | "identity" | "member";
function upstreamOf(url: string): Upstream {
  if (url === "https://discord.com/api/v10/oauth2/token") return "discordToken";
  if (url === "https://discord.com/api/v10/users/@me") return "discordUser";
  if (url === "https://www.patreon.com/api/oauth2/token") return "patreonToken";
  if (url.startsWith("https://www.patreon.com/api/oauth2/v2/identity?")) return "identity";
  if (url.startsWith(`https://www.patreon.com/api/oauth2/v2/members/${MEMBER}?`)) return "member";
  throw new Error("Unexpected upstream request.");
}

describe("Link Patreon sign-in pages", () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication["getHttpServer"]>;
  let state: PatronLinkState;
  let answers: Record<Upstream, () => Response | Promise<Response>>;
  let fetchMock: jest.SpyInstance;
  let logged: jest.SpyInstance[];
  const store = { link: jest.fn(), linked: jest.fn() };
  const supporters = { importApiMember: jest.fn() };
  const roles = { supporterChanged: jest.fn() };
  const match = { member: jest.fn() };
  const sync = { configured: jest.fn() };
  const calls = (upstream: Upstream) =>
    fetchMock.mock.calls.filter(([url]) => upstreamOf(String(url)) === upstream) as [string, RequestInit][];
  const messages = () => logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  async function boot(overrides: Record<string, unknown> = {}) {
    reset(overrides);
    const module = await Test.createTestingModule({
      imports: [TestDependenciesModule, PatronLinkModule],
      providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
    })
      .overrideProvider(PatronLinkStore)
      .useValue(store)
      .overrideProvider(SupportersStore)
      .useValue(supporters)
      .overrideProvider(SupportersService)
      .useValue({ signedWebhook: () => false })
      .overrideProvider(PatreonSyncService)
      .useValue(sync)
      .overrideProvider(DiscordRolesService)
      .useValue(roles)
      .overrideProvider(SupporterMatchService)
      .useValue(match)
      .overrideProvider(SupporterMatchStore)
      .useValue({})
      .overrideProvider(AdminStore)
      .useValue({})
      .overrideProvider(WardogsClient)
      .useValue({})
      .compile();
    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer();
    state = app.get(PatronLinkState, { strict: false });
    for (const spy of logged) spy.mockClear();
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    store.link.mockResolvedValue({ outcome: "linked", memberId: RECORD });
    store.linked.mockResolvedValue(false);
    supporters.importApiMember.mockResolvedValue({ memberId: RECORD, discordId: null, created: false, updated: false });
    match.member.mockResolvedValue(null);
    sync.configured.mockReturnValue(true);
    answers = {
      discordToken: () =>
        json({ access_token: SECRETS.discordAccess, refresh_token: SECRETS.discordRefresh, token_type: "Bearer" }),
      discordUser: () => json({ id: PATRON, username: "patron", global_name: "Patron", email: "private@example.test" }),
      patreonToken: () =>
        json({ access_token: SECRETS.patreonAccess, refresh_token: SECRETS.patreonRefresh, token_type: "Bearer" }),
      identity: () =>
        json({
          data: {
            id: PATREON_USER,
            type: "user",
            relationships: { memberships: { data: [{ id: MEMBER, type: "member" }] } },
          },
        }),
      member: () => json(patreonMember()),
    };
    fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: string | URL | Request) => answers[upstreamOf(String(url))]());
    logged = (["log", "warn", "error", "debug", "verbose"] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    await boot();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  function ticket(discordId = PATRON, at = Date.now()) {
    const issued = state.issueTicket(discordId, at);
    if (!("ticket" in issued)) throw new Error("No ticket was issued.");
    return issued.ticket;
  }
  const cookieOf = (response: request.Response) => {
    const header = ([] as string[]).concat(response.headers["set-cookie"] ?? []);
    return header.find((cookie) => cookie.startsWith("__Host-uncs_patron_link="))?.split(";")[0] ?? "";
  };
  const stateOf = (location: string) => new URL(location).searchParams.get("state")!;
  /** Starts a sign-in and comes back from Discord. Returns the cookie and the Patreon page it was sent to. */
  async function throughDiscord(discordId = PATRON) {
    const start = await request(server)
      .get(`/supporters/link/start?t=${ticket(discordId)}`)
      .expect(303);
    const cookie = cookieOf(start);
    const back = await request(server)
      .get(`/supporters/link/discord/callback?code=${SECRETS.discordCode}&state=${stateOf(start.headers.location)}`)
      .set("Cookie", cookie)
      .expect(303);
    return { cookie, back, start };
  }
  async function throughPatreon(discordId = PATRON) {
    const { cookie, back } = await throughDiscord(discordId);
    const url = `/supporters/link/patreon/callback?code=${SECRETS.patreonCode}&state=${stateOf(back.headers.location)}`;
    const done = await request(server).get(url).set("Cookie", cookie).expect(303);
    return { cookie, url, done, back };
  }

  describe("with linking switched off", () => {
    beforeEach(() => boot({ PATREON_LINK_ENABLED: false }));
    it("says off on every page, calling nobody and setting no cookie", async () => {
      for (const path of [
        `/supporters/link/start?t=${"a".repeat(43)}`,
        `/supporters/link/discord/callback?code=x&state=${"a".repeat(43)}`,
        `/supporters/link/patreon/callback?code=x&state=${"a".repeat(43)}`,
      ]) {
        const response = await request(server)
          .get(path)
          .set("Cookie", `__Host-uncs_patron_link=${"b".repeat(43)}`);
        expect(response.status).toBe(303);
        expect(response.headers.location).toBe("/supporters/link/done?r=off");
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      const page = await request(server).get("/supporters/link/done?r=off").expect(200);
      expect(page.text).toContain("<h1>Linking is off</h1>");
      expect(page.text).toContain("<p>Nothing changed.</p>");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.link).not.toHaveBeenCalled();
    });
  });

  describe("the start page", () => {
    it("spends the ticket and sends the patron to Discord with exactly these parameters and a locked-down cookie", async () => {
      const response = await request(server).get(`/supporters/link/start?t=${ticket()}`).expect(303);
      const location = new URL(response.headers.location);
      expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
      expect([...location.searchParams.entries()]).toEqual([
        ["client_id", DISCORD_CLIENT_ID],
        ["redirect_uri", `${ORIGIN}/supporters/link/discord/callback`],
        ["response_type", "code"],
        ["scope", "identify"],
        ["state", expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)],
        ["prompt", "none"],
      ]);
      const [cookie] = ([] as string[]).concat(response.headers["set-cookie"]);
      expect(cookie).toMatch(
        /^__Host-uncs_patron_link=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/,
      );
      // The cookie and the state are different random values; neither names the account.
      expect(cookieOf(response).split("=")[1]).not.toBe(location.searchParams.get("state"));
      expect(response.headers.location).not.toContain(PATRON);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(messages()).toEqual([]);
    });
    it.each([
      ["no ticket", ""],
      ["a malformed ticket", "?t=short"],
      ["an unknown ticket", `?t=${"a".repeat(43)}`],
      ["two tickets", `?t=${"a".repeat(43)}&t=${"b".repeat(43)}`],
    ])("says expired for %s", async (_name, query) => {
      const response = await request(server).get(`/supporters/link/start${query}`).expect(303);
      expect(response.headers.location).toBe("/supporters/link/done?r=expired");
      expect(response.headers["set-cookie"]).toBeUndefined();
    });
    it("says expired for a ticket used before or 10 minutes old", async () => {
      const used = ticket();
      await request(server).get(`/supporters/link/start?t=${used}`).expect(303);
      const again = await request(server).get(`/supporters/link/start?t=${used}`).expect(303);
      expect(again.headers.location).toBe("/supporters/link/done?r=expired");
      const old = ticket(PATRON, Date.now() - PATRON_LINK_TICKET_MS);
      const stale = await request(server).get(`/supporters/link/start?t=${old}`).expect(303);
      expect(stale.headers.location).toBe("/supporters/link/done?r=expired");
      expect(messages()).toEqual(["Patron link finished: expired", "Patron link finished: expired"]);
    });
    it("says unavailable while the setup is incomplete", async () => {
      await boot({ PATREON_CLIENT_SECRET: SECRETS.creator });
      const response = await request(server).get(`/supporters/link/start?t=${ticket()}`).expect(303);
      expect(response.headers.location).toBe("/supporters/link/done?r=unavailable");
    });
  });

  describe("Discord's redirect", () => {
    it("calls nobody without the cookie, or with a wrong or missing state, and ends the sign-in", async () => {
      const start = await request(server).get(`/supporters/link/start?t=${ticket()}`).expect(303);
      const cookie = cookieOf(start);
      const good = stateOf(start.headers.location);
      for (const [query, withCookie] of [
        [`code=x&state=${good}`, false],
        [`code=x&state=${"z".repeat(43)}`, true],
        ["code=x", true],
        [`code=x&state=${good}`, true],
      ] as const) {
        const call = request(server).get(`/supporters/link/discord/callback?${query}`);
        const response = await (withCookie ? call.set("Cookie", cookie) : call).expect(303);
        expect(response.headers.location).toBe("/supporters/link/done?r=expired");
      }
      // The wrong state ended the sign-in, so even the right one fails afterwards.
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("says declined when the patron says no on Discord", async () => {
      const start = await request(server).get(`/supporters/link/start?t=${ticket()}`).expect(303);
      const response = await request(server)
        .get(`/supporters/link/discord/callback?error=access_denied&state=${stateOf(start.headers.location)}`)
        .set("Cookie", cookieOf(start))
        .expect(303);
      expect(response.headers.location).toBe("/supporters/link/done?r=declined");
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("asks Discord once more with its Authorize screen when skipping it fails, then gives up", async () => {
      const start = await request(server).get(`/supporters/link/start?t=${ticket()}`).expect(303);
      const cookie = cookieOf(start);
      const first = stateOf(start.headers.location);
      const retry = await request(server)
        .get(`/supporters/link/discord/callback?error=consent_required&state=${first}`)
        .set("Cookie", cookie)
        .expect(303);
      const again = new URL(retry.headers.location);
      expect(again.origin + again.pathname).toBe("https://discord.com/oauth2/authorize");
      expect(again.searchParams.has("prompt")).toBe(false);
      expect(again.searchParams.get("state")).not.toBe(first);
      const failed = await request(server)
        .get(`/supporters/link/discord/callback?error=server_error&state=${again.searchParams.get("state")}`)
        .set("Cookie", cookie)
        .expect(303);
      expect(failed.headers.location).toBe("/supporters/link/done?r=unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([
      [400, "expired"],
      [401, "expired"],
      [500, "unavailable"],
      [503, "unavailable"],
    ])("says %s from Discord's token endpoint is %s", async (status, outcome) => {
      answers.discordToken = () => json({ error: "invalid_grant", detail: SECRETS.discordCode }, status);
      const { back } = await throughDiscord();
      expect(back.headers.location).toBe(`/supporters/link/done?r=${outcome}`);
      expect(calls("discordUser")).toHaveLength(0);
    });
    it("sends the code once, with the client secret, only to Discord", async () => {
      await throughDiscord();
      const [[, init]] = calls("discordToken");
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        client_id: DISCORD_CLIENT_ID,
        client_secret: SECRETS.discordClient,
        grant_type: "authorization_code",
        code: SECRETS.discordCode,
        redirect_uri: `${ORIGIN}/supporters/link/discord/callback`,
      });
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const [[, user]] = calls("discordUser");
      expect(user.headers).toMatchObject({ Authorization: `Bearer ${SECRETS.discordAccess}` });
    });
    it("says wrong account when someone else, or a bot, signs in to a forwarded link, before Patreon", async () => {
      for (const account of [
        { id: STRANGER, username: "stranger" },
        { id: PATRON, username: "bot", bot: true },
      ]) {
        answers.discordUser = () => json(account);
        const { back } = await throughDiscord();
        expect(back.headers.location).toBe("/supporters/link/done?r=wrong_account");
      }
      expect(calls("patreonToken")).toHaveLength(0);
    });
    it("sends the patron to Patreon for the identity scope only, with a new state", async () => {
      const { back, start } = await throughDiscord();
      const location = new URL(back.headers.location);
      expect(location.origin + location.pathname).toBe("https://www.patreon.com/oauth2/authorize");
      expect([...location.searchParams.entries()]).toEqual([
        ["response_type", "code"],
        ["client_id", PATREON_CLIENT_ID],
        ["redirect_uri", `${ORIGIN}/supporters/link/patreon/callback`],
        ["scope", "identity"],
        ["state", expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)],
      ]);
      expect(location.searchParams.get("state")).not.toBe(stateOf(start.headers.location));
      expect(cookieOf(back)).toBe(cookieOf(start));
    });
    it("says busy after 5 Patreon legs for one account in 10 minutes", async () => {
      // Tickets are limited to 5 too, so the fifth leg is counted directly.
      for (let leg = 0; leg < PATRON_LINK_LEGS_PER_ACCOUNT - 1; leg++)
        expect(new URL((await throughDiscord()).back.headers.location).host).toBe("www.patreon.com");
      expect(state.startLeg(PATRON)).toBe(true);
      expect((await throughDiscord()).back.headers.location).toBe("/supporters/link/done?r=busy");
    });
  });

  describe("Patreon's redirect", () => {
    it("links the patron, then checks their roles and runs matching", async () => {
      const { done } = await throughPatreon();
      expect(done.headers.location).toBe("/supporters/link/done?r=linked");
      expect(calls("identity")).toHaveLength(1);
      const [[identityUrl, identity]] = calls("identity");
      expect(identityUrl).toBe("https://www.patreon.com/api/oauth2/v2/identity?include=memberships");
      expect(identity.headers).toMatchObject({ Authorization: `Bearer ${SECRETS.patreonAccess}` });
      const [[memberUrl, member]] = calls("member");
      expect(new URL(memberUrl).pathname).toBe(`/api/oauth2/v2/members/${MEMBER}`);
      expect(member.headers).toMatchObject({ Authorization: `Bearer ${SECRETS.creator}` });
      expect(supporters.importApiMember).toHaveBeenCalledWith(
        CAMPAIGN,
        expect.objectContaining({ patreonMemberId: MEMBER, patronStatus: "active_patron" }),
        expect.any(Date),
      );
      expect(store.link).toHaveBeenCalledWith({
        campaignId: CAMPAIGN,
        patreonMemberId: MEMBER,
        discordId: PATRON,
        now: expect.any(Date),
      });
      expect(supporters.importApiMember.mock.invocationCallOrder[0]).toBeLessThan(
        store.link.mock.invocationCallOrder[0],
      );
      expect(roles.supporterChanged).toHaveBeenCalledWith(PATRON);
      expect(match.member).toHaveBeenCalledWith(RECORD, "patron");
      const [[, token]] = calls("patreonToken");
      expect(Object.fromEntries(new URLSearchParams(String(token.body)))).toEqual({
        code: SECRETS.patreonCode,
        grant_type: "authorization_code",
        client_id: PATREON_CLIENT_ID,
        client_secret: SECRETS.patreonClient,
        redirect_uri: `${ORIGIN}/supporters/link/patreon/callback`,
      });
    });
    it.each([
      [{ outcome: "linked", memberId: RECORD }, "linked"],
      [{ outcome: "pending", memberId: RECORD }, "pending"],
      [{ outcome: "already", memberId: RECORD }, "already"],
      [{ outcome: "conflict", conflict: "membership_linked", memberId: RECORD }, "conflict"],
      [{ outcome: "conflict", conflict: "discord_linked", memberId: RECORD }, "conflict"],
      [{ outcome: "conflict", conflict: "founder_tie", memberId: RECORD }, "conflict"],
    ])("shows the store's answer %p as %s, and checks roles only for a link", async (result, outcome) => {
      store.link.mockResolvedValue(result);
      const { done } = await throughPatreon();
      expect(done.headers.location).toBe(`/supporters/link/done?r=${outcome}`);
      const linked = outcome !== "conflict";
      expect(roles.supporterChanged).toHaveBeenCalledTimes(linked ? 1 : 0);
      expect(match.member).toHaveBeenCalledTimes(linked ? 1 : 0);
    });
    it("spends an unmatched code at Patreon once, and reads no identity", async () => {
      const response = await request(server)
        .get(`/supporters/link/patreon/callback?code=${SECRETS.patreonCode}&state=${"a".repeat(43)}`)
        .expect(303);
      expect(response.headers.location).toBe("/supporters/link/done?r=expired");
      expect(calls("patreonToken")).toHaveLength(1);
      expect(Object.fromEntries(new URLSearchParams(String(calls("patreonToken")[0][1].body)))).toMatchObject({
        code: SECRETS.patreonCode,
        client_id: PATREON_CLIENT_ID,
      });
      expect(calls("identity")).toHaveLength(0);
      expect(store.link).not.toHaveBeenCalled();
      // A failed spend changes nothing.
      answers.patreonToken = () => Promise.reject(new Error("network"));
      await request(server)
        .get(`/supporters/link/patreon/callback?code=other&state=${"a".repeat(43)}`)
        .expect(303)
        .expect("Location", "/supporters/link/done?r=expired");
    });
    it("spends a code that comes back with the Discord leg's state, or in another browser", async () => {
      const { cookie, back, start } = await throughDiscord();
      for (const [state, withCookie] of [
        [stateOf(start.headers.location), true],
        [stateOf(back.headers.location), false],
      ] as const) {
        const call = request(server).get(
          `/supporters/link/patreon/callback?code=${SECRETS.patreonCode}&state=${state}`,
        );
        await (withCookie ? call.set("Cookie", cookie) : call)
          .expect(303)
          .expect("Location", "/supporters/link/done?r=expired");
      }
      expect(calls("patreonToken")).toHaveLength(2);
      expect(calls("identity")).toHaveLength(0);
    });
    it("works once: a replayed redirect finds nothing", async () => {
      const { cookie, url } = await throughPatreon();
      const replay = await request(server).get(url).set("Cookie", cookie).expect(303);
      expect(replay.headers.location).toBe("/supporters/link/done?r=expired");
      expect(calls("identity")).toHaveLength(1);
      expect(store.link).toHaveBeenCalledTimes(1);
    });
    it("says declined, or unavailable for any other Patreon error, ending the sign-in", async () => {
      for (const [error, outcome] of [
        ["access_denied", "declined"],
        ["server_error", "unavailable"],
      ]) {
        const { cookie, back } = await throughDiscord();
        const response = await request(server)
          .get(`/supporters/link/patreon/callback?error=${error}&state=${stateOf(back.headers.location)}`)
          .set("Cookie", cookie)
          .expect(303);
        expect(response.headers.location).toBe(`/supporters/link/done?r=${outcome}`);
      }
      expect(calls("patreonToken")).toHaveLength(0);
    });
    it.each([
      ["a refused code", "patreonToken", () => json({ error: "invalid_grant" }, 401), "expired"],
      ["a bad request", "patreonToken", () => json({ error: "invalid_request" }, 400), "expired"],
      ["a token outage", "patreonToken", () => json({}, 502), "unavailable"],
      ["an identity outage", "identity", () => json({}, 500), "unavailable"],
      ["an unreadable identity", "identity", () => new Response("not json"), "unavailable"],
      ["an oversized identity", "identity", () => new Response(" ".repeat(65_537)), "unavailable"],
    ] as const)("says %s is %s and links nothing", async (_name, upstream, answer, outcome) => {
      answers[upstream] = answer;
      const { done } = await throughPatreon();
      expect(done.headers.location).toBe(`/supporters/link/done?r=${outcome}`);
      expect(store.link).not.toHaveBeenCalled();
    });
    it("says not a member for no membership, and unavailable for two", async () => {
      const identity = (memberships: unknown[]) => () =>
        json({ data: { id: PATREON_USER, type: "user", relationships: { memberships: { data: memberships } } } });
      answers.identity = identity([]);
      expect((await throughPatreon()).done.headers.location).toBe("/supporters/link/done?r=not_member");
      answers.identity = identity([
        { id: MEMBER, type: "member" },
        { id: "a1b2c3d4-0000-4000-8000-000000000002", type: "member" },
      ]);
      expect((await throughPatreon()).done.headers.location).toBe("/supporters/link/done?r=unavailable");
      expect(calls("member")).toHaveLength(0);
      expect(store.link).not.toHaveBeenCalled();
    });
    it.each([
      ["Patreon has no such member", () => json({ errors: [] }, 404)],
      ["the member is another campaign's", () => json(patreonMember("999"))],
      ["the member is another patron's", () => json(patreonMember(CAMPAIGN, "11111111"))],
    ])("writes nothing when %s", async (_name, answer) => {
      answers.member = answer;
      expect((await throughPatreon()).done.headers.location).toBe("/supporters/link/done?r=not_member");
      expect(supporters.importApiMember).not.toHaveBeenCalled();
      expect(store.link).not.toHaveBeenCalled();
      expect(roles.supporterChanged).not.toHaveBeenCalled();
    });
    it.each([
      ["an outage", () => json({}, 503)],
      ["a refused creator token", () => json({}, 401)],
      ["a broken answer", () => new Response("not json")],
    ])("still links after %s reading the member, without importing it", async (_name, answer) => {
      answers.member = answer;
      expect((await throughPatreon()).done.headers.location).toBe("/supporters/link/done?r=linked");
      expect(supporters.importApiMember).not.toHaveBeenCalled();
      expect(store.link).toHaveBeenCalledTimes(1);
    });
    it("ends on the unavailable page with one fixed log line when saving fails", async () => {
      store.link.mockRejectedValue(new Error(`insert failed for ${PATRON} ${MEMBER} ${SECRETS.creator}`));
      const { done } = await throughPatreon();
      expect(done.headers.location).toBe("/supporters/link/done?r=unavailable");
      expect(messages().filter((message) => message === PATRON_LINK_FAILED)).toHaveLength(1);
      expect(messages().join("\n")).not.toMatch(/PRIVATE|500000000000000001|a1b2c3d4/);
      expect(roles.supporterChanged).not.toHaveBeenCalled();
    });
  });

  describe("the result page", () => {
    it("shows fixed text, clears the cookie, and shows unknown outcomes as unavailable", async () => {
      const page = await request(server).get("/supporters/link/done?r=linked").expect(200);
      expect(page.headers["content-type"]).toMatch(/^text\/html/);
      expect(page.text).toContain("<title>Link Patreon · The UNCs</title>");
      expect(page.text).toContain("<h1>You&#39;re linked 🎉</h1>");
      expect(page.text).toContain(`href="https://discord.com/channels/${GUILD}"`);
      const [cleared] = ([] as string[]).concat(page.headers["set-cookie"]);
      expect(cleared).toMatch(
        /^__Host-uncs_patron_link=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax$/,
      );
      for (const r of ["", "nope", "<script>alert(1)</script>", "linked&r=busy"]) {
        const unknown = await request(server)
          .get(`/supporters/link/done?r=${encodeURIComponent(r)}`)
          .expect(200);
        expect(unknown.text).toContain("<h1>Patreon or Discord didn&#39;t answer</h1>");
        expect(unknown.text).not.toContain("<script>alert");
      }
    });
  });

  describe("every response", () => {
    it("is uncached, unframed and allowed no script, with no referrer", async () => {
      const responses = [
        await request(server).get(`/supporters/link/start?t=${ticket()}`),
        await request(server).get("/supporters/link/discord/callback"),
        await request(server).get("/supporters/link/patreon/callback"),
        await request(server).get("/supporters/link/done?r=busy"),
      ];
      for (const response of responses)
        expect(response.headers).toMatchObject({
          "cache-control": "no-store",
          "cdn-cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "content-security-policy": PATRON_LINK_CSP,
          "cross-origin-resource-policy": "same-origin",
          "strict-transport-security": "max-age=31536000",
        });
      expect(PATRON_LINK_CSP).toMatch(
        /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]{43}='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/,
      );
    });
    it("never carries a secret, code, token or account in a page, a redirect or a log", async () => {
      const seen: string[] = [];
      const keep = (response: request.Response) => {
        seen.push(response.text ?? "", String(response.headers.location ?? ""));
        return response;
      };
      const { done, back } = await throughPatreon();
      keep(back);
      keep(done);
      keep(await request(server).get(done.headers.location));
      for (const r of ["conflict", "wrong_account", "not_member", "unavailable"])
        keep(await request(server).get(`/supporters/link/done?r=${r}`));
      seen.push(...messages());
      const text = seen.join("\n");
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
      for (const id of [PATRON, MEMBER, PATREON_USER, CAMPAIGN]) expect(text).not.toContain(id);
      expect(messages()).toEqual(["Patron link finished: linked"]);
      // Each secret goes only to the provider it belongs to.
      for (const [target, init] of fetchMock.mock.calls as [string | URL, RequestInit][]) {
        const url = String(target);
        const sent = `${url} ${String(init.body ?? "")} ${JSON.stringify(init.headers)}`;
        if (sent.includes(SECRETS.discordClient)) expect(url).toMatch(/^https:\/\/discord\.com\//);
        if (sent.includes(SECRETS.patreonClient) || sent.includes(SECRETS.creator))
          expect(url).toMatch(/^https:\/\/www\.patreon\.com\//);
        expect(sent).not.toContain(SECRETS.session);
        expect(sent).not.toContain(SECRETS.bot);
      }
    });
    it("says too many tries on the 61st request to a page in a minute from one address", async () => {
      for (let index = 0; index < 60; index++) await request(server).get("/supporters/link/done?r=off").expect(200);
      const busy = await request(server).get("/supporters/link/done?r=off").expect(429);
      expect(busy.headers["retry-after"]).toBe("60");
      expect(busy.text).toContain("<h1>Too many tries</h1>");
      // Each page counts on its own.
      await request(server).get(`/supporters/link/start?t=${ticket()}`).expect(303);
    });
  });
});
