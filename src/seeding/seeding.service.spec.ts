import { Logger } from "@nestjs/common";
import {
  ChannelType,
  Collection,
  DiscordAPIError,
  GatewayIntentBits,
  IntentsBitField,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
} from "discord.js";
import { AdminSettings } from "../admin/admin.settings";
import type { GameServers } from "../admin/game-servers";
import type { GameServerSummary } from "../common/game-server";
import type { EnvService } from "../env/env.service";
import {
  CHANNEL_PROBLEMS,
  CHANNEL_VIEW_WARNINGS,
  MEMBER_COPY,
  MENTIONABLE_WARNING,
  ROLE_PROBLEMS,
  SEEDING_BUTTONS,
  STAFF_COPY,
} from "./seeding-copy";
import {
  MEMBER_LIST_TIMEOUT_MS,
  PLAYER_COUNT_TIMEOUT_MS,
  SeedingService,
  seedingRequest,
  type SeedingRequest,
} from "./seeding.service";

const GUILD = "200000000000000001",
  OTHER_GUILD = "200000000000000002",
  ROLE = "300000000000000001",
  ADMIN_ROLE = "300000000000000010",
  MOD_ROLE = "300000000000000011",
  VIEWER_ROLE = "300000000000000012",
  CHANNEL = "400000000000000001",
  PANEL_CHANNEL = "400000000000000002",
  MEMBER = "500000000000000001",
  MODERATOR = "500000000000000002",
  OWNER = "500000000000000003",
  ROLE_MANAGER = "500000000000000004",
  VIEWER = "500000000000000005",
  DISCORD_ADMIN = "500000000000000006",
  SEEDER_ONE = "500000000000000007",
  SEEDER_TWO = "500000000000000008",
  STRANGER = "500000000000000009",
  BOT = "500000000000000099";
const JOIN_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;
const primary: GameServerSummary = { id: "primary", name: "The UNCs", version: "0".repeat(64), joinId: JOIN_ID };

function discordError(code: number, status: number) {
  return new DiscordAPIError({ code, message: "Discord said no" }, code, status, "PUT", "/discord", {});
}

function fakeMember(id: string, roles: string[] = [], permissions: bigint[] = []) {
  const cache = new Map<string, object>(roles.map((role) => [role, {}]));
  return {
    id,
    permissions: new PermissionsBitField(permissions),
    roles: {
      cache,
      add: jest.fn(async (role: string, _reason?: string) => void cache.set(role, {})),
      remove: jest.fn(async (role: string, _reason?: string) => void cache.delete(role)),
    },
  };
}

function fakeChannel(id: string, permissions: bigint[]) {
  const channel = {
    id,
    type: ChannelType.GuildText as ChannelType,
    guildId: GUILD,
    permissions: new PermissionsBitField(permissions),
    /** What a particular role or member gets here, as Discord works it out from roles and overrides. */
    access: new Map<unknown, PermissionsBitField>(),
    permissionsFor: jest.fn((target?: unknown) => channel.access.get(target) ?? channel.permissions),
    send: jest.fn(async (_payload: Record<string, unknown>) => ({ id: "600000000000000001" })),
  };
  return channel;
}

