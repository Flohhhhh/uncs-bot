import { Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { AdminStore } from "../admin/admin.store";
import { RconError, type WardogsClient } from "../admin/wardogs.client";
import type { EnvService } from "../env/env.service";
import { Env } from "../env/env";
import type { CommunitySnapshot } from "./community-state";
import { ServerCommunityWorker as ServerCommunityService } from "./server-community.service";

const firstId = "76561198000000001";
const secondId = "76561198000000002";
const time = new Date("2026-09-30T12:00:00Z");
function snapshot(ids = [firstId], map = "Kavkazi"): CommunitySnapshot {
  return {
    observedAt: new Date().toISOString(),
    capabilities: { routes: [] },
    status: { serverName: "The UNCs", map, players: { current: ids.length, max: 100 }, factionScores: [] },
    players: ids.map((steamId) => ({ name: "Example player", steamId })),
  };
}
function fixture(overrides: Record<string, unknown> = {}, serverId = "primary") {
  const values: Record<string, unknown> = {
    ADMIN_GUILD_ID: "guild",
    SERVER_COMMUNITY_ENABLED: true,
    SERVER_COMMUNITY_WELCOME_ENABLED: true,
    SERVER_COMMUNITY_ROUND_ENABLED: true,
    SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: false,
    SERVER_COMMUNITY_WELCOME_MESSAGE: "Welcome to The UNCs!",
    SERVER_COMMUNITY_WELCOME_DELAY_SECONDS: 0,
    SERVER_COMMUNITY_WELCOME_SPACING_SECONDS: 20,
    SERVER_COMMUNITY_ROUND_MESSAGE: "GG! Thanks for playing.",
    SERVER_COMMUNITY_DISCORD_CHANNEL_ID: "123456789012345678",
    SERVER_COMMUNITY_DISCORD_MESSAGE_ID: "223456789012345678",
    ...overrides,
  };
  const game = {
    overview: jest.fn().mockResolvedValue(snapshot()),
    execute: jest.fn().mockResolvedValue({ state: "accepted", message: "Accepted." }),
  };
  const store = {
    begin: jest.fn().mockResolvedValue({ created: true, record: {} }),
    finish: jest.fn().mockResolvedValue(undefined),
  };
  const message = { author: { id: "bot" }, edit: jest.fn().mockResolvedValue(undefined) };
  const channel = { guildId: "guild", messages: { fetch: jest.fn().mockResolvedValue(message) } };
  const discord = {
    isReady: () => true,
    user: { id: "bot" },
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
  };
  const service = new ServerCommunityService(
    game as unknown as WardogsClient,
    store as unknown as AdminStore,
    { get: (key: string) => values[key] } as EnvService,
    discord as unknown as Client,
    { id: serverId, name: `Test ${serverId}`, version: "0".repeat(64) },
  );
  const look = async (ids = [firstId], map = "Kavkazi", elapsed = 5_000) => {
    jest.setSystemTime(Date.now() + elapsed);
    game.overview.mockResolvedValue(snapshot(ids, map));
    return service.tick();
  };
  return { service, game, store, message, channel, discord, look };
}

describe("optional community worker", () => {
  it("reports observations and acknowledged messages, never failed attempts", async () => {
    const { service, game, look } = fixture();
    expect(service.observations()).toEqual({
      lastObservedAt: null,
      lastMessageAcknowledgedAt: null,
      lastStatusCardUpdatedAt: null,
    });
    await service.tick();
    expect(service.observations().lastObservedAt).toBe(time.toISOString());
    game.execute.mockResolvedValueOnce({ state: "failed", message: "Not sent" });
    await look([firstId, secondId]);
    expect(service.observations().lastMessageAcknowledgedAt).toBeNull();
    await look([firstId, secondId, "76561198000000003"]);
    expect(service.observations().lastMessageAcknowledgedAt).toBe(new Date().toISOString());
  });
  it("keeps same-player welcomes and outage cancellation independent between servers", async () => {
    const first = fixture({ SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome", "Follow-up"] }, "primary");
    const second = fixture({ SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome", "Follow-up"] }, "event");
    await first.service.tick();
    await second.service.tick();
    await first.look([firstId, secondId]);
    await second.look([firstId, secondId]);
    expect(first.game.execute).toHaveBeenCalledWith(
      expect.objectContaining({ steamId: secondId, serverId: "primary" }),
    );
    expect(second.game.execute).toHaveBeenCalledWith(expect.objectContaining({ steamId: secondId, serverId: "event" }));
    first.game.overview.mockRejectedValueOnce(new Error("First server offline"));
    await first.service.tick();
    for (let index = 0; index < 4; index++) await second.look([firstId, secondId]);
    expect(first.game.execute).toHaveBeenCalledTimes(1);
    expect(second.game.execute).toHaveBeenCalledTimes(2);
    expect(second.store.begin.mock.calls.map(([, action]) => action.serverId)).toEqual(["event", "event"]);
  });
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(time);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    { SERVER_COMMUNITY_ENABLED: false },
    { SERVER_COMMUNITY_WELCOME_ENABLED: false, SERVER_COMMUNITY_ROUND_ENABLED: false },
  ])("does nothing and schedules no work when disabled: %j", async (values) => {
    const { service, game, discord } = fixture(values);
    service.onApplicationBootstrap();
    await service.tick();
    expect(jest.getTimerCount()).toBe(0);
    expect(game.overview).not.toHaveBeenCalled();
    expect(discord.channels.fetch).not.toHaveBeenCalled();
  });

  it("records an explicit system action before sending one welcome per new session", async () => {
    const { service, look, game, store } = fixture();
    await service.tick();
    expect(game.execute).not.toHaveBeenCalled();
    await look([firstId, secondId]);
    await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
    expect(store.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "system:server-community" }),
      expect.objectContaining({ action: "message", steamId: secondId, message: "Welcome to The UNCs!" }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(store.begin.mock.invocationCallOrder[0]).toBeLessThan(game.execute.mock.invocationCallOrder[0]);
  });

  it("waits for loading and spaces a sequence from actual delivery, including slow sends", async () => {
    const { service, look, game, store } = fixture({
      SERVER_COMMUNITY_WELCOME_MESSAGES: [
        "Welcome!",
        "Free whitelist at theuncsgaming.com",
        "Help seed by playing when quiet.",
      ],
      SERVER_COMMUNITY_WELCOME_DELAY_SECONDS: 10,
    });
    await service.tick();
    await look([firstId, secondId]);
    await look([firstId, secondId]);
    expect(game.execute).not.toHaveBeenCalled();
    game.execute.mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 8_000);
      return { state: "accepted", message: "Accepted." };
    });
    await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
    await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) await look([firstId, secondId]);
    expect(game.execute.mock.calls.map(([action]) => action.message)).toEqual([
      "Welcome!",
      "Free whitelist at theuncsgaming.com",
      "Help seed by playing when quiet.",
    ]);
    expect(new Set(store.begin.mock.calls.map(([, action]) => action.id)).size).toBe(3);
    await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(3);
  });

  it("keeps other welcomes and round messages moving while a follow-up is waiting", async () => {
    const { service, look, game } = fixture({ SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome!", "More info"] });
    await service.tick();
    await look([firstId, secondId]);
    const ids = [firstId, secondId, "76561198000000003"];
    await look(ids);
    expect(game.execute.mock.calls.map(([action]) => action.steamId)).toEqual([secondId, ids[2]]);
    await look(ids, "Europe");
    expect(game.execute).toHaveBeenLastCalledWith(expect.objectContaining({ action: "broadcast" }));
    await look(ids, "Europe");
    expect(game.execute).toHaveBeenCalledTimes(3);
    await look(ids, "Europe");
    expect(game.execute).toHaveBeenLastCalledWith(expect.objectContaining({ steamId: secondId, message: "More info" }));
  });

  it.each(["disconnect", "outage", "gap", "shutdown"])("discards remaining messages after %s", async (event) => {
    const { service, look, game } = fixture({ SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome!", "More info"] });
    await service.tick();
    await look([firstId, secondId]);
    if (event === "disconnect") await look([firstId]);
    if (event === "outage") {
      game.overview.mockRejectedValueOnce(new Error("offline"));
      await service.tick();
    }
    if (event === "gap") await look([firstId, secondId], "Kavkazi", 31_000);
    if (event === "shutdown") service.onModuleDestroy();
    for (let i = 0; i < 5; i++) await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "failed", "audit failure"])("does not continue a welcome sequence after %s", async (result) => {
    const { service, look, game, store } = fixture({ SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome!", "More info"] });
    await service.tick();
    if (result === "audit failure") store.finish.mockRejectedValueOnce(new Error("journal unavailable"));
    else game.execute.mockResolvedValueOnce({ state: result, message: "Not confirmed." });
    await look([firstId, secondId]);
    for (let i = 0; i < 5; i++) await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
  });

  it("baselines after failed observations instead of welcoming returning players or announcing stale rounds", async () => {
    const { service, look, game } = fixture();
    await service.tick();
    game.overview.mockRejectedValueOnce(new Error("unavailable"));
    expect(await service.tick()).toBe(30_000);
    await look([firstId, secondId], "Europe");
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("holds a round change over map loading without a second welcome", async () => {
    const { service, look, game } = fixture();
    await service.tick();
    await look([], "Europe");
    expect(game.execute).not.toHaveBeenCalled();
    await look([firstId], "Europe");
    expect(game.execute).toHaveBeenCalledTimes(1);
    expect(game.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "broadcast" }));
  });

  it("honors separate feature switches", async () => {
    const { service, look, game } = fixture({ SERVER_COMMUNITY_WELCOME_ENABLED: false });
    await service.tick();
    await look([firstId, secondId]);
    expect(game.execute).not.toHaveBeenCalled();
    await look([firstId, secondId], "Europe");
    expect(game.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "broadcast" }));
  });

  it("never sends an action whose audit insert failed or whose ID already exists", async () => {
    const { service, look, game, store } = fixture();
    await service.tick();
    store.begin.mockRejectedValueOnce(new Error("database down"));
    await look([firstId, secondId]);
    store.begin.mockResolvedValueOnce({ created: false, record: {} });
    await look([firstId, secondId, "76561198000000003"]);
    expect(game.execute).not.toHaveBeenCalled();
  });

  it.each([new RconError("transport timed out", true), new Error("unexpected")])(
    "records an unknown send once and never retries it: %p",
    async (error) => {
      const { service, look, game, store } = fixture();
      await service.tick();
      game.execute.mockRejectedValueOnce(error);
      await look([firstId, secondId]);
      await look([firstId, secondId]);
      expect(game.execute).toHaveBeenCalledTimes(1);
      expect(store.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ state: "unknown" }));
    },
  );

  it("records a definite RCON refusal as failed without a retry", async () => {
    const { service, look, game, store } = fixture();
    await service.tick();
    game.execute.mockRejectedValueOnce(new RconError("requested pause"));
    await look([firstId, secondId]);
    expect(store.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ state: "failed" }));
  });

  it("does not repeat a mutation when saving its outcome fails", async () => {
    const { service, look, game, store } = fixture();
    await service.tick();
    store.finish.mockRejectedValueOnce(new Error("database down"));
    await look([firstId, secondId]);
    await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
  });

  it("bounds delivery to one send per observation and expires its finite queue", async () => {
    const { service, look, game } = fixture();
    await service.tick();
    const ids = Array.from({ length: 300 }, (_, index) => `765611980${String(index).padStart(8, "0")}`);
    await look(ids);
    expect(game.execute).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 20; index++) await look(ids);
    expect(game.execute.mock.calls.length).toBeLessThanOrEqual(64);
    const count = game.execute.mock.calls.length;
    await look(ids);
    expect(game.execute).toHaveBeenCalledTimes(count);
  });

  it("drops queued welcomes for disconnected players", async () => {
    const { service, look, game } = fixture();
    await service.tick();
    await look(Array.from({ length: 10 }, (_, index) => `765611980${String(index).padStart(8, "0")}`));
    expect(game.execute).toHaveBeenCalledTimes(1);
    await look([]);
    expect(game.execute).toHaveBeenCalledTimes(1);
  });

  it("skips invalid configured messages rather than truncating them", async () => {
    const { service, look, game } = fixture({ SERVER_COMMUNITY_WELCOME_MESSAGE: "x".repeat(201) });
    await service.tick();
    await look([firstId, secondId]);
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("never overlaps observations and stops without sending after an outstanding read", async () => {
    const { service, game } = fixture();
    let finish!: (value: CommunitySnapshot) => void;
    game.overview.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const active = service.tick();
    await service.tick();
    expect(game.overview).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    finish(snapshot());
    await active;
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("cancels its scheduled work on shutdown", () => {
    const { service } = fixture();
    service.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("backs off when empty", async () => {
    const { service, look } = fixture();
    expect(await service.tick()).toBe(5_000);
    expect(await look([])).toBe(15_000);
  });
});

describe("welcome deployment settings", () => {
  it("validates a short literal sequence while preserving single-message installations", () => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_MESSAGES.parse(undefined)).toBeUndefined();
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_MESSAGES.parse('["Welcome!", "  Free whitelist  "]')).toEqual([
      "Welcome!",
      "Free whitelist",
    ]);
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_DELAY_SECONDS.parse(undefined)).toBe(10);
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_SPACING_SECONDS.parse(undefined)).toBe(20);
  });

  it.each([
    "not JSON",
    "{}",
    "[]",
    '[" "]',
    "[123]",
    '["line\\nbreak"]',
    JSON.stringify(["x".repeat(201)]),
    JSON.stringify(Array(5).fill("Hi")),
  ])("rejects invalid welcome configuration: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_MESSAGES.safeParse(value).success).toBe(false);
  });

  it.each([-1, 61, 1.5])("rejects invalid loading delay: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_DELAY_SECONDS.safeParse(value).success).toBe(false);
  });

  it.each([0, 9, 121, 10.5])("rejects message spacing that is unsafe or unbounded: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_SPACING_SECONDS.safeParse(value).success).toBe(false);
  });
});

