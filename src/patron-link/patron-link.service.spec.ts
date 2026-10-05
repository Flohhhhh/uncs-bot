import { Logger } from "@nestjs/common";
import { ChannelType, Client, DiscordAPIError, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { AdminSettings } from "../admin/admin.settings";
import type { DiscordRolesService } from "../discord-roles/discord-roles.service";
import type { EnvService } from "../env/env.service";
import type { PatreonClient } from "../supporters/patreon.client";
import type { PatreonSyncService } from "../supporters/patreon-sync.service";
import type { SupporterMatchService } from "../supporters/supporter-match.service";
import type { SupportersStore } from "../supporters/supporters.store";
import { PATRON_COPY, READINESS_COPY, STAFF_COPY } from "./patron-link.copy";
import { PatronLinkOAuth } from "./patron-link.oauth";
import {
  PATRON_LINK_FAILED,
  PatronLinkService,
  patronLinkRequest,
  type PatronLinkRequest,
} from "./patron-link.service";
import { PATRON_LINK_TICKETS_PER_USER, PatronLinkState } from "./patron-link.state";
import type { PatronLinkStore } from "./patron-link.store";

const GUILD = "200000000000000001",
  CHANNEL = "400000000000000001",
  OWNER = "500000000000000001",
  ADMIN = "500000000000000002",
  MODERATOR = "500000000000000003",
  VIEWER = "500000000000000004",
  MEMBER = "500000000000000005",
  ADMIN_ROLE = "300000000000000001",
  MOD_ROLE = "300000000000000002",
  VIEWER_ROLE = "300000000000000003";
const CREATOR = "creator-token-PRIVATE-0123456789";
const CLIENT_SECRET = "patreon-client-SECRET-0123456789";

function settings(overrides: Record<string, unknown> = {}) {
  return {
    PATREON_LINK_ENABLED: true,
    PATREON_ENABLED: true,
    PATREON_CAMPAIGN_ID: "16880209",
    PATREON_CREATOR_ACCESS_TOKEN: CREATOR,
    PATREON_WEBHOOK_SECRET: "patreon-webhook-secret-0123456789",
    PATREON_CLIENT_ID: "patreon-client-id-0123456789",
    PATREON_CLIENT_SECRET: CLIENT_SECRET,
    ADMIN_ORIGIN: "https://admin.theuncs.example",
    ADMIN_DISCORD_CLIENT_ID: "600000000000000001",
    ADMIN_DISCORD_CLIENT_SECRET: "discord-client-SECRET-0123456789",
    ADMIN_SESSION_SECRET: "s".repeat(40),
    ADMIN_GUILD_ID: GUILD,
    ADMIN_OWNER_IDS: OWNER,
    ADMIN_ADMIN_ROLE_IDS: ADMIN_ROLE,
    ADMIN_MODERATOR_ROLE_IDS: MOD_ROLE,
    ADMIN_VIEWER_ROLE_IDS: VIEWER_ROLE,
    DISCORD_ROLES_ENABLED: true,
    DISCORD_SUPPORTER_ROLE_ID: "300000000000000009",
    DISCORD_BOT_TOKEN: "discord-bot-token-0123456789",
    DATABASE_URL: "postgres://localhost/unused",
    NEST_ENV: "production",
    ...overrides,
  };
}

function discordError(code: number, status: number) {
  return new DiscordAPIError({ code, message: "Discord said no" }, code, status, "POST", "/discord", {});
}

function fakeChannel(permissions: bigint[] = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) {
  return {
    id: CHANNEL,
    type: ChannelType.GuildText as ChannelType,
    guildId: GUILD,
    guild: { members: { me: { id: "bot" }, fetchMe: jest.fn() } },
    permissionsFor: jest.fn(() => new PermissionsBitField(permissions)),
    send: jest.fn(async (_payload: Record<string, unknown>) => ({ id: "700000000000000001" })),
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const values = settings(overrides);
  const env = { get: (key: string) => values[key as keyof typeof values] } as unknown as EnvService;
  const sync = { configured: jest.fn(() => true) };
  const store = { linked: jest.fn(async (..._args: unknown[]) => false), link: jest.fn() };
  const channel = fakeChannel();
  const discord = { channels: { fetch: jest.fn(async (_id: string) => channel as unknown) } };
  const state = new PatronLinkState();
  const service = new PatronLinkService(
    env,
    new AdminSettings(env),
    sync as unknown as PatreonSyncService,
    { member: jest.fn() } as unknown as PatreonClient,
    { importApiMember: jest.fn() } as unknown as SupportersStore,
    store as unknown as PatronLinkStore,
    state,
    new PatronLinkOAuth(),
    { supporterChanged: jest.fn() } as unknown as DiscordRolesService,
    { member: jest.fn() } as unknown as SupporterMatchService,
    discord as unknown as Client,
  );
  return { service, sync, store, channel, discord, state, values };
}
const request = (overrides: Partial<PatronLinkRequest> = {}): PatronLinkRequest => ({
  guildId: GUILD,
  channelId: CHANNEL,
  userId: MEMBER,
  bot: false,
  roles: [],
  ...overrides,
});

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("/patreon link and the panel button", () => {
  it("issues a one-time link to ADMIN_ORIGIN that names no account, with the fine print", async () => {
    const { service, store } = fixture();
    const reply = await service.request(request());
    expect(reply.content).toBe(
      `${PATRON_COPY.issued}\n-# Gramps only checks your membership. He never sees your card or keeps your Patreon login.`,
    );
    const [button] = reply.components![0].components.map((component) => component.toJSON()) as { url: string }[];
    expect(button).toMatchObject({ label: "Link my Patreon" });
    const url = new URL(button.url);
    expect(url.origin + url.pathname).toBe("https://admin.theuncs.example/supporters/link/start");
    expect([...url.searchParams.keys()]).toEqual(["t"]);
    expect(url.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(button.url).not.toContain(MEMBER);
    expect(store.linked).toHaveBeenCalledWith("16880209", MEMBER);
  });
  it("checks, in order: off, the server, the setup, an existing link, then the limit", async () => {
    const off = fixture({ PATREON_LINK_ENABLED: false, ADMIN_GUILD_ID: undefined });
    expect(await off.service.request(request({ guildId: null, bot: true }))).toEqual({ content: PATRON_COPY.off });
    const elsewhere = fixture({ PATREON_CLIENT_ID: undefined });
    for (const outside of [
      request({ guildId: "200000000000000002" }),
      request({ guildId: null }),
      request({ bot: true }),
    ])
      expect(await elsewhere.service.request(outside)).toEqual({ content: PATRON_COPY.wrongServer });
    expect(await fixture({ ADMIN_GUILD_ID: undefined }).service.request(request())).toEqual({
      content: PATRON_COPY.wrongServer,
    });
    const notSetUp = fixture({ PATREON_CLIENT_ID: undefined });
    expect(await notSetUp.service.request(request())).toEqual({ content: PATRON_COPY.notSetUp });
    expect(notSetUp.store.linked).not.toHaveBeenCalled();
    const linked = fixture();
    linked.store.linked.mockResolvedValue(true);
    expect(await linked.service.request(request())).toEqual({
      content:
        "✅ You're already linked. Nothing left to do but feel smug.\n-# Wrong Patreon account? Ask an admin to swap it.",
    });
    const limited = fixture();
    for (let index = 0; index < PATRON_LINK_TICKETS_PER_USER; index++)
      expect((await limited.service.request(request())).components).toHaveLength(1);
    expect(await limited.service.request(request())).toEqual({ content: PATRON_COPY.limited });
    // Every reply is plain text for the one person who asked: nothing here mentions anyone.
    expect(JSON.stringify([PATRON_COPY])).not.toContain("<@");
  });
  it("answers with fixed text and one fixed log line when the records cannot be read", async () => {
    const { service, store } = fixture();
    store.linked.mockRejectedValue(new Error(`postgres://user:${CREATOR}@db failed for ${MEMBER}`));
    expect(await service.request(request())).toEqual({ content: PATRON_COPY.failed });
    expect(warn.mock.calls).toEqual([[PATRON_LINK_FAILED]]);
    expect(log).not.toHaveBeenCalled();
  });
  it("reads a member's roles from a cached member or an API member", () => {
    const user = { id: MEMBER, bot: false };
    const base = { guildId: GUILD, channelId: CHANNEL, user };
    expect(patronLinkRequest({ ...base, member: { roles: [ADMIN_ROLE] } }).roles).toEqual([ADMIN_ROLE]);
    expect(patronLinkRequest({ ...base, member: { roles: { cache: new Map([[ADMIN_ROLE, {}]]) } } }).roles).toEqual([
      ADMIN_ROLE,
    ]);
    expect(patronLinkRequest({ ...base, member: null })).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      bot: false,
      roles: [],
    });
  });
});

describe("readiness", () => {
  it("is ready with every setting in place", () => {
    expect(fixture().service.readiness()).toBeNull();
  });
  it("names the import first when it is not set up", () => {
    const { service, sync } = fixture({ PATREON_CLIENT_ID: undefined });
    sync.configured.mockReturnValue(false);
    expect(service.readiness()).toBe(READINESS_COPY.import);
  });
  it.each<[string, Record<string, unknown>, string]>([
    ["no client ID", { PATREON_CLIENT_ID: undefined }, READINESS_COPY.clientId],
    ["a short client ID", { PATREON_CLIENT_ID: "short" }, READINESS_COPY.clientId],
    ["a client ID with spaces", { PATREON_CLIENT_ID: "has spaces in the client id" }, READINESS_COPY.clientId],
    ["no client secret", { PATREON_CLIENT_SECRET: undefined }, READINESS_COPY.clientSecret],
    ["a short client secret", { PATREON_CLIENT_SECRET: "short" }, READINESS_COPY.clientSecret],
    [
      "a client secret with spaces",
      { PATREON_CLIENT_SECRET: "has spaces inside it 0123" },
      READINESS_COPY.clientSecret,
    ],
    ["the creator token reused", { PATREON_CLIENT_SECRET: CREATOR }, READINESS_COPY.clientSecret],
    [
      "the webhook secret reused",
      { PATREON_CLIENT_SECRET: "patreon-webhook-secret-0123456789" },
      READINESS_COPY.clientSecret,
    ],
    [
      "the Discord client secret reused",
      { PATREON_CLIENT_SECRET: "discord-client-SECRET-0123456789" },
      READINESS_COPY.clientSecret,
    ],
    ["the bot token reused", { PATREON_CLIENT_SECRET: "discord-bot-token-0123456789" }, READINESS_COPY.clientSecret],
    ["no ADMIN_ORIGIN", { ADMIN_ORIGIN: undefined }, READINESS_COPY.signIn],
    ["an http ADMIN_ORIGIN", { ADMIN_ORIGIN: "http://admin.theuncs.example" }, READINESS_COPY.signIn],
    ["an ADMIN_ORIGIN with a path", { ADMIN_ORIGIN: "https://admin.theuncs.example/x" }, READINESS_COPY.signIn],
    ["no Discord client secret", { ADMIN_DISCORD_CLIENT_SECRET: undefined }, READINESS_COPY.signIn],
    ["no ADMIN_GUILD_ID", { ADMIN_GUILD_ID: undefined }, READINESS_COPY.signIn],
    ["Discord roles off", { DISCORD_ROLES_ENABLED: false }, READINESS_COPY.roles],
    ["no Supporter role", { DISCORD_SUPPORTER_ROLE_ID: undefined }, READINESS_COPY.roles],
  ])("names %s", (_name, overrides, reason) => {
    expect(fixture(overrides).service.readiness()).toBe(reason);
  });
  it("needs neither the dashboard nor website applications switched on", () => {
    expect(fixture({ ADMIN_ENABLED: false, WHITELIST_APPLICATIONS_ENABLED: false }).service.readiness()).toBeNull();
  });
  it("never puts a secret in its answer", () => {
    for (const overrides of [{ PATREON_CLIENT_SECRET: CREATOR }, { PATREON_CLIENT_ID: CLIENT_SECRET.slice(0, 5) }])
      expect(fixture(overrides).service.readiness()).not.toMatch(/PRIVATE|SECRET-/);
  });
});

describe("/patreon panel", () => {
  it("is for the dashboard's admins only: the owner or an admin role, never a moderator or viewer", async () => {
    for (const asker of [
      request({ userId: MODERATOR, roles: [MOD_ROLE] }),
      request({ userId: VIEWER, roles: [VIEWER_ROLE] }),
      request(),
    ]) {
      const { service, channel } = fixture();
      expect(await service.panel(asker)).toBe(STAFF_COPY.adminsOnly);
      expect(channel.send).not.toHaveBeenCalled();
    }
    for (const asker of [request({ userId: OWNER }), request({ userId: ADMIN, roles: [ADMIN_ROLE] })])
      expect(await fixture().service.panel(asker)).toBe(STAFF_COPY.posted);
  });
  it("posts one button that mentions nobody, with a nonce Discord enforces", async () => {
    const { service, channel, discord } = fixture();
    expect(await service.panel(request({ userId: OWNER }))).toBe("✅ Panel posted.");
    expect(discord.channels.fetch).toHaveBeenCalledWith(CHANNEL);
    const [[payload]] = channel.send.mock.calls;
    expect(payload).toMatchObject({ allowedMentions: { parse: [] }, enforceNonce: true });
    expect(payload.nonce).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.stringify(payload.components)).toContain("uncs-patreon/link");
    expect(payload.content).not.toContain("<@");
  });
  it("names the setting to fix instead of posting", async () => {
    const { service, channel } = fixture({ DISCORD_SUPPORTER_ROLE_ID: undefined });
    expect(await service.panel(request({ userId: OWNER }))).toBe(READINESS_COPY.roles);
    expect(channel.send).not.toHaveBeenCalled();
    expect(await fixture({ PATREON_LINK_ENABLED: false }).service.panel(request({ userId: OWNER }))).toBe(
      PATRON_COPY.off,
    );
    expect(await fixture().service.panel(request({ userId: OWNER, guildId: "200000000000000002" }))).toBe(
      PATRON_COPY.wrongServer,
    );
  });
  it("refuses a channel Gramps cannot post in", async () => {
    const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
      ["no channel", (f) => f.discord.channels.fetch.mockResolvedValue(null)],
      ["a failed fetch", (f) => f.discord.channels.fetch.mockRejectedValue(new Error("Unknown Channel"))],
      ["a voice channel", (f) => (f.channel.type = ChannelType.GuildVoice)],
      ["another server's channel", (f) => (f.channel.guildId = "200000000000000002")],
      [
        "no Send Messages",
        (f) => f.channel.permissionsFor.mockReturnValue(new PermissionsBitField([PermissionFlagsBits.ViewChannel])),
      ],
    ];
    for (const [, change] of cases) {
      const f = fixture();
      change(f);
      expect(await f.service.panel(request({ userId: OWNER }))).toBe(STAFF_COPY.channel);
      expect(f.channel.send).not.toHaveBeenCalled();
    }
    expect(await fixture().service.panel(request({ userId: OWNER, channelId: null }))).toBe(STAFF_COPY.channel);
  });
  it("tells a refusal from an unconfirmed post, without logging the channel", async () => {
    const refused = fixture();
    refused.channel.send.mockRejectedValue(discordError(50013, 403));
    expect(await refused.service.panel(request({ userId: OWNER }))).toBe(
      "Discord refused the panel, so check Gramps' permissions here.",
    );
    const unknown = fixture();
    unknown.channel.send.mockRejectedValue(new Error("socket hang up"));
    expect(await unknown.service.panel(request({ userId: OWNER }))).toBe(
      "Discord didn't confirm the panel, so check this channel before posting again.",
    );
    expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain(CHANNEL);
  });
});