function fixture(overrides: Record<string, unknown> = {}, servers: GameServerSummary[] = [primary]) {
  const values: Record<string, unknown> = {
    SEEDING_ENABLED: true,
    ADMIN_GUILD_ID: GUILD,
    SEEDING_ROLE_ID: ROLE,
    SEEDING_PING_CHANNEL_ID: CHANNEL,
    SEEDING_PING_COOLDOWN_MINUTES: 120,
    ADMIN_OWNER_IDS: OWNER,
    ADMIN_ADMIN_ROLE_IDS: ADMIN_ROLE,
    ADMIN_MODERATOR_ROLE_IDS: MOD_ROLE,
    ADMIN_VIEWER_ROLE_IDS: VIEWER_ROLE,
    ADMIN_ENABLED: false,
    ...overrides,
  };
  const env = { get: (key: string) => values[key] } as unknown as EnvService;
  const members = new Collection(
    [
      fakeMember(MEMBER),
      fakeMember(MODERATOR, [MOD_ROLE]),
      fakeMember(OWNER),
      fakeMember(ROLE_MANAGER, [], [PermissionFlagsBits.ManageRoles]),
      fakeMember(VIEWER, [VIEWER_ROLE]),
      fakeMember(DISCORD_ADMIN, [], [PermissionFlagsBits.Administrator]),
      fakeMember(SEEDER_ONE, [ROLE]),
      fakeMember(SEEDER_TWO, [ROLE]),
    ].map((member) => [member.id, member]),
  );
  const role = {
    id: ROLE,
    managed: false,
    mentionable: false,
    permissions: new PermissionsBitField(),
    /** Like discord.js, only the cached members who have the role. */
    get members() {
      return members.filter((member) => member.roles.cache.has(ROLE));
    },
  };
  const me = {
    id: BOT,
    permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
    roles: { highest: { comparePositionTo: jest.fn((_role: unknown) => 1) } },
  };
  /** Loading the whole member list over the gateway, which needs the Server Members intent. */
  const fetchAll = jest.fn(async (_options: { time: number }) => members);
  const guild = {
    id: GUILD,
    /** Every member is cached unless a test raises this. */
    memberCount: members.size,
    members: {
      cache: members,
      me: me as typeof me | null,
      fetch: jest.fn(async (id: string | { time: number }) => {
        if (typeof id !== "string") return fetchAll(id);
        const member = members.get(id);
        if (!member) throw discordError(10007, 404);
        return member;
      }),
      fetchMe: jest.fn(async () => me),
    },
    roles: {
      fetch: jest.fn(async (id: string): Promise<typeof role | null> => (id === role.id ? role : null)),
      fetchMemberCounts: jest.fn(async () => new Map([[ROLE, 12]])),
    },
    /** Gramps' channel cache, read for permission overrides on the Seeder role. */
    channels: { cache: new Collection<string, object>() },
  };
  const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  const channel = fakeChannel(CHANNEL, [...permissions, PermissionFlagsBits.MentionEveryone]);
  const panelChannel = fakeChannel(PANEL_CHANNEL, permissions);
  const channels = new Map([
    [CHANNEL, channel],
    [PANEL_CHANNEL, panelChannel],
  ]);
  const discord = {
    options: { intents: new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]) },
    guilds: { fetch: jest.fn(async (_id: string) => guild) },
    channels: { fetch: jest.fn(async (id: string) => channels.get(id) ?? null) },
  };
  const overview = jest.fn(async () => ({ status: { players: { current: 3, max: 64 } } }));
  const game = {
    list: jest.fn(() => servers),
    get: jest.fn((_id: string) => ({ overview })),
  };
  const service = new SeedingService(
    env,
    new AdminSettings(env),
    game as unknown as GameServers,
    discord as unknown as Client,
  );
  const request = (userId: string, channelId: string | null = PANEL_CHANNEL): SeedingRequest => ({
    guildId: GUILD,
    userId,
    channelId,
  });
  return {
    service,
    values,
    role,
    me,
    members,
    fetchAll,
    guild,
    channel,
    panelChannel,
    discord,
    game,
    overview,
    request,
  };
}

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("seedingRequest", () => {
  it("takes the guild, user and channel from an interaction", () => {
    expect(seedingRequest({ guildId: GUILD, channelId: CHANNEL, user: { id: MEMBER } })).toEqual({
      guildId: GUILD,
      userId: MEMBER,
      channelId: CHANNEL,
    });
  });
});

