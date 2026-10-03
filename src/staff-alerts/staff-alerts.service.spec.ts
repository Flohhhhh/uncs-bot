import { Logger } from "@nestjs/common";
import { ChannelType, Client, PermissionFlagsBits } from "discord.js";
import { createHash } from "node:crypto";
import { StaffAlerts, type StaffAlertInput } from "./staff-alerts.service";
import type { EnvService } from "../env/env.service";

const guild = "234567890123456789",
  alerts = "345678901234567890",
  votes = "456789012345678901",
  community = "567890123456789012",
  leaderboard = "567890123456789013";
const steamId = "76561198000000001";
type Permission = bigint;
type Rich = ReturnType<typeof richFixture>;
function richFixture(environment: Record<string, unknown> = {}) {
  const everyoneRole = { id: guild };
  const pingRole = "678901234567890123";
  // A staff role set up as the guide says: anyone may @mention it.
  const role = { id: pingRole, mentionable: true };
  let botAllowed: Permission[] = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  let everyoneCanView = false;
  const me = { id: "bot" };
  const channel = {
    id: alerts,
    type: ChannelType.GuildText as ChannelType,
    guildId: guild,
    guild: {
      members: { me, fetchMe: jest.fn().mockResolvedValue(me) },
      roles: { everyone: everyoneRole, cache: new Map([[pingRole, role]]) },
    },
    permissionsFor: jest.fn((target: unknown) => ({
      has: (wanted: Permission | Permission[]) => {
        const list = Array.isArray(wanted) ? wanted : [wanted];
        if (target === everyoneRole)
          return everyoneCanView && list.every((item) => item === PermissionFlagsBits.ViewChannel);
        return list.every((item) => botAllowed.includes(item));
      },
    })),
    send: jest.fn().mockResolvedValue({ id: "999999999999999999" }),
    messages: { edit: jest.fn().mockResolvedValue({}) },
  };
  let ready = true;
  const client = { isReady: () => ready, channels: { fetch: jest.fn().mockResolvedValue(channel) } };
  const env: Record<string, unknown> = {
    ADMIN_GUILD_ID: guild,
    STAFF_ALERTS_CHANNEL_ID: alerts,
    MAP_VOTES_CHANNEL_ID: votes,
    SERVER_COMMUNITY_DISCORD_CHANNEL_ID: community,
    WEEKLY_LEADERBOARD_CHANNEL_ID: leaderboard,
    STAFF_ALERTS_PING_ROLE_ID: pingRole,
    ...environment,
  };
  const service = new StaffAlerts(client as unknown as Client, { get: (key: string) => env[key] } as EnvService);
  return {
    service,
    channel,
    client,
    env,
    pingRole,
    role,
    allow: (permission: Permission) => botAllowed.push(permission),
    deny: (permission: Permission) => (botAllowed = botAllowed.filter((item) => item !== permission)),
    makePublic: () => (everyoneCanView = true),
    offline: () => (ready = false),
  };
}
let keys = 0;
const input = (overrides: Partial<StaffAlertInput> = {}): StaffAlertInput => ({
  serverId: "primary",
  serverName: "The UNCs",
  kind: "game-down",
  severity: "high",
  key: `down:${keys++}`,
  title: "Game unreachable for 10 min",
  lines: ["Could not reach RCON since 04:01 ET.", "Inferred from RCON reads.", "Gramps took no action."],
  deliver: true,
  ...overrides,
});
const sent = (rich: Rich, index: number) => rich.channel.send.mock.calls[index][0];

