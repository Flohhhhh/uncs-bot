import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { ChannelType, DiscordAPIError, MessageFlags, SnowflakeUtil, type Client } from "discord.js";
import { createHash } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import type { GameServers } from "../admin/game-servers";
import type { GameServerSummary } from "../common/game-server";
import type { EnvService } from "../env/env.service";
import type { TelemetryService } from "../telemetry/telemetry.service";
import type { TelemetryStore } from "../telemetry/telemetry.store";
import type { CombatAggregate } from "../telemetry/telemetry.types";
import { FIXTURE_IDS, FIXTURE_SLOT, fixtureAggregate, fixtureHighlights, fixtureRows } from "./weekly-fixtures";
import { WeeklyLeaderboardDiscord, firstSnowflakeAt, weeklyNonce } from "./weekly-leaderboard.discord";
import {
  ADMIN_ONLY_MESSAGE,
  CHECK_INTERVAL_MS,
  STARTUP_DELAY_MS,
  WeeklyLeaderboardService,
} from "./weekly-leaderboard.service";
import { weeklyMarker } from "./weekly-render";

const BOT = "300000000000000001",
  OTHER_USER = "300000000000000002",
  GUILD = "200000000000000001",
  CHANNEL = "100000000000000001";
const HOUR = 3_600_000;
const W40 = { since: new Date("2026-09-28T00:00:00.000Z"), until: new Date("2026-10-04T23:59:59.999Z") };
const primary: GameServerSummary = { id: "primary", name: "The UNCs", version: "0".repeat(64) };
const admin: Staff = { id: "400000000000000001", name: "Admin", role: "admin", csrf: "csrf", serverId: "primary" };
const viewer: Staff = { ...admin, id: "400000000000000002", role: "viewer" };
const moderator: Staff = { ...admin, id: "400000000000000003", role: "moderator" };
type FakeMessage = { id: string; author: { id: string }; content: string };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture(overrides: Record<string, unknown> = {}, definitions: GameServerSummary[] = [primary]) {
  const values: Record<string, unknown> = {
    WEEKLY_LEADERBOARD_ENABLED: true,
    WEEKLY_LEADERBOARD_CHANNEL_ID: CHANNEL,
    ADMIN_GUILD_ID: GUILD,
    WEEKLY_LEADERBOARD_DAY: "sunday",
    WEEKLY_LEADERBOARD_TIME: "20:00",
    WEEKLY_LEADERBOARD_MIN_KILLS: 100,
    WEEKLY_LEADERBOARD_MIN_PLAYERS: 10,
    ...overrides,
  };
  const store = {
    tracking: jest.fn(async (_serverId: string) => ({
      firstReceivedAt: new Date("2026-09-20T00:00:00Z"),
      lastReceivedAt: new Date("2026-10-04T23:00:00Z"),
    })),
    snapshot: jest.fn(async (..._args: unknown[]): Promise<CombatAggregate> => fixtureAggregate()),
    weeklyHighlights: jest.fn(async (..._args: unknown[]) => fixtureHighlights()),
  };
  const telemetry = { feedAvailable: jest.fn((_serverId: string) => true) };
  const servers = {
    list: () => definitions,
    resolve: (id?: string) => {
      if (!id && definitions.length > 1) throw new BadRequestException("Select a game server before continuing.");
      const selected = id ?? "primary";
      if (!definitions.some((server) => server.id === selected))
        throw new NotFoundException("Choose a configured game server.");
      return selected;
    },
  };
  const history: FakeMessage[] = [];
  const channel = {
    id: CHANNEL,
    type: ChannelType.GuildText as ChannelType,
    guildId: GUILD,
    allowed: true,
    permissionsFor: jest.fn(() => ({ has: jest.fn(() => channel.allowed) })),
    messages: {
      fetch: jest.fn(async ({ after, limit }: { after: string; limit: number; cache?: boolean }) => {
        const page = history.filter((message) => BigInt(message.id) > BigInt(after)).slice(0, limit);
        return new Map(page.map((message) => [message.id, message]));
      }),
    },
    send: jest.fn(async (payload: { content: string }) => {
      const message = { id: snowflake(Date.now(), history.length), author: { id: BOT }, content: payload.content };
      history.push(message);
      return message;
    }),
  };
  const client = {
    ready: true,
    isReady() {
      return this.ready;
    },
    user: { id: BOT },
    channels: { fetch: jest.fn(async (_id: string): Promise<unknown> => channel) },
  };
  const discord = new WeeklyLeaderboardDiscord(client as unknown as Client);
  const make = () =>
    new WeeklyLeaderboardService(
      store as unknown as TelemetryStore,
      telemetry as unknown as TelemetryService,
      servers as unknown as GameServers,
      { get: (key: string) => values[key] } as EnvService,
      discord,
    );
  return { service: make(), make, values, store, telemetry, channel, client, history };
}
function snowflake(timestamp: number, increment = 0) {
  return SnowflakeUtil.generate({ timestamp, increment: BigInt(increment) }).toString();
}
function other(history: FakeMessage[], count: number, content = "gg", author = OTHER_USER) {
  for (let index = 0; index < count; index++)
    history.push({ id: snowflake(FIXTURE_SLOT + 1_000 + history.length), author: { id: author }, content });
}
function totals(aggregate: CombatAggregate, changes: Partial<CombatAggregate["totals"]>): CombatAggregate {
  return { ...aggregate, totals: { ...aggregate.totals, ...changes } };
}
const at = (time: number) => jest.setSystemTime(time);
let logs: jest.SpyInstance, warnings: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({ now: FIXTURE_SLOT + 2 * 60_000, doNotFake: ["nextTick", "queueMicrotask"] });
  logs = jest.spyOn(Logger.prototype, "log").mockImplementation();
  warnings = jest.spyOn(Logger.prototype, "warn").mockImplementation();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("weekly board worker", () => {
  it("posts one names-only board for an eligible week with no pings, no embeds and a deterministic nonce", async () => {
    const { service, store, channel } = fixture();
    await service.tick();
    expect(store.snapshot).toHaveBeenCalledWith(W40.since, W40.until, undefined, "primary");
    expect(store.weeklyHighlights).toHaveBeenCalledWith(W40.since, W40.until, "primary");
    expect(channel.send).toHaveBeenCalledTimes(1);
    const [payload] = channel.send.mock.calls[0] as unknown as [Record<string, unknown> & { content: string }];
    expect(payload).toEqual({
      content: expect.any(String),
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds,
      nonce: sha256("weekly-leaderboard:primary:2026-W40").slice(0, 24),
      enforceNonce: true,
    });
    expect(payload.nonce).toBe(weeklyNonce("primary", "2026-W40"));
    expect(payload.content.length).toBeLessThanOrEqual(2_000);
    expect(payload.content).not.toMatch(/\d{17}/);
    expect(payload.content.split("\n").at(-1)).toMatch(/ Weekly board 2026-W40 · The UNCs$/);
    expect(payload.content).toContain("3. Unnamed player — 61 kills · K/D 1.22");
    const status = service.status(admin);
    expect(status.lastRun).toEqual({
      weekKey: "2026-W40",
      windowStartedAt: "2026-09-28T00:00:00.000Z",
      windowEndedAt: "2026-10-05T00:00:00.000Z",
      checkedAt: "2026-10-05T00:02:00.000Z",
      trigger: "schedule",
      outcome: "posted",
      reason: "posted",
      totals: { kills: 617, players: 23, rankedPlayers: 22 },
      messageId: expect.stringMatching(/^\d+$/),
    });
    const json = JSON.stringify(status);
    for (const id of FIXTURE_IDS) expect(json).not.toContain(id);
    for (const { name } of fixtureRows()) expect(json).not.toContain(name);
    // Repeated checks through the rest of the window send nothing more.
    for (let check = 0; check < 5; check++) {
      jest.advanceTimersByTime(CHECK_INTERVAL_MS);
      await service.tick();
    }
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(store.snapshot).toHaveBeenCalledTimes(1);
  });

  it("stays silent and reads nothing more while the game's combat feed delivers nothing", async () => {
    const { service, store, client, channel } = fixture();
    store.tracking.mockResolvedValue(null as never);
    await service.tick();
    expect(store.snapshot).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.status(admin).lastRun).toMatchObject({
      outcome: "skipped",
      reason: "no combat events received this week",
    });
  });

  const skips: Array<[string, (f: ReturnType<typeof fixture>) => void, string]> = [
    ["switched off", (f) => (f.values.WEEKLY_LEADERBOARD_ENABLED = false), "disabled"],
    ["no channel", (f) => (f.values.WEEKLY_LEADERBOARD_CHANNEL_ID = undefined), "channel not configured"],
    ["no staff guild", (f) => (f.values.ADMIN_GUILD_ID = undefined), "channel not configured"],
    ["feed off", (f) => f.telemetry.feedAvailable.mockReturnValue(false), "feed not configured"],
    [
      "no batch since the window opened",
      (f) =>
        f.store.tracking.mockResolvedValue({
          firstReceivedAt: new Date("2026-09-01T00:00:00Z"),
          lastReceivedAt: new Date("2026-09-27T23:59:59Z"),
        }),
      "no combat events received this week",
    ],
    [
      "too few kills",
      (f) => f.store.snapshot.mockResolvedValue(totals(fixtureAggregate(), { kills: 37, players: 6 })),
      "below minimum kills (37/100)",
    ],
    [
      "too few players",
      (f) => f.store.snapshot.mockResolvedValue(totals(fixtureAggregate(), { players: 6 })),
      "below minimum players (6/10)",
    ],
    [
      "too few players with kills",
      (f) =>
        f.store.snapshot.mockResolvedValue({
          ...fixtureAggregate(),
          leaderboard: fixtureRows().map((row, index) => (index < 4 ? row : { ...row, kills: 0 })),
        }),
      "fewer than 5 players with kills",
    ],
  ];
  it.each(skips)("skips silently when %s and decides the week once", async (_name, setup, reason) => {
    const f = fixture();
    setup(f);
    await f.service.tick();
    expect(f.channel.send).not.toHaveBeenCalled();
    expect(f.client.channels.fetch).not.toHaveBeenCalled();
    expect(f.service.status(admin).lastRun).toMatchObject({ weekKey: "2026-W40", outcome: "skipped", reason });
    const reads = f.store.tracking.mock.calls.length + f.store.snapshot.mock.calls.length;
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await f.service.tick();
    expect(f.store.tracking.mock.calls.length + f.store.snapshot.mock.calls.length).toBe(reads);
    expect(f.channel.send).not.toHaveBeenCalled();
    const logged = logs.mock.calls.map(([message]) => String(message));
    expect(logged).toEqual([`Weekly board 2026-W40 for server primary: skipped (${reason}).`]);
  });

  it("retries a storage failure on the next check within the window", async () => {
    const { service, store, channel } = fixture();
    store.weeklyHighlights.mockRejectedValueOnce(new Error("connection terminated"));
    await service.tick();
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.status(admin).lastRun).toMatchObject({ outcome: "skipped", reason: "storage unavailable" });
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await service.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("never posts by surprise when turned on midweek, and an administrator can still post that week", async () => {
    at(Date.parse("2026-10-07T15:00:00Z"));
    const { service, store, channel } = fixture();
    await service.tick();
    await service.tick();
    expect(store.tracking).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(service.status(admin).lastRun).toMatchObject({
      weekKey: "2026-W40",
      outcome: "skipped",
      reason: "missed posting window",
    });
    expect(logs).toHaveBeenCalledTimes(1);
    const preview = await service.preview(admin, "last");
    expect(preview).toMatchObject({ weekKey: "2026-W40", postable: true, eligible: true });
    await expect(
      service.post(admin, { weekKey: "2026-W40", previewHash: preview.previewHash, confirm: true }),
    ).resolves.toMatchObject({ outcome: "posted", weekKey: "2026-W40" });
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("acts until six hours after the slot and ignores an older slot", async () => {
    at(FIXTURE_SLOT + 6 * HOUR);
    const late = fixture();
    await late.service.tick();
    expect(late.channel.send).toHaveBeenCalledTimes(1);
    at(FIXTURE_SLOT + 6 * HOUR + 1);
    const missed = fixture();
    await missed.service.tick();
    expect(missed.channel.send).not.toHaveBeenCalled();
    expect(missed.store.tracking).not.toHaveBeenCalled();
    expect(missed.service.status(admin).lastRun?.reason).toBe("missed posting window");
  });

  it("finds its own earlier post after a restart and does not post again", async () => {
    const first = fixture();
    await first.service.tick();
    expect(first.channel.send).toHaveBeenCalledTimes(1);
    other(first.history, 30);
    const restarted = first.make();
    await restarted.tick();
    expect(first.channel.send).toHaveBeenCalledTimes(1);
    expect(restarted.status(admin).lastRun).toMatchObject({ outcome: "skipped", reason: "already posted" });
    await expect(restarted.preview(admin, undefined)).resolves.toMatchObject({ alreadyPosted: true, postable: false });
  });

  it("counts only the bot's own message with this week's and this server's marker", async () => {
    const { service, history, channel } = fixture();
    const marker = weeklyMarker("2026-W40", "The UNCs");
    other(history, 1, `Quoting the bot: ${marker}`);
    other(history, 1, `-# Earlier board. ${weeklyMarker("2026-W39", "The UNCs")}`, BOT);
    other(history, 1, `-# Another server. ${weeklyMarker("2026-W40", "The UNCs East")}`, BOT);
    other(history, 1, `${marker}\nedited`, BOT);
    await service.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("pages forward through channel history to find the marker", async () => {
    const { service, history, channel } = fixture();
    other(history, 150);
    other(history, 1, `-# Board. ${weeklyMarker("2026-W40", "The UNCs")}`, BOT);
    await service.tick();
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.messages.fetch).toHaveBeenCalledTimes(2);
    expect(channel.messages.fetch.mock.calls[0][0]).toEqual({
      after: firstSnowflakeAt(FIXTURE_SLOT),
      limit: 100,
      cache: false,
    });
    expect(channel.messages.fetch.mock.calls[1][0].after).toBe(history[99].id);
    // The boundary sits just below the first possible snowflake at the slot.
    const boundary = BigInt(firstSnowflakeAt(FIXTURE_SLOT));
    expect(((boundary + 1n) >> 22n) + SnowflakeUtil.epoch).toBe(BigInt(FIXTURE_SLOT));
    expect((boundary >> 22n) + SnowflakeUtil.epoch).toBe(BigInt(FIXTURE_SLOT - 1));
  });

  it("does not post when it cannot confirm the week is unposted", async () => {
    const unreadable = fixture();
    unreadable.channel.messages.fetch.mockRejectedValueOnce(new Error("Missing Access"));
    await unreadable.service.tick();
    expect(unreadable.channel.send).not.toHaveBeenCalled();
    expect(unreadable.service.status(admin).lastRun?.reason).toBe("posted check unavailable");
    // A failed read is retried; it was not a claim.
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await unreadable.service.tick();
    expect(unreadable.channel.send).toHaveBeenCalledTimes(1);

    const busy = fixture();
    other(busy.history, 501);
    await busy.service.tick();
    expect(busy.channel.messages.fetch).toHaveBeenCalledTimes(5);
    expect(busy.channel.send).not.toHaveBeenCalled();
    expect(busy.service.status(admin).lastRun?.reason).toBe("posted check unavailable");
    // More history only accumulates, so this answer settles the week.
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await busy.service.tick();
    expect(busy.channel.messages.fetch).toHaveBeenCalledTimes(5);
  });

  it("waits for Discord, then posts within the window", async () => {
    const { service, client, channel } = fixture();
    client.ready = false;
    await service.tick();
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(service.status(admin).lastRun?.reason).toBe("Discord not ready");
    client.ready = true;
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await service.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  const unusable: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["is in another guild", (f) => (f.channel.guildId = "200000000000000009")],
    ["is a voice channel", (f) => (f.channel.type = ChannelType.GuildVoice)],
    ["lacks permissions", (f) => (f.channel.allowed = false)],
    ["is missing", (f) => f.client.channels.fetch.mockResolvedValue(null)],
    ["cannot be fetched", (f) => f.client.channels.fetch.mockRejectedValue(new Error("Unknown Channel"))],
  ];
  it.each(unusable)("does not post to a channel that %s", async (_name, setup) => {
    const f = fixture();
    setup(f);
    await f.service.tick();
    expect(f.channel.send).not.toHaveBeenCalled();
    expect(f.service.status(admin).lastRun).toMatchObject({ outcome: "skipped", reason: "channel unusable" });
  });

  it("posts to an announcement channel without crossposting", async () => {
    const { service, channel } = fixture();
    channel.type = ChannelType.GuildAnnouncement;
    await service.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
    // The fake message has no crosspost(); calling it would have turned the result into "unknown".
    expect(service.status(admin).lastRun).toMatchObject({ outcome: "posted" });
  });

  it("never retries a send whose result is unknown", async () => {
    const { service, channel } = fixture();
    channel.send.mockRejectedValueOnce(new Error("Request aborted"));
    await service.tick();
    expect(service.status(admin).lastRun).toMatchObject({
      outcome: "unknown",
      reason: "send result unknown",
      messageId: null,
    });
    for (let check = 0; check < 3; check++) {
      jest.advanceTimersByTime(CHECK_INTERVAL_MS);
      await service.tick();
    }
    const preview = await service.preview(admin, "last");
    expect(preview.postable).toBe(false);
    await expect(
      service.post(admin, { weekKey: "2026-W40", previewHash: preview.previewHash, confirm: true }),
    ).rejects.toMatchObject({ status: 409 });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith("Weekly board 2026-W40 for server primary: unknown (send result unknown).");
  });

  it("records a definite refusal from Discord as failed and does not retry it", async () => {
    const { service, channel } = fixture();
    channel.send.mockRejectedValueOnce(
      new DiscordAPIError(
        { code: 50013, message: "Missing Permissions" },
        50013,
        403,
        "POST",
        `/channels/${CHANNEL}/messages`,
        {},
      ),
    );
    await service.tick();
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await service.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(service.status(admin).lastRun).toMatchObject({ outcome: "failed", reason: "send refused" });
  });

  it("claims the week before sending, so overlapping scheduled and staff posts send once", async () => {
    const { service, channel } = fixture();
    const preview = await service.preview(admin, "last");
    const results = await Promise.allSettled([
      service.tick(),
      service.post(admin, { weekKey: preview.weekKey, previewHash: preview.previewHash, confirm: true }),
    ]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("fulfilled");
    // Whichever check lost the claim posts nothing.
    if (results[1].status === "rejected") expect(results[1].reason).toMatchObject({ status: 409 });
    else expect(results[1].value).toMatchObject({ outcome: "posted" });
  });

  it("posts each configured server separately with its own marker and nonce", async () => {
    const east = { id: "east", name: "UNCs East", version: "1".repeat(64) },
      central = { id: "central", name: "UNCs Central", version: "2".repeat(64) };
    const { service, channel, store } = fixture({}, [east, central]);
    await service.tick();
    expect(channel.send).toHaveBeenCalledTimes(2);
    const payloads = channel.send.mock.calls.map(([payload]) => payload as unknown as Record<string, string>);
    expect(payloads.map((payload) => payload.nonce)).toEqual([
      weeklyNonce("east", "2026-W40"),
      weeklyNonce("central", "2026-W40"),
    ]);
    expect(new Set(payloads.map((payload) => payload.nonce)).size).toBe(2);
    expect(payloads[0].content.split("\n")[0]).toBe("**The UNCs · Weekly board · UNCs East** · week ending Sun, Oct 4");
    expect(payloads[1].content.endsWith(weeklyMarker("2026-W40", "UNCs Central"))).toBe(true);
    expect(store.snapshot.mock.calls.map((call) => call[3])).toEqual(["east", "central"]);
    expect(() => service.status({ ...admin, serverId: undefined })).toThrow("Select a game server");
    expect(service.status({ ...admin, serverId: "central" }).lastRun?.outcome).toBe("posted");
  });

  it("starts only when switched on, checks shortly after startup and every five minutes, and stops cleanly", async () => {
    const off = fixture({ WEEKLY_LEADERBOARD_ENABLED: false });
    off.service.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(0);

    const on = fixture();
    on.service.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);
    expect(on.store.tracking).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(on.channel.send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(on.store.tracking).toHaveBeenCalledTimes(1);
    on.service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await on.service.tick();
    expect(on.channel.send).toHaveBeenCalledTimes(1);
  });
});

describe("weekly board staff status, preview and post-now", () => {
  it("reports configuration, schedule and thresholds to any staff role", () => {
    at(Date.parse("2026-10-02T16:00:00Z"));
    const { service } = fixture({ WEEKLY_LEADERBOARD_ENABLED: false, WEEKLY_LEADERBOARD_CHANNEL_ID: undefined });
    expect(service.status(viewer)).toEqual({
      enabled: false,
      configured: false,
      feedConfigured: true,
      schedule: {
        day: "sunday",
        time: "20:00",
        timeZone: "America/New_York",
        nextPostAt: "2026-10-05T00:00:00.000Z",
        catchUpHours: 6,
      },
      thresholds: { minKills: 100, minPlayers: 10, minRankedPlayers: 5 },
      lastRun: null,
    });
  });

  it("previews the last completed week for administrators without sending, even while switched off", async () => {
    const { service, channel } = fixture({ WEEKLY_LEADERBOARD_ENABLED: false });
    const preview = await service.preview(admin, undefined);
    expect(preview).toEqual({
      weekKey: "2026-W40",
      windowStartedAt: "2026-09-28T00:00:00.000Z",
      windowEndedAt: "2026-10-05T00:00:00.000Z",
      postable: false,
      eligible: true,
      reason: null,
      totals: { kills: 617, players: 23, rankedPlayers: 22 },
      content: expect.stringContaining("**Top 5 by kills**"),
      previewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      alreadyPosted: false,
    });
    expect(preview.previewHash).toBe(sha256(preview.content));
    expect(channel.send).not.toHaveBeenCalled();
    await expect(service.preview(viewer, "last")).rejects.toMatchObject({
      status: 403,
      message: ADMIN_ONLY_MESSAGE,
    });
    await expect(service.preview(moderator, "last")).rejects.toMatchObject({ status: 403 });
    await expect(service.preview(admin, "year")).rejects.toMatchObject({ status: 400 });
  });

  it("renders an ineligible week and the week so far, but neither is postable", async () => {
    at(Date.parse("2026-10-07T15:00:00Z"));
    const { service, store, channel, client } = fixture({ WEEKLY_LEADERBOARD_CHANNEL_ID: undefined });
    store.snapshot.mockResolvedValue(totals(fixtureAggregate(), { kills: 37 }));
    const last = await service.preview(admin, "last");
    expect(last).toMatchObject({
      postable: false,
      eligible: false,
      reason: "channel not configured",
      alreadyPosted: null,
    });
    expect(last.content).toContain("Weekly board 2026-W40");
    const current = await service.preview(admin, "current");
    expect(current).toMatchObject({
      weekKey: "2026-W41",
      windowStartedAt: "2026-10-05T00:00:00.000Z",
      windowEndedAt: "2026-10-07T15:00:00.000Z",
      postable: false,
      alreadyPosted: false,
    });
    expect(current.content.split("\n")[0]).toContain("week ending Sun, Oct 11");
    expect(store.snapshot).toHaveBeenLastCalledWith(
      new Date("2026-10-05T00:00:00.000Z"),
      new Date("2026-10-07T15:00:00.000Z"),
      undefined,
      "primary",
    );
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("posts the previewed last week for an administrator, once", async () => {
    at(Date.parse("2026-10-06T12:00:00Z"));
    const { service, channel } = fixture();
    const preview = await service.preview(admin, "last");
    const body = { weekKey: preview.weekKey, previewHash: preview.previewHash, confirm: true };
    await expect(service.post(admin, body)).resolves.toEqual({
      outcome: "posted",
      messageId: expect.stringMatching(/^\d+$/),
      weekKey: "2026-W40",
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect((channel.send.mock.calls[0] as unknown as [{ content: string }])[0].content).toBe(preview.content);
    expect(service.status(admin).lastRun).toMatchObject({ trigger: "staff", outcome: "posted" });
    expect(logs).toHaveBeenCalledWith(
      `Weekly board 2026-W40 for server primary: posted (posted) by staff ${admin.id}.`,
    );
    await expect(service.post(admin, body)).rejects.toMatchObject({ status: 409 });
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("rejects post-now unless every safeguard passes", async () => {
    at(Date.parse("2026-10-06T12:00:00Z"));
    const f = fixture();
    const { previewHash } = await f.service.preview(admin, "last");
    const body = { weekKey: "2026-W40", previewHash, confirm: true };
    await expect(f.service.post(viewer, body)).rejects.toMatchObject({ status: 403, message: ADMIN_ONLY_MESSAGE });
    await expect(f.service.post(moderator, body)).rejects.toMatchObject({ status: 403 });
    for (const bad of [
      { ...body, confirm: false },
      { weekKey: body.weekKey, previewHash },
      { ...body, confirm: "true" },
      { ...body, extra: 1 },
      { ...body, previewHash: "abc" },
      null,
    ])
      await expect(f.service.post(admin, bad)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.post(admin, { ...body, previewHash: "0".repeat(64) })).rejects.toMatchObject({
      status: 409,
      message: "The board changed since your preview. Preview again.",
    });
    await expect(f.service.post(admin, { ...body, weekKey: "2026-W41" })).rejects.toMatchObject({ status: 409 });
    await expect(f.service.post(admin, { ...body, weekKey: "2026-W39" })).rejects.toMatchObject({ status: 409 });
    f.store.snapshot.mockResolvedValueOnce(totals(fixtureAggregate(), { kills: 37 }));
    await expect(f.service.post(admin, body)).rejects.toMatchObject({
      status: 409,
      message: "This week can't be posted: below minimum kills (37/100).",
    });
    f.values.WEEKLY_LEADERBOARD_ENABLED = false;
    await expect(f.service.post(admin, body)).rejects.toMatchObject({ status: 409 });
    f.values.WEEKLY_LEADERBOARD_ENABLED = true;
    f.client.ready = false;
    await expect(f.service.post(admin, body)).rejects.toMatchObject({ status: 503 });
    f.client.ready = true;
    f.store.tracking.mockRejectedValueOnce(new Error("database down"));
    await expect(f.service.post(admin, body)).rejects.toMatchObject({ status: 503 });
    expect(f.channel.send).not.toHaveBeenCalled();
    // Every refusal above left the week open, so the matching preview still posts.
    await expect(f.service.post(admin, body)).resolves.toMatchObject({ outcome: "posted" });
  });

  it("refuses post-now when the board is already in the channel", async () => {
    at(Date.parse("2026-10-06T12:00:00Z"));
    const { service, history, channel } = fixture();
    other(history, 1, `-# Board. ${weeklyMarker("2026-W40", "The UNCs")}`, BOT);
    const preview = await service.preview(admin, "last");
    expect(preview).toMatchObject({ alreadyPosted: true, postable: false });
    await expect(
      service.post(admin, { weekKey: "2026-W40", previewHash: preview.previewHash, confirm: true }),
    ).rejects.toMatchObject({ status: 409, message: "This week's board is already in the channel." });
    expect(channel.send).not.toHaveBeenCalled();
  });
});