describe("/seeding join and leave", () => {
  it("adds the Seeder role with an audit reason, then removes it again", async () => {
    const { service, members, request } = fixture();
    const member = members.get(MEMBER)!;
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.joined);
    expect(member.roles.add).toHaveBeenCalledWith(ROLE, "Opted in to seeding pings");
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.left);
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE, "Opted out of seeding pings");
  });

  it("says so without calling Discord when the role is already there or already gone", async () => {
    const { service, members, request } = fixture();
    const member = members.get(MEMBER)!;
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.alreadyLeft);
    member.roles.cache.set(ROLE, {});
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.alreadyJoined);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it("takes no new sign-ups while the feature is off, which is the default", async () => {
    const { service, discord, members, request } = fixture({ SEEDING_ENABLED: false });
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.off);
    expect(discord.guilds.fetch).not.toHaveBeenCalled();
    expect(members.get(MEMBER)!.roles.add).not.toHaveBeenCalled();
  });

  it("still lets a Seeder opt out while the feature is off", async () => {
    const { service, members, request } = fixture({ SEEDING_ENABLED: false });
    const member = members.get(MEMBER)!;
    member.roles.cache.set(ROLE, {});
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.left);
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE, "Opted out of seeding pings");
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.alreadyLeft);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("keeps the safety and role-height checks on an opt-out while the feature is off", async () => {
    const { service, role, me, members, request } = fixture({ SEEDING_ENABLED: false });
    const member = members.get(MEMBER)!;
    member.roles.cache.set(ROLE, {});
    me.roles.highest.comparePositionTo.mockReturnValue(0);
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.roleTooLow);
    role.permissions = new PermissionsBitField([PermissionFlagsBits.KickMembers]);
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.roleUnusable);
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it.each([
    { SEEDING_ROLE_ID: undefined },
    { ADMIN_GUILD_ID: undefined },
    { SEEDING_ENABLED: false, SEEDING_ROLE_ID: undefined },
  ])("explains that seeding is not set up yet when %o", async (overrides) => {
    const { service, discord, request } = fixture(overrides);
    if (overrides.SEEDING_ENABLED !== false) expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.unconfigured);
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.unconfigured);
    expect(discord.guilds.fetch).not.toHaveBeenCalled();
  });

  it.each([OTHER_GUILD, null])("only works inside the configured Discord server (guild %s)", async (guildId) => {
    const { service, discord } = fixture();
    expect(await service.join({ guildId, userId: MEMBER })).toBe(MEMBER_COPY.outsideGuild);
    expect(discord.guilds.fetch).not.toHaveBeenCalled();
  });

  it("handles a member Discord no longer finds in the server", async () => {
    const { service, request } = fixture();
    expect(await service.join(request(STRANGER))).toBe(MEMBER_COPY.notMember);
  });

  it("reports a deleted Seeder role, whether Discord returns nothing or Unknown Role", async () => {
    const { service, guild, members, request } = fixture();
    guild.roles.fetch.mockResolvedValueOnce(null);
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleMissing);
    guild.roles.fetch.mockRejectedValueOnce(discordError(10011, 404));
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.roleMissing);
    members.get(MEMBER)!.roles.add.mockRejectedValueOnce(discordError(10011, 404));
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleMissing);
  });

  it("refuses before calling Discord when the role sits at or above Gramps", async () => {
    const { service, me, members, request } = fixture();
    me.roles.highest.comparePositionTo.mockReturnValue(0);
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleTooLow);
    expect(members.get(MEMBER)!.roles.add).not.toHaveBeenCalled();
  });

  it("refuses when Gramps lacks Manage Roles", async () => {
    const { service, me, request } = fixture();
    me.permissions = new PermissionsBitField();
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleTooLow);
  });

  it("still answers 'already a Seeder' when Gramps could not change the role anyway", async () => {
    const { service, me, members, request } = fixture();
    me.roles.highest.comparePositionTo.mockReturnValue(-1);
    members.get(MEMBER)!.roles.cache.set(ROLE, {});
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.alreadyJoined);
  });

  it.each([50013, 50001])("translates Discord %s from the role change into the role-too-low reply", async (code) => {
    const { service, members, request } = fixture();
    members.get(MEMBER)!.roles.add.mockRejectedValueOnce(discordError(code, 403));
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleTooLow);
  });

  it("relies on Discord's 50013 when Gramps' own member is not cached", async () => {
    const { service, guild, members, request } = fixture();
    guild.members.me = null;
    guild.members.fetchMe.mockRejectedValueOnce(new Error("offline"));
    members.get(MEMBER)!.roles.add.mockRejectedValueOnce(discordError(50013, 403));
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleTooLow);
  });

  it("handles a member who left between the check and the role change", async () => {
    const { service, members, request } = fixture();
    members.get(MEMBER)!.roles.add.mockRejectedValueOnce(discordError(10007, 404));
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.notMember);
  });

  it("gives a calm, safe reply for anything unexpected", async () => {
    const { service, members, guild, request } = fixture();
    members.get(MEMBER)!.roles.add.mockRejectedValueOnce(new Error("postgres://private-credential"));
    const reply = await service.join(request(MEMBER));
    expect(reply).toBe(MEMBER_COPY.failed);
    expect(reply).not.toContain("postgres");
    guild.roles.fetch.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.failed);
  });

  it.each([
    ["@everyone", { id: GUILD }],
    ["a managed integration role", { managed: true }],
    ["a staff role", { id: MOD_ROLE }],
    ["a viewer staff role", { id: VIEWER_ROLE }],
    ["a role with moderation permissions", { permissions: new PermissionsBitField([PermissionFlagsBits.KickMembers]) }],
    ["an administrator role", { permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) }],
  ])("never hands out %s as the Seeder role", async (_label, change) => {
    const { service, role, values, members, request } = fixture();
    Object.assign(role, change);
    values.SEEDING_ROLE_ID = role.id;
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleUnusable);
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.roleUnusable);
    expect(members.get(MEMBER)!.roles.add).not.toHaveBeenCalled();
    expect(members.get(MEMBER)!.roles.remove).not.toHaveBeenCalled();
  });

  it.each(["DISCORD_MEMBER_ROLE_ID", "DISCORD_FOUNDER_ROLE_ID", "DISCORD_SUPPORTER_ROLE_ID"])(
    "never hands out or pings an automatic Discord role set in %s as the Seeder role",
    async (setting) => {
      const { service, values, members, channel, request } = fixture({ [setting]: ROLE });
      expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.roleUnusable);
      expect(await service.leave(request(SEEDER_ONE))).toBe(MEMBER_COPY.roleUnusable);
      expect(await service.ping(request(MODERATOR))).toBe(`${ROLE_PROBLEMS.unsafe} Nothing was sent.`);
      expect(members.get(MEMBER)!.roles.add).not.toHaveBeenCalled();
      expect(members.get(SEEDER_ONE)!.roles.remove).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
      // A different automatic role leaves the Seeder role usable.
      values[setting] = "700000000000000099";
      expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.joined);
    },
  );

  it("never hands out a role that gets moderation powers through a channel override", async () => {
    const { service, guild, members, request } = fixture();
    const overrides = (allow: bigint[]) => ({
      permissionOverwrites: { cache: new Collection([[ROLE, { allow: new PermissionsBitField(allow) }]]) },
    });
    // A thread has no overrides of its own, and a plain view-and-send override is fine.
    guild.channels.cache.set("400000000000000010", { id: "400000000000000010" });
    guild.channels.cache.set(CHANNEL, overrides([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]));
    expect(await service.join(request(MEMBER))).toBe(MEMBER_COPY.joined);
    guild.channels.cache.set(
      PANEL_CHANNEL,
      overrides([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]),
    );
    expect(await service.leave(request(MEMBER))).toBe(MEMBER_COPY.roleUnusable);
    expect(await service.join(request(MODERATOR))).toBe(MEMBER_COPY.roleUnusable);
    expect(members.get(MEMBER)!.roles.remove).not.toHaveBeenCalled();
    expect(members.get(MODERATOR)!.roles.add).not.toHaveBeenCalled();
  });
});

