import { Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { AdminStore } from "../admin/admin.store";
import { RconError, type WardogsClient } from "../admin/wardogs.client";
import type { EnvService } from "../env/env.service";
import type { CommunitySnapshot } from "./community-state";
import { ServerCommunityService } from "./server-community.service";

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
function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    ADMIN_GUILD_ID: "guild",
    SERVER_COMMUNITY_ENABLED: true,
    SERVER_COMMUNITY_WELCOME_ENABLED: true,
    SERVER_COMMUNITY_ROUND_ENABLED: true,
    SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: false,
    SERVER_COMMUNITY_WELCOME_MESSAGE: "Welcome to The UNCs!",
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
  );
  const look = async (ids = [firstId], map = "Kavkazi", elapsed = 5_000) => {
    jest.setSystemTime(Date.now() + elapsed);
    game.overview.mockResolvedValue(snapshot(ids, map));
    return service.tick();
  };
  return { service, game, store, message, channel, discord, look };
}

describe("optional community worker", () => {
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
    const ids = Array.from({ length: 300 }, (_, index) => `7656119${String(index).padStart(10, "0")}`);
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
    await look(Array.from({ length: 10 }, (_, index) => `7656119${String(index).padStart(10, "0")}`));
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