describe("existing Discord status message", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(time);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("edits only the configured message with mentions disabled, no sooner than a minute", async () => {
    const { service, look, message, channel, discord } = fixture({ SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true });
    await service.tick();
    expect(discord.channels.fetch).toHaveBeenCalledWith("123456789012345678");
    expect(channel.messages.fetch).toHaveBeenCalledWith("223456789012345678");
    expect(message.edit).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } }),
    );
    await look([firstId], "Europe");
    expect(message.edit).toHaveBeenCalledTimes(1);
    await look([firstId], "Europe", 60_000);
    expect(message.edit).toHaveBeenCalledTimes(2);
  });

  it("refreshes unchanged cards only after five minutes", async () => {
    const { service, look, message } = fixture({ SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true });
    await service.tick();
    await look([firstId], "Kavkazi", 60_000);
    expect(message.edit).toHaveBeenCalledTimes(1);
    await look([firstId], "Kavkazi", 240_000);
    expect(message.edit).toHaveBeenCalledTimes(2);
  });

  it.each(["other guild", "other author", "missing message"])(
    "never creates a replacement for %s",
    async (scenario) => {
      const { service, channel, message } = fixture({ SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true });
      if (scenario === "other guild") channel.guildId = "wrong";
      if (scenario === "other author") message.author.id = "someone else";
      if (scenario === "missing message") channel.messages.fetch.mockRejectedValueOnce(new Error("unknown message"));
      await expect(service.tick()).resolves.toBe(5_000);
      expect(message.edit).not.toHaveBeenCalled();
    },
  );

  it("requires both existing IDs and never polls for an incomplete status-only setup", async () => {
    const { service, game } = fixture({
      SERVER_COMMUNITY_WELCOME_ENABLED: false,
      SERVER_COMMUNITY_ROUND_ENABLED: false,
      SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true,
      SERVER_COMMUNITY_DISCORD_MESSAGE_ID: undefined,
    });
    await service.tick();
    expect(game.overview).not.toHaveBeenCalled();
  });

  it("reports an unavailable game without fabricating a current empty server", async () => {
    const { service, game, message } = fixture({ SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true });
    game.overview.mockRejectedValueOnce(new Error("offline"));
    await service.tick();
    expect(message.edit.mock.calls[0][0].content).toContain("No successful observation");
    expect(message.edit.mock.calls[0][0].content).not.toContain("Players: 0");
  });
});