describe("staff check", () => {
  it.each([
    ["an owner ID", OWNER, true],
    ["a moderator role", MODERATOR, true],
    ["only the Manage Roles permission", ROLE_MANAGER, false],
    ["only the Administrator permission", DISCORD_ADMIN, false],
    ["a viewer role", VIEWER, false],
    ["no staff access", MEMBER, false],
  ])("treats a member with %s as staff: %s", async (_label, userId, staff) => {
    const { service, members } = fixture();
    expect(service.isStaff(members.get(userId) as never)).toBe(staff);
  });

  it("uses the admin role list too", async () => {
    const { service } = fixture();
    expect(service.isStaff(fakeMember(STRANGER, [ADMIN_ROLE]) as never)).toBe(true);
  });
});

describe("/seeding panel", () => {
  it("posts the two persistent buttons in the current channel, mentioning nobody", async () => {
    const { service, panelChannel, request } = fixture();
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.panelPosted);
    expect(panelChannel.send).toHaveBeenCalledTimes(1);
    const [payload] = panelChannel.send.mock.calls[0] as [
      { allowedMentions: unknown; components: any[]; nonce: string; enforceNonce: boolean },
    ];
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.enforceNonce).toBe(true);
    expect(payload.nonce).toMatch(/^[0-9a-f]{24}$/);
    const buttons = payload.components[0].toJSON().components;
    expect(buttons.map((button: { custom_id: string; label: string }) => [button.custom_id, button.label])).toEqual([
      [SEEDING_BUTTONS.join, "I'll help seed"],
      [SEEDING_BUTTONS.leave, "Stop pinging me"],
    ]);
  });

  it("is staff only", async () => {
    const { service, panelChannel, request } = fixture();
    for (const userId of [MEMBER, VIEWER, ROLE_MANAGER, DISCORD_ADMIN])
      expect(await service.panel(request(userId))).toBe(STAFF_COPY.staffOnly);
    expect(panelChannel.send).not.toHaveBeenCalled();
  });

  it("stays off while the feature is off, and tells only staff how to turn it on", async () => {
    const { service, panelChannel, request } = fixture({ SEEDING_ENABLED: false });
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.off);
    expect(await service.panel(request(MEMBER))).toBe(STAFF_COPY.staffOnly);
    expect(panelChannel.send).not.toHaveBeenCalled();
  });

  it("asks for the role and a working role before posting buttons that would fail", async () => {
    const unset = fixture({ SEEDING_ROLE_ID: undefined });
    expect(await unset.service.panel(unset.request(MODERATOR))).toBe(STAFF_COPY.roleUnset);
    const { service, me, panelChannel, request } = fixture();
    me.roles.highest.comparePositionTo.mockReturnValue(-1);
    expect(await service.panel(request(MODERATOR))).toBe(ROLE_PROBLEMS.unassignable);
    expect(panelChannel.send).not.toHaveBeenCalled();
  });

  it("asks an owner for ADMIN_GUILD_ID when it is missing, and gives everyone else the plain reply", async () => {
    const { service, discord, request } = fixture({ ADMIN_GUILD_ID: undefined });
    expect(await service.panel(request(OWNER))).toBe(STAFF_COPY.guildUnset);
    // Without the server, a moderator role can't be read.
    expect(await service.panel(request(MODERATOR))).toBe(MEMBER_COPY.unconfigured);
    expect(await service.panel(request(MEMBER))).toBe(MEMBER_COPY.unconfigured);
    expect(discord.guilds.fetch).not.toHaveBeenCalled();
  });

  it("refuses a channel Gramps cannot post in, in another server or of the wrong kind", async () => {
    const { service, panelChannel, request } = fixture();
    panelChannel.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.panelChannel);
    panelChannel.permissions = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ]);
    panelChannel.guildId = OTHER_GUILD;
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.panelChannel);
    panelChannel.guildId = GUILD;
    panelChannel.type = ChannelType.GuildVoice;
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.panelChannel);
    expect(await service.panel(request(MODERATOR, null))).toBe(STAFF_COPY.panelChannel);
    expect(panelChannel.send).not.toHaveBeenCalled();
  });

  it("sends the panel once and reports a refusal or an unconfirmed send without retrying", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-02T20:00:00Z") });
    const { service, panelChannel, request } = fixture();
    panelChannel.send.mockRejectedValueOnce(discordError(50013, 403));
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.panelRefused);
    jest.advanceTimersByTime(1_000);
    panelChannel.send.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.panelUnknown);
    expect(panelChannel.send).toHaveBeenCalledTimes(2);
    // Each panel staff ask for gets its own nonce; only the REST client's own resend of one request shares it.
    const [[first], [second]] = panelChannel.send.mock.calls as [[{ nonce: string }], [{ nonce: string }]];
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("answers safely when Discord fails unexpectedly", async () => {
    const { service, discord, request } = fixture();
    discord.guilds.fetch.mockRejectedValueOnce(new Error("gateway offline"));
    expect(await service.panel(request(MODERATOR))).toBe(STAFF_COPY.failed);
  });
});