describe("alert-only staff alert delivery", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("posts an embed only, coloured by severity, with a footer naming the server and alert", async () => {
    const rich = richFixture({ STAFF_ALERTS_PING_ROLE_ID: undefined });
    const colors = [
      ["info", 0x95a5a6],
      ["warning", 0xe6a23c],
      ["high", 0xe74c3c],
    ] as const;
    for (const [index, [severity, color]] of colors.entries()) {
      const alert = await rich.service.raise(input({ severity }));
      expect(alert?.delivery).toEqual({ state: "posted", reason: null });
      const options = sent(rich, index);
      expect(options.content).toBeUndefined();
      expect(options.embeds).toEqual([
        expect.objectContaining({
          title: "Game unreachable for 10 min",
          color,
          footer: { text: `Gramps · The UNCs · alert ${alert!.id}` },
          timestamp: alert!.createdAt,
        }),
      ]);
      expect(options.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
    }
  });

  it("uses a deterministic nonce from the alert ID and asks Discord to enforce it", async () => {
    const rich = richFixture();
    const alert = await rich.service.raise(input({ severity: "info" }));
    expect(sent(rich, 0).enforceNonce).toBe(true);
    expect(sent(rich, 0).nonce).toBe(
      createHash("sha256").update(`gramps-staff-alert:${alert!.id}`).digest("hex").slice(0, 25),
    );
  });

  it("pings the role only for high alerts, at most every 30 minutes, never for performance", async () => {
    const rich = richFixture();
    await rich.service.raise(input({ severity: "warning" }));
    expect(sent(rich, 0).content).toBeUndefined();
    expect((await rich.service.raise(input()))?.pinged).toBe(true);
    expect(sent(rich, 1)).toMatchObject({
      content: `<@&${rich.pingRole}>`,
      allowedMentions: { parse: [], users: [], roles: [rich.pingRole], repliedUser: false },
    });
    expect((await rich.service.raise(input()))?.pinged).toBe(false);
    expect(sent(rich, 2).allowedMentions.roles).toEqual([]);
    jest.setSystemTime(now + 30 * 60_000);
    expect((await rich.service.raise(input({ kind: "performance-window", severity: "high" })))?.pinged).toBe(false);
    expect((await rich.service.raise(input({ kind: "seeding-prime" })))?.pinged).toBe(true);
  });

  it("pings once for high alerts from two servers raised at the same time", async () => {
    const rich = richFixture();
    rich.channel.send.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ id: "999999999999999999" }), 50)),
    );
    const both = Promise.all([
      rich.service.raise(input({ serverId: "eu" })),
      rich.service.raise(input({ serverId: "us" })),
    ]);
    await jest.advanceTimersByTimeAsync(50);
    const alerts = await both;
    expect(alerts.map((alert) => alert?.delivery.state)).toEqual(["posted", "posted"]);
    expect(alerts.filter((alert) => alert?.pinged)).toHaveLength(1);
    expect(rich.channel.send.mock.calls.filter(([options]) => options.content)).toHaveLength(1);
  });

  it("frees the ping for the next high alert when the send fails", async () => {
    const rich = richFixture();
    rich.channel.send.mockRejectedValueOnce(new Error("Discord unavailable"));
    expect(await rich.service.raise(input())).toMatchObject({ pinged: false, delivery: { state: "failed" } });
    expect((await rich.service.raise(input()))?.pinged).toBe(true);
    expect(sent(rich, 1).content).toBe(`<@&${rich.pingRole}>`);
  });

  it.each([
    ["the @everyone role (the guild ID)", { STAFF_ALERTS_PING_ROLE_ID: guild }, "invalid", "invalid"],
    ["a role missing from the guild", { STAFF_ALERTS_PING_ROLE_ID: "789012345678901234" }, "ok", "invalid"],
    ["no role", { STAFF_ALERTS_PING_ROLE_ID: undefined }, "off", "off"],
  ])("never pings %s", async (_, environment, state, status) => {
    const rich = richFixture(environment);
    expect(rich.service.pingState()).toBe(state);
    await expect(rich.service.channelStatus()).resolves.toMatchObject({ state: "ok", ping: status });
    expect((await rich.service.raise(input()))?.pinged).toBe(false);
    expect(sent(rich, 0).content).toBeUndefined();
    expect(sent(rich, 0).allowedMentions.roles).toEqual([]);
  });

  it("pings only when Discord would notify the role: it is mentionable, or Gramps may mention all roles there", async () => {
    const rich = richFixture();
    rich.role.mentionable = false;
    await expect(rich.service.channelStatus()).resolves.toEqual({
      configured: true,
      state: "ok",
      ping: "not-mentionable",
    });
    const quiet = await rich.service.raise(input());
    expect(quiet).toMatchObject({ pinged: false, delivery: { state: "posted", reason: null } });
    expect(sent(rich, 0).content).toBeUndefined();
    expect(sent(rich, 0).allowedMentions.roles).toEqual([]);
    // Staff grant Mention @everyone, @here, and All Roles on the channel; Gramps never changes the role.
    rich.allow(PermissionFlagsBits.MentionEveryone);
    await expect(rich.service.channelStatus()).resolves.toMatchObject({ ping: "ok" });
    // The unpinged alert used up no ping, so the next high alert pings at once.
    expect((await rich.service.raise(input()))?.pinged).toBe(true);
    expect(sent(rich, 1).content).toBe(`<@&${rich.pingRole}>`);
    expect(rich.role).toEqual({ id: rich.pingRole, mentionable: false });
  });

  /** Label, change, reason, and whether the channel is fetched at all (refused from the settings alone if not). */
  const refusals: [string, (rich: Rich) => void, string, boolean][] = [
    ["no staff channel", (rich) => delete rich.env.STAFF_ALERTS_CHANNEL_ID, "no staff channel", false],
    ["no staff guild", (rich) => delete rich.env.ADMIN_GUILD_ID, "wrong-guild", false],
    ["the voting channel", (rich) => (rich.env.STAFF_ALERTS_CHANNEL_ID = votes), "community-channel", false],
    ["the community channel", (rich) => (rich.env.STAFF_ALERTS_CHANNEL_ID = community), "community-channel", false],
    [
      "the weekly leaderboard channel",
      (rich) => (rich.env.STAFF_ALERTS_CHANNEL_ID = leaderboard),
      "community-channel",
      false,
    ],
    [
      "a server status channel",
      (rich) => (rich.env.WARDOGS_SERVERS = [{ communityStatus: { channelId: alerts, messageId: "1".repeat(18) } }]),
      "community-channel",
      false,
    ],
    ["another guild", (rich) => (rich.channel.guildId = "999999999999999999"), "wrong-guild", true],
    ["not a text channel", (rich) => (rich.channel.type = ChannelType.GuildVoice), "not-text", true],
    ["visible to @everyone", (rich) => rich.makePublic(), "public", true],
    ["missing Embed Links", (rich) => rich.deny(PermissionFlagsBits.EmbedLinks), "missing-permissions", true],
    [
      "missing Read Message History",
      (rich) => rich.deny(PermissionFlagsBits.ReadMessageHistory),
      "missing-permissions",
      true,
    ],
    ["Discord offline", (rich) => rich.offline(), "discord-offline", false],
  ];
  it.each(refusals)("records a failed delivery without throwing for %s", async (_, change, reason, fetches) => {
    const rich = richFixture();
    change(rich);
    await expect(rich.service.raise(input())).resolves.toMatchObject({ delivery: { state: "failed", reason } });
    expect(rich.client.channels.fetch).toHaveBeenCalledTimes(fetches ? 1 : 0);
    expect(rich.channel.send).not.toHaveBeenCalled();
  });

  it("records a Discord send failure without throwing", async () => {
    const rich = richFixture();
    rich.channel.send.mockRejectedValue(new Error("token and network details"));
    await expect(rich.service.raise(input())).resolves.toMatchObject({
      delivery: { state: "failed", reason: "discord error" },
    });
  });

  it("reports the channel state for the status without posting", async () => {
    const ok = richFixture();
    await expect(ok.service.channelStatus()).resolves.toEqual({ configured: true, state: "ok", ping: "ok" });
    const open = richFixture();
    open.makePublic();
    await expect(open.service.channelStatus()).resolves.toMatchObject({ state: "public" });
    expect(open.channel.send).not.toHaveBeenCalled();
  });

  it("makes no Discord call in observe mode and records the alert", async () => {
    const rich = richFixture();
    const alert = await rich.service.raise(input({ kind: "performance-window", severity: "warning", deliver: false }));
    expect(alert?.delivery).toEqual({ state: "observe", reason: null });
    expect(rich.client.channels.fetch).not.toHaveBeenCalled();
    expect(rich.channel.send).not.toHaveBeenCalled();
    expect(rich.service.list("primary")).toHaveLength(1);
  });

  it("applies hourly limits per category and server, recording what it holds back", async () => {
    const rich = richFixture({ STAFF_ALERTS_PERFORMANCE_MAX_PER_HOUR: 2 });
    for (let index = 0; index < 4; index++) await rich.service.raise(input({ kind: "game-restart", severity: "info" }));
    for (let index = 0; index < 3; index++)
      await rich.service.raise(input({ kind: "seeding-after-restart", severity: "warning" }));
    // Health and seeding share six an hour.
    expect(rich.channel.send).toHaveBeenCalledTimes(6);
    expect(rich.service.list("primary")[0].delivery).toEqual({ state: "suppressed", reason: "hourly limit" });
    for (let index = 0; index < 3; index++)
      await rich.service.raise(input({ kind: "performance-window", severity: "warning" }));
    expect(rich.channel.send).toHaveBeenCalledTimes(8);
    for (let index = 0; index < 7; index++)
      await rich.service.raise(input({ kind: "watchlist-join", severity: "warning" }));
    expect(rich.channel.send).toHaveBeenCalledTimes(14);
    await rich.service.raise(input({ serverId: "event", kind: "game-restart", severity: "info" }));
    expect(rich.channel.send).toHaveBeenCalledTimes(15);
    expect(rich.service.list("primary").filter((alert) => alert.delivery.state === "suppressed")).toHaveLength(3);
    jest.setSystemTime(now + 60 * 60_000 + 1);
    expect((await rich.service.raise(input({ kind: "game-restart", severity: "info" })))?.delivery.state).toBe(
      "posted",
    );
  });

  it("raises one alert per key within its repeat window", async () => {
    const rich = richFixture();
    expect(await rich.service.raise(input({ key: "watch:1", repeatMs: 60_000 }))).not.toBeNull();
    expect(await rich.service.raise(input({ key: "watch:1", repeatMs: 60_000 }))).toBeNull();
    expect(await rich.service.raise(input({ key: "watch:1", serverId: "event", repeatMs: 60_000 }))).not.toBeNull();
    jest.setSystemTime(now + 60_000);
    expect(await rich.service.raise(input({ key: "watch:1", repeatMs: 60_000 }))).not.toBeNull();
    expect(rich.channel.send).toHaveBeenCalledTimes(3);
  });

  it("keeps at most 200 records per server and 1,000 in all, oldest first out", async () => {
    const rich = richFixture();
    for (let index = 0; index < 205; index++)
      await rich.service.raise(input({ title: `Alert ${index}`, deliver: false }));
    expect(rich.service.list("primary")).toHaveLength(100);
    expect(rich.service.list("primary")[0].title).toBe("Alert 204");
    for (let server = 0; server < 5; server++)
      for (let index = 0; index < 200; index++)
        await rich.service.raise(input({ serverId: `s${server}`, title: `Server ${server}`, deliver: false }));
    expect(rich.service.list("primary")).toHaveLength(0);
    expect(rich.service.list("s0")).toHaveLength(100);
    expect(rich.service.list("s4")).toHaveLength(100);
    await rich.service.raise(input({ serverId: "s5", deliver: false }));
    expect(rich.service.list("s5")).toHaveLength(1);
    // The oldest record overall (from s0) made room.
    expect(rich.service.list("s0")[99].title).toBe("Server 0");
  });

  it("logs only the alert ID, kind, server and delivery: never a SteamID, name or text", async () => {
    const rich = richFixture();
    const name = "Sneaky Name";
    await rich.service.raise(
      input({
        kind: "performance-window",
        severity: "warning",
        player: { steamId, name },
        lines: [`${name} had 31 kills in 5 min (6.2/min).`],
      }),
    );
    const logged = [
      ...(Logger.prototype.log as jest.Mock).mock.calls,
      ...(Logger.prototype.warn as jest.Mock).mock.calls,
    ].map((call: unknown[]) => String(call[0]));
    expect(logged).toEqual([expect.stringMatching(/^Staff alert [a-f0-9]{12} performance-window primary posted$/)]);
    expect(logged.join(" ")).not.toContain(steamId);
    expect(logged.join(" ")).not.toContain(name);
  });

  it("escapes game-controlled names so they cannot format or mention", async () => {
    const rich = richFixture();
    const name = "@everyone **x** <@&678901234567890123>";
    await rich.service.raise(
      input({ kind: "watchlist-join", severity: "warning", player: { steamId, name }, lines: [`${name} joined.`] }),
    );
    const embed = sent(rich, 0).embeds[0];
    const field = (label: string) => embed.fields.find((item: { name: string }) => item.name === label).value;
    expect(field("Player")).toContain("\\*\\*x\\*\\*");
    expect(field("Player")).not.toMatch(/@everyone|<@&/);
    expect(embed.description).not.toMatch(/@everyone|<@&/);
    expect(field("SteamID")).toBe(`\`${steamId}\``);
    expect(rich.service.list("primary")[0].player!.name).toBe(name);
  });

  it.each([
    ["[x](https://evil.example)", "\\[x\\](https://evil.example)"],
    ["-# x", "\\-# x"],
    ["# x", "\\# x"],
    ["> x", "\\> x"],
    ["<:x __y__", "<\u200b:x \\_\\_y\\_\\_"],
    ["<x:/*y*", "<\u200bx:/\\*y\\*"],
    ["<x:/_y_", "<\u200bx:/\\_y\\_"],
    ["<t:0:R>", "<\u200bt:0:R>"],
  ])(
    "escapes the name %s so it cannot render as a link, heading, subtext, quote, italics or timestamp",
    async (name, shown) => {
      const rich = richFixture();
      await rich.service.raise(
        input({
          kind: "watchlist-join",
          severity: "warning",
          player: { steamId, name },
          lines: [`${name} joined.`, `Reason: ${name}.`],
        }),
      );
      const embed = sent(rich, 0).embeds[0];
      const [first, reason] = embed.description.split("\n");
      expect(embed.fields.find((item: { name: string }) => item.name === "Player").value).toBe(shown);
      expect(first).toBe(`${shown} joined.`);
      expect(reason).not.toMatch(/(?<!\\)[[\]*_]|<[^\u200b]/);
    },
  );

  it("adds no dashboard button until the dashboard can show the alert", async () => {
    const off = richFixture();
    await off.service.raise(input());
    expect(sent(off, 0).components).toBeUndefined();
    const on = richFixture({ ADMIN_ENABLED: true, ADMIN_ORIGIN: "https://admin.example.test/" });
    await on.service.raise(input({ player: { steamId, name: "Player" } }));
    expect(sent(on, 0).components).toBeUndefined();
    expect(JSON.stringify(sent(on, 0))).not.toContain("admin.example.test");
  });

  it("shows only safe https evidence links, as autolinks", async () => {
    const rich = richFixture();
    await rich.service.raise(
      input({
        kind: "watchlist-join",
        severity: "warning",
        links: ["https://example.com/clip_1", "javascript:alert(1)", "https://example.com/a b", "https://x.test/`y`"],
      }),
    );
    const evidence = sent(rich, 0).embeds[0].fields.find((item: { name: string }) => item.name === "Evidence");
    expect(evidence.value).toBe("<https://example.com/clip_1>");
  });

  it("records snoozed alerts without posting them and clears the snooze", async () => {
    const rich = richFixture();
    rich.service.snooze("primary", "seeding", 60, "Mod");
    expect((await rich.service.raise(input({ kind: "seeding-prime" })))?.delivery.state).toBe("snoozed");
    expect((await rich.service.raise(input({ kind: "game-down" })))?.delivery.state).toBe("posted");
    expect((await rich.service.raise(input({ serverId: "event", kind: "seeding-prime" })))?.delivery.state).toBe(
      "posted",
    );
    rich.service.snooze("primary", "all", 15, "Mod");
    const watch = await rich.service.raise(input({ kind: "watchlist-join", severity: "warning" }));
    expect(watch?.delivery.state).toBe("snoozed");
    expect(rich.service.activeSnoozes("primary").map((item) => item.category)).toEqual(["seeding", "all"]);
    rich.service.snooze("primary", "all", 0, "Mod");
    rich.service.snooze("primary", "seeding", 0, "Mod");
    expect(rich.service.activeSnoozes("primary")).toEqual([]);
    expect(() => rich.service.snooze("primary", "health", 10, "Mod")).toThrow("15 to 1440");
    expect(rich.channel.send).toHaveBeenCalledTimes(2);
  });

  it("records reviews in memory and edits the Discord footer on a best-effort basis", async () => {
    const rich = richFixture();
    const alert = await rich.service.raise(
      input({ kind: "performance-match", severity: "warning", player: { steamId, name: "Regular" } }),
    );
    rich.channel.messages.edit.mockRejectedValueOnce(new Error("Missing access"));
    const legit = await rich.service.review("primary", alert!.id, "legit", { name: "Mod One" });
    expect(legit.alert.review).toMatchObject({ decision: "legit", by: "Mod One" });
    expect(legit.knownGoodEntry).toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining("could not be shown in Discord"));
    const never = await rich.service.review("primary", alert!.id, "never", { name: "Mod One" });
    expect(rich.channel.messages.edit).toHaveBeenLastCalledWith("999999999999999999", {
      embeds: [
        expect.objectContaining({ footer: { text: `Gramps · The UNCs · alert ${alert!.id} · Never flag (Mod One)` } }),
      ],
    });
    expect(rich.service.sessionNever().has(steamId)).toBe(true);
    expect(JSON.parse(never.knownGoodEntry!)).toEqual({ steamId, note: "never flag: Mod One, 2026-10-02" });
    expect(rich.channel.send).toHaveBeenCalledTimes(1);
  });

  it("refuses legit for non-performance alerts and unknown or other-server alerts", async () => {
    const rich = richFixture();
    const down = await rich.service.raise(input());
    await expect(rich.service.review("primary", down!.id, "legit", { name: "Mod" })).rejects.toThrow(
      "Only performance alerts",
    );
    await expect(rich.service.review("primary", down!.id, "ack", { name: "Mod" })).resolves.toMatchObject({
      alert: { review: { decision: "ack" } },
    });
    await expect(rich.service.review("event", down!.id, "ack", { name: "Mod" })).rejects.toThrow("no longer available");
    await expect(rich.service.review("primary", "aaaaaaaaaaaa", "ack", { name: "Mod" })).rejects.toThrow(
      "no longer available",
    );
  });

  it("amends an earlier alert in memory only", async () => {
    const rich = richFixture();
    await rich.service.raise(input({ kind: "performance-window", severity: "warning", key: "perf:1:r" }));
    jest.setSystemTime(now + 60_000);
    const amended = rich.service.amend("primary", "perf:1:r", { lines: ["Both rules matched."], facts: { kd: 22 } });
    expect(amended).toMatchObject({ lines: ["Both rules matched."], facts: { kd: 22 } });
    expect(amended!.updatedAt).not.toBe(amended!.createdAt);
    expect(rich.service.amend("primary", "perf:missing", { lines: [] })).toBeNull();
    expect(rich.channel.send).toHaveBeenCalledTimes(1);
  });

  it("takes a later rule's kind and title when amending", async () => {
    const rich = richFixture();
    await rich.service.raise(
      input({ kind: "performance-match", severity: "warning", key: "perf:2:r", title: "Review: unusual round K/D" }),
    );
    expect(
      rich.service.amend("primary", "perf:2:r", { kind: "performance-window", title: "Review: unusual kill rate" }),
    ).toMatchObject({ kind: "performance-window", category: "performance", title: "Review: unusual kill rate" });
  });

  describe("map-vote and 50v50 automation through send()", () => {
    it("posts once per issue as an embed without mentions, then again after 30 minutes", async () => {
      const rich = richFixture();
      expect(await rich.service.send("primary", "review:1", "Ballot @everyone needs review.\nCheck it.")).toBe(true);
      expect(rich.client.channels.fetch).toHaveBeenCalledWith(alerts);
      const options = sent(rich, 0);
      expect(options.content).toBeUndefined();
      expect(options.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
      expect(options.embeds).toEqual([
        expect.objectContaining({
          title: "Automation needs a person",
          color: 0xe6a23c,
          description: expect.stringContaining("needs review. Check it."),
        }),
      ]);
      expect(options.embeds[0].description).not.toMatch(/@everyone/);
      expect(await rich.service.send("primary", "review:1", "Again")).toBe(false);
      expect(await rich.service.send("event", "review:1", "Other server")).toBe(true);
      jest.setSystemTime(now + 30 * 60_000);
      expect(await rich.service.send("primary", "review:1", "Still waiting")).toBe(true);
      expect(rich.channel.send).toHaveBeenCalledTimes(3);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(4);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        "Staff alert for primary: Ballot @everyone needs review. Check it.",
      );
    });

    it("names the configured server in the footer, as monitor alerts do, or its ID when unknown", async () => {
      const legacy = richFixture();
      await legacy.service.send("primary", "review:1", "Needs review");
      await legacy.service.send("event", "review:1", "Needs review");
      const [primary, other] = [legacy.service.list("primary")[0], legacy.service.list("event")[0]];
      expect(sent(legacy, 0).embeds[0].footer).toEqual({ text: `Gramps · The UNCs · alert ${primary.id}` });
      expect(sent(legacy, 1).embeds[0].footer).toEqual({ text: `Gramps · event · alert ${other.id}` });
      const configured = richFixture({
        WARDOGS_SERVERS: [
          { id: "primary", name: "UNCs Primary" },
          { id: "event", name: "UNCs Event" },
        ],
      });
      await configured.service.send("event", "review:1", "Needs review");
      const alert = configured.service.list("event")[0];
      expect(sent(configured, 0).embeds[0].footer).toEqual({ text: `Gramps · UNCs Event · alert ${alert.id}` });
    });

    it("posts at most ten a server an hour, apart from the monitoring limits", async () => {
      const rich = richFixture();
      for (let index = 0; index < 12; index++) await rich.service.send("primary", `issue:${index}`, "Alert");
      expect(rich.channel.send).toHaveBeenCalledTimes(10);
      expect(
        rich.service
          .list("primary")
          .slice(0, 2)
          .map((alert) => alert.delivery),
      ).toEqual([
        { state: "suppressed", reason: "hourly limit" },
        { state: "suppressed", reason: "hourly limit" },
      ]);
      expect((await rich.service.raise(input({ kind: "game-restart", severity: "info" })))?.delivery.state).toBe(
        "posted",
      );
      expect(await rich.service.send("event", "issue:0", "Alert")).toBe(true);
      jest.setSystemTime(now + 60 * 60_000 + 1);
      expect(await rich.service.send("primary", "issue:12", "Alert")).toBe(true);
    });

    it("never pings, and leaves the ping for the next high alert", async () => {
      const rich = richFixture();
      await expect(rich.service.channelStatus()).resolves.toMatchObject({ ping: "ok" });
      expect(await rich.service.send("primary", "event-lock-off:1", "Team lock is OFF.")).toBe(true);
      expect(sent(rich, 0).content).toBeUndefined();
      expect(sent(rich, 0).allowedMentions.roles).toEqual([]);
      expect(rich.service.list("primary")[0]).toMatchObject({ kind: "automation", pinged: false });
      expect((await rich.service.raise(input({ kind: "automation" })))?.pinged).toBe(false);
      expect((await rich.service.raise(input()))?.pinged).toBe(true);
    });

    it.each(refusals)("refuses %s like any other alert, without throwing", async (_, change, reason, fetches) => {
      const rich = richFixture();
      change(rich);
      await expect(rich.service.send("primary", "map-vote-review:1", "Needs review")).resolves.toBe(false);
      expect(rich.client.channels.fetch).toHaveBeenCalledTimes(fetches ? 1 : 0);
      expect(rich.channel.send).not.toHaveBeenCalled();
      expect(rich.service.list("primary")[0]).toMatchObject({
        kind: "automation",
        delivery: { state: "failed", reason },
      });
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining("Needs review"));
    });

    it("never throws into a worker when Discord refuses the send", async () => {
      const rich = richFixture();
      rich.channel.send.mockRejectedValue(new Error("token and network details"));
      await expect(rich.service.send("primary", "issue", "Needs review")).resolves.toBe(false);
      expect(rich.service.list("primary")[0].delivery).toEqual({ state: "failed", reason: "discord error" });
    });

    it("is never held back by a snooze and is recorded for the staff status, acknowledgement only", async () => {
      const rich = richFixture();
      rich.service.snooze("primary", "all", 60, "Mod");
      expect(
        await rich.service.send("primary", "map-vote-brake:1", "UNCs Primary: Paused after 3 refused results."),
      ).toBe(true);
      const [alert] = rich.service.list("primary");
      expect(alert).toMatchObject({
        kind: "automation",
        category: "automation",
        severity: "warning",
        title: "Automation needs a person",
        lines: ["UNCs Primary: Paused after 3 refused results."],
        delivery: { state: "posted", reason: null },
      });
      await expect(rich.service.review("primary", alert.id, "legit", { name: "Mod" })).rejects.toThrow(
        "Only performance alerts",
      );
      await expect(rich.service.review("primary", alert.id, "ack", { name: "Mod" })).resolves.toMatchObject({
        alert: { review: { decision: "ack" } },
      });
    });
  });
});