describe("/seeding ping", () => {
  type Sent = { content: string; allowedMentions: unknown; flags: unknown; nonce: string; enforceNonce: boolean };
  const sent = (channel: ReturnType<typeof fakeChannel>, call = 0) => channel.send.mock.calls[call][0] as Sent;

  it("posts one call that mentions only the Seeder role, with the player count and join ID", async () => {
    const { service, channel, game, request } = fixture();
    expect(await service.ping(request(MODERATOR), "Map night at 8, bring a friend")).toBe(
      STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE),
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = sent(channel);
    expect(payload.allowedMentions).toEqual({ roles: [ROLE] });
    expect(payload.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(payload.enforceNonce).toBe(true);
    expect(payload.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(payload.content.startsWith(`<@&${ROLE}>`)).toBe(true);
    expect(payload.content).toContain("Players on right now: **3/64**");
    expect(payload.content).toContain(`Join by ID: \`${JOIN_ID}\``);
    expect(payload.content).toContain("Staff note: Map night at 8, bring a friend");
    expect(payload.content.match(/<@/g)).toHaveLength(1);
    expect(game.get).toHaveBeenCalledWith("primary");
  });

  it("falls back to the website without a join ID and leaves out an unreadable player count", async () => {
    const { service, channel, overview, request } = fixture({}, [{ ...primary, joinId: undefined }]);
    overview.mockRejectedValueOnce(new Error("The game server could not be reached."));
    await service.ping(request(MODERATOR));
    const { content } = sent(channel);
    expect(content).toContain("How to join: https://theuncsgaming.com");
    expect(content).not.toContain("Players on right now");
    expect(content).not.toContain("Staff note");
  });

  it("posts without a player count when no game connection is configured", async () => {
    const { service, channel, game, request } = fixture();
    game.get.mockImplementationOnce(() => {
      throw new Error("The game server has not been connected yet.");
    });
    await service.ping(request(MODERATOR));
    expect(sent(channel).content).not.toContain("Players on right now");
  });

  it("does not wait on a stalled game for more than the player-count timeout", async () => {
    jest.useFakeTimers();
    const { service, channel, overview, request } = fixture();
    overview.mockReturnValueOnce(new Promise(() => undefined));
    const reply = service.ping(request(MODERATOR));
    await jest.advanceTimersByTimeAsync(PLAYER_COUNT_TIMEOUT_MS);
    expect(await reply).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
    expect(sent(channel).content).not.toContain("Players on right now");
  });

  it("ignores a nonsensical player count", async () => {
    const { service, channel, overview, request } = fixture();
    overview.mockResolvedValueOnce({ status: { players: { current: -1, max: 64 } } });
    await service.ping(request(MODERATOR));
    expect(sent(channel).content).not.toContain("Players on right now");
  });

  it("reads the registry's primary server, not whichever is listed first", async () => {
    const events = {
      id: "events",
      name: "UNCs Events",
      version: "1".repeat(64),
      joinId: "22222222-2222-4222-8222-222222222222",
    };
    const { service, channel, game, request } = fixture({}, [events, primary]);
    await service.ping(request(MODERATOR));
    expect(game.get).toHaveBeenCalledWith("primary");
    expect(sent(channel).content).toContain(JOIN_ID);
  });

  it("sanitises the staff note to one line with no mentions, @everyone or @here", async () => {
    const { service, channel, request } = fixture();
    await service.ping(
      request(MODERATOR),
      "Hop on @everyone\n<@&300000000000000099> and <@!500000000000000001> @@here",
    );
    const { content } = sent(channel);
    expect(content).toContain("Staff note: Hop on everyone and here");
    expect(content).not.toMatch(/@everyone|@here/);
    expect(content.match(/<@/g)).toHaveLength(1);
  });

  it("is staff only and stays off while the feature is off", async () => {
    const { service, channel, request } = fixture();
    expect(await service.ping(request(MEMBER))).toBe(STAFF_COPY.staffOnly);
    expect(await service.ping(request(VIEWER))).toBe(STAFF_COPY.staffOnly);
    const off = fixture({ SEEDING_ENABLED: false });
    expect(await off.service.ping(off.request(MODERATOR))).toBe(STAFF_COPY.off);
    expect(channel.send).not.toHaveBeenCalled();
    expect(off.channel.send).not.toHaveBeenCalled();
  });

  it("tells a member 'staff only', not how to turn seeding on, while the feature is off", async () => {
    const { service, channel, request } = fixture({ SEEDING_ENABLED: false });
    expect(await service.ping(request(MEMBER), "Hop on")).toBe(STAFF_COPY.staffOnly);
    expect(await service.ping(request(VIEWER))).toBe(STAFF_COPY.staffOnly);
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.cooldownRemaining(GUILD)).toBe(0);
  });

  it("gives a member the plain reply, not the ADMIN_GUILD_ID hint, when the server is not set", async () => {
    const { service, channel, request } = fixture({ ADMIN_GUILD_ID: undefined });
    expect(await service.ping(request(MEMBER))).toBe(MEMBER_COPY.unconfigured);
    expect(await service.ping(request(OWNER))).toBe(STAFF_COPY.guildUnset);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("works for owners, but never for Discord permissions alone", async () => {
    const { service, channel, request } = fixture();
    expect(await service.ping(request(ROLE_MANAGER))).toBe(STAFF_COPY.staffOnly);
    expect(await service.ping(request(DISCORD_ADMIN))).toBe(STAFF_COPY.staffOnly);
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.cooldownRemaining(GUILD)).toBe(0);
    expect(await service.ping(request(OWNER))).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it.each([{ SEEDING_ROLE_ID: undefined }, { SEEDING_PING_CHANNEL_ID: undefined }])(
    "needs both the role and the channel (%o)",
    async (overrides) => {
      const { service, channel, request } = fixture(overrides);
      expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingUnset);
      expect(channel.send).not.toHaveBeenCalled();
    },
  );

  it("refuses with the time remaining until the per-guild cooldown ends", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-02T20:00:00Z") });
    const { service, channel, request } = fixture();
    await service.ping(request(MODERATOR));
    jest.advanceTimersByTime(48 * MINUTE + 30_000);
    expect(await service.ping(request(OWNER))).toBe(STAFF_COPY.cooldown(71 * MINUTE + 30_000));
    expect(STAFF_COPY.cooldown(71 * MINUTE + 30_000)).toContain("1 h 12 min");
    expect(service.cooldownRemaining(GUILD)).toBe(71 * MINUTE + 30_000);
    expect(service.cooldownRemaining(OTHER_GUILD)).toBe(0);
    jest.advanceTimersByTime(72 * MINUTE);
    expect(await service.ping(request(OWNER))).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(sent(channel, 1).nonce).not.toBe(sent(channel, 0).nonce);
  });

  it("uses the configured cooldown length", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-02T20:00:00Z") });
    const { service, request } = fixture({ SEEDING_PING_COOLDOWN_MINUTES: 15 });
    expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingSent(CHANNEL, 15 * MINUTE));
    jest.advanceTimersByTime(15 * MINUTE);
    expect(service.cooldownRemaining(GUILD)).toBe(0);
  });

  it("sends once when two staff members ping at the same moment", async () => {
    const { service, channel, request } = fixture();
    const replies = await Promise.all([service.ping(request(MODERATOR)), service.ping(request(OWNER))]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(replies.filter((reply) => reply === STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE))).toHaveLength(1);
  });

  it("gives the cooldown back when Discord definitely refused the send, without retrying", async () => {
    const { service, channel, request } = fixture();
    channel.send.mockRejectedValueOnce(discordError(50013, 403));
    expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingRefused(CHANNEL));
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(service.cooldownRemaining(GUILD)).toBe(0);
  });

  it("keeps the cooldown and never resends after an uncertain send", async () => {
    const { service, channel, request } = fixture();
    channel.send.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingUnknown(CHANNEL));
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(await service.ping(request(MODERATOR))).toMatch(/^Easy, unc/);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("refuses, without using the cooldown, when Gramps cannot notify the role in the channel", async () => {
    const { service, channel, request } = fixture();
    channel.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    expect(await service.ping(request(MODERATOR))).toBe(`${CHANNEL_PROBLEMS["cannot-mention"]} Nothing was sent.`);
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.cooldownRemaining(GUILD)).toBe(0);
  });

  it("can ping a mentionable role without the mention permission", async () => {
    const { service, channel, role, request } = fixture();
    role.mentionable = true;
    channel.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
  });

  it("trusts a channel the Seeder role can view without loading the member list", async () => {
    const { service, channel, guild, fetchAll, request } = fixture();
    // Some members are uncached, and loading them would fail, so only the role check can avoid a false heads-up.
    guild.memberCount += 40;
    fetchAll.mockRejectedValue(new Error("Members didn't arrive in time"));
    const reply = await service.ping(request(MODERATOR));
    expect(reply).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
    expect(reply).not.toContain("Heads-up");
    expect(fetchAll).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  describe("when neither @everyone nor Seeder can view the ping channel", () => {
    /** For example an @everyone View Channel deny override with no allow for Seeder. */
    function hiddenFromRole() {
      const setup = fixture();
      setup.channel.access.set(setup.role, new PermissionsBitField());
      const blind = (...ids: string[]) =>
        ids.forEach((id) => setup.channel.access.set(setup.members.get(id)!, new PermissionsBitField()));
      return { ...setup, blind };
    }

    it("refuses, without using the cooldown, when no Seeder can see it", async () => {
      const { service, channel, request, blind } = hiddenFromRole();
      blind(SEEDER_ONE, SEEDER_TWO);
      expect(await service.ping(request(MODERATOR))).toBe(`${CHANNEL_PROBLEMS.hidden} Nothing was sent.`);
      expect(channel.send).not.toHaveBeenCalled();
      expect(service.cooldownRemaining(GUILD)).toBe(0);
    });

    it("still pings when every Seeder sees it through another role", async () => {
      const { service, channel, fetchAll, request } = hiddenFromRole();
      expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
      expect(channel.send).toHaveBeenCalledTimes(1);
      // Every member is already cached, so there is nothing to load.
      expect(fetchAll).not.toHaveBeenCalled();
    });

    it("pings with a heads-up when only some Seeders can see it", async () => {
      const { service, channel, request, blind } = hiddenFromRole();
      blind(SEEDER_TWO);
      expect(await service.ping(request(MODERATOR))).toBe(
        `${STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE)}\n${CHANNEL_VIEW_WARNINGS.some(1, 2)}`,
      );
      expect(channel.send).toHaveBeenCalledTimes(1);
    });

    it("loads the full member list before deciding", async () => {
      const { service, channel, guild, fetchAll, request, blind } = hiddenFromRole();
      guild.memberCount += 40;
      blind(SEEDER_ONE, SEEDER_TWO);
      expect(await service.ping(request(MODERATOR))).toBe(`${CHANNEL_PROBLEMS.hidden} Nothing was sent.`);
      expect(fetchAll).toHaveBeenCalledWith({ time: MEMBER_LIST_TIMEOUT_MS });
      expect(channel.send).not.toHaveBeenCalled();
    });

    it.each([
      ["the member list can't be loaded", "load"],
      ["Gramps lacks the Server Members intent", "intent"],
      ["there are no Seeders yet", "empty"],
    ])("pings with a heads-up, not a refusal, when %s", async (_label, cause) => {
      const { service, channel, guild, members, fetchAll, discord, request, blind } = hiddenFromRole();
      blind(SEEDER_ONE, SEEDER_TWO);
      if (cause === "empty") for (const id of [SEEDER_ONE, SEEDER_TWO]) members.get(id)!.roles.cache.delete(ROLE);
      else guild.memberCount += 40;
      if (cause === "load") fetchAll.mockRejectedValueOnce(new Error("Members didn't arrive in time"));
      if (cause === "intent") discord.options.intents = new IntentsBitField([GatewayIntentBits.Guilds]);
      expect(await service.ping(request(MODERATOR))).toBe(
        `${STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE)}\n${CHANNEL_VIEW_WARNINGS.unknown}`,
      );
      expect(channel.send).toHaveBeenCalledTimes(1);
      if (cause === "intent") expect(fetchAll).not.toHaveBeenCalled();
    });
  });

  it("refuses an unusable channel without using the cooldown", async () => {
    const { service, channel, discord, request } = fixture();
    channel.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
    expect(await service.ping(request(MODERATOR))).toBe(`${CHANNEL_PROBLEMS.unusable} Nothing was sent.`);
    discord.channels.fetch.mockRejectedValueOnce(discordError(10003, 404));
    expect(await service.ping(request(MODERATOR))).toBe(`${CHANNEL_PROBLEMS.unusable} Nothing was sent.`);
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.cooldownRemaining(GUILD)).toBe(0);
  });

  it("refuses a missing or unsafe role, but still pings a role Gramps cannot assign", async () => {
    const { service, guild, role, me, channel, request } = fixture();
    guild.roles.fetch.mockResolvedValueOnce(null);
    expect(await service.ping(request(MODERATOR))).toBe(`${ROLE_PROBLEMS.missing} Nothing was sent.`);
    role.permissions = new PermissionsBitField([PermissionFlagsBits.BanMembers]);
    expect(await service.ping(request(MODERATOR))).toBe(`${ROLE_PROBLEMS.unsafe} Nothing was sent.`);
    role.permissions = new PermissionsBitField();
    guild.channels.cache.set(CHANNEL, {
      permissionOverwrites: {
        cache: new Collection([[ROLE, { allow: new PermissionsBitField([PermissionFlagsBits.MentionEveryone]) }]]),
      },
    });
    expect(await service.ping(request(MODERATOR))).toBe(`${ROLE_PROBLEMS.unsafe} Nothing was sent.`);
    expect(channel.send).not.toHaveBeenCalled();
    guild.channels.cache.clear();
    me.roles.highest.comparePositionTo.mockReturnValue(-1);
    expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE));
  });

  it("gives the cooldown back after an unexpected failure before sending", async () => {
    const { service, game, channel, request } = fixture();
    game.list.mockImplementationOnce(() => {
      throw new Error("registry exploded");
    });
    expect(await service.ping(request(MODERATOR))).toBe(STAFF_COPY.failed);
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.cooldownRemaining(GUILD)).toBe(0);
  });

  it("answers outside the configured server without checking anything else", async () => {
    const { service, discord } = fixture();
    expect(await service.ping({ guildId: OTHER_GUILD, userId: MODERATOR })).toBe(MEMBER_COPY.outsideGuild);
    expect(discord.guilds.fetch).not.toHaveBeenCalled();
  });
});

describe("/seeding status", () => {
  it("summarises a ready setup with the Seeder count and cooldown", async () => {
    const { service, request } = fixture();
    const reply = await service.status(request(MODERATOR));
    expect(reply).toContain("Configured: yes, ready to ping.");
    expect(reply).toContain("Switch: on");
    expect(reply).toContain(`Seeder role: <@&${ROLE}>. Ready.`);
    expect(reply).toContain(`Ping channel: <#${CHANNEL}>. Ready.`);
    expect(reply).toContain("Seeders: 12.");
    expect(reply).toContain("Ping cooldown: 2 h. Ready now.");
    expect(reply).not.toContain(MENTIONABLE_WARNING);
    expect(reply).not.toContain("Heads-up");
  });

  it("shows the cooldown remaining after a ping", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-02T20:00:00Z") });
    const { service, request } = fixture();
    await service.ping(request(MODERATOR));
    jest.advanceTimersByTime(5 * MINUTE);
    expect(await service.status(request(MODERATOR))).toContain("Next ping opens in 1 h 55 min.");
  });

  it("works while the feature is off and lists what is missing", async () => {
    const { service, request } = fixture({
      SEEDING_ENABLED: false,
      SEEDING_ROLE_ID: undefined,
      SEEDING_PING_CHANNEL_ID: undefined,
    });
    const reply = await service.status(request(MODERATOR));
    expect(reply).toContain("Configured: not yet.");
    expect(reply).toContain("Switch: off");
    expect(reply).toContain("Seeder role: not set (`SEEDING_ROLE_ID`).");
    expect(reply).toContain("Ping channel: not set (`SEEDING_PING_CHANNEL_ID`).");
    expect(reply).toContain("Seeders: unknown.");
  });

  it("explains role and channel problems", async () => {
    const { service, me, channel, request } = fixture();
    me.roles.highest.comparePositionTo.mockReturnValue(-1);
    channel.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    const reply = await service.status(request(MODERATOR));
    expect(reply).toContain("Configured: not yet.");
    expect(reply).toContain(ROLE_PROBLEMS.unassignable);
    expect(reply).toContain(CHANNEL_PROBLEMS["cannot-mention"]);
  });

  it("reports a ping channel no Seeder can see as not ready", async () => {
    const { service, channel, role, members, request } = fixture();
    // An @everyone View Channel deny, with no allow for Seeder or any role the Seeders have.
    for (const target of [role, members.get(SEEDER_ONE)!, members.get(SEEDER_TWO)!])
      channel.access.set(target, new PermissionsBitField());
    const reply = await service.status(request(MODERATOR));
    expect(reply).toContain("Configured: not yet.");
    expect(reply).toContain(`Ping channel: <#${CHANNEL}>. ${CHANNEL_PROBLEMS.hidden}`);
  });

  it("trusts a ping channel the Seeder role can view without loading the member list", async () => {
    const { service, guild, fetchAll, request } = fixture();
    guild.memberCount += 40;
    fetchAll.mockRejectedValue(new Error("Members didn't arrive in time"));
    const reply = await service.status(request(MODERATOR));
    expect(reply).toContain("Configured: yes, ready to ping.");
    expect(reply).toContain(`Ping channel: <#${CHANNEL}>. Ready.`);
    expect(reply).not.toContain("Heads-up");
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("stays ready but warns when Seeders might not see the ping channel", async () => {
    const { service, channel, role, members, guild, fetchAll, request } = fixture();
    channel.access.set(role, new PermissionsBitField());
    channel.access.set(members.get(SEEDER_TWO)!, new PermissionsBitField());
    const some = await service.status(request(MODERATOR));
    expect(some).toContain("Configured: yes, ready to ping.");
    expect(some).toContain(`Ping channel: <#${CHANNEL}>. Ready.`);
    expect(some).toContain(CHANNEL_VIEW_WARNINGS.some(1, 2));
    guild.memberCount += 40;
    fetchAll.mockRejectedValueOnce(new Error("Members didn't arrive in time"));
    const unknown = await service.status(request(MODERATOR));
    expect(unknown).toContain("Configured: yes, ready to ping.");
    expect(unknown).toContain(CHANNEL_VIEW_WARNINGS.unknown);
  });

  it("falls back to the cached member count and warns when anyone can mention the role", async () => {
    const { service, guild, role, request } = fixture();
    guild.roles.fetchMemberCounts.mockRejectedValueOnce(new Error("rate limited"));
    role.mentionable = true;
    const reply = await service.status(request(MODERATOR));
    expect(reply).toContain("Seeders: at least 2 (from cache).");
    expect(reply).toContain(MENTIONABLE_WARNING);
  });

  it("is staff only", async () => {
    const { service, request } = fixture();
    for (const userId of [MEMBER, VIEWER, ROLE_MANAGER, DISCORD_ADMIN])
      expect(await service.status(request(userId))).toBe(STAFF_COPY.staffOnly);
  });

  it("names ADMIN_GUILD_ID only to an owner when it is missing", async () => {
    const { service, request } = fixture({ ADMIN_GUILD_ID: undefined });
    expect(await service.status(request(OWNER))).toBe(STAFF_COPY.guildUnset);
    expect(await service.status(request(MEMBER))).toBe(MEMBER_COPY.unconfigured);
  });

  it("answers safely when Discord fails unexpectedly", async () => {
    const { service, guild, request } = fixture();
    guild.members.fetch.mockRejectedValueOnce(new Error("gateway offline"));
    expect(await service.status(request(MODERATOR))).toBe(STAFF_COPY.failed);
  });
});
