import { Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { AdminStore } from "../admin/admin.store";
import { RconError, RESERVED_SLOTS_CACHE_MS, WardogsClient, type ReservedSlots } from "../admin/wardogs.client";
import type { EnvService } from "../env/env.service";
import { Env } from "../env/env";
import { CommunityRotation, type RandomSource } from "./community-rotation";
import { EVERY_PROCESS_SENDS, type CommunitySender } from "./community-sender";
import type { CommunitySnapshot } from "./community-state";
import { ServerCommunityWorker as ServerCommunityService, WHITELIST_RETRY_MS } from "./server-community.service";

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
function fixture(
  overrides: Record<string, unknown> = {},
  serverId = "primary",
  random: jest.Mock<number, []> & RandomSource = jest.fn(() => 0),
  sender: CommunitySender = EVERY_PROCESS_SENDS,
) {
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
    reservedSlots: jest
      .fn<Promise<ReservedSlots>, []>()
      .mockResolvedValue({ ids: new Set<string>(), loadedAt: new Date().toISOString() }),
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
    undefined,
    new CommunityRotation(random),
    sender,
  );
  const look = async (ids = [firstId], map = "Kavkazi", elapsed = 5_000) => {
    jest.setSystemTime(Date.now() + elapsed);
    game.overview.mockResolvedValue(snapshot(ids, map));
    return service.tick();
  };
  return { service, game, store, message, channel, discord, look, random };
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

  it.each([undefined, new Error("pool ending")])(
    "closes a receipt created as shutdown starts as failed and never sends it (finish error: %p)",
    async (finishError) => {
      const { service, look, game, store } = fixture();
      await service.tick();
      // SIGTERM lands while the audit insert is in flight; the row is still created.
      store.begin.mockImplementationOnce(async () => {
        service.onModuleDestroy();
        return { created: true, record: {} };
      });
      if (finishError) store.finish.mockRejectedValueOnce(finishError);
      await look([firstId, secondId]);
      expect(game.execute).not.toHaveBeenCalled();
      expect(store.finish).toHaveBeenCalledTimes(1);
      expect(store.finish).toHaveBeenCalledWith(store.begin.mock.calls[0][1].id, {
        state: "failed",
        changed: false,
        message: "Gramps stopped before sending this automatic message. Nothing was sent.",
      });
    },
  );

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

describe("varied community messages", () => {
  const thirdId = "76561198000000003";
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(time);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    [{}, "Welcome to The UNCs!"],
    [{ SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome!", "More info"] }, "Welcome!"],
  ])("keeps legacy welcome and round text without randomness when new settings are unset: %j", async (values, text) => {
    const { service, look, game, random } = fixture(values);
    await service.tick();
    await look([firstId, secondId]);
    await look([firstId, secondId, thirdId]);
    await look([firstId, secondId, thirdId], "Europe");
    expect(game.execute.mock.calls.map(([action]) => action.message)).toEqual([text, text, "GG! Thanks for playing."]);
    expect(random).not.toHaveBeenCalled();
  });

  it("prefers welcome variants over older welcome settings and sends one variant's whole sequence", async () => {
    const { service, look, game, store } = fixture(
      {
        SERVER_COMMUNITY_WELCOME_VARIANTS: [
          ["First hello", "First link"],
          ["Second hello", "Second link"],
        ],
        SERVER_COMMUNITY_WELCOME_MESSAGES: ["Old sequence", "Old link"],
        SERVER_COMMUNITY_WELCOME_MESSAGE: "Legacy welcome",
      },
      "primary",
      jest.fn(() => 0.99),
    );
    await service.tick();
    await look([firstId, secondId]);
    for (let i = 0; i < 3; i++) await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
    await look([firstId, secondId]);
    expect(game.execute.mock.calls.map(([action]) => [action.steamId, action.message])).toEqual([
      [secondId, "Second hello"],
      [secondId, "Second link"],
    ]);
    expect(store.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "system:server-community" }),
      expect.objectContaining({ action: "message", reason: "Automatic observed-join welcome." }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it("never repeats a returning player's variant or the previous joiner's", async () => {
    // The random source always prefers the first candidate, so only the exclusions move the choice.
    const { service, look, game } = fixture({ SERVER_COMMUNITY_WELCOME_VARIANTS: [["V0"], ["V1"], ["V2"]] });
    await service.tick();
    await look([firstId, secondId]);
    await look([firstId, secondId, thirdId]);
    // Stay away past the observer's leave grace, then rejoin as a new session.
    for (let i = 0; i < 3; i++) await look([firstId, thirdId], "Kavkazi", 25_000);
    await look([firstId, thirdId, secondId]);
    expect(game.execute.mock.calls.map(([action]) => [action.steamId, action.message])).toEqual([
      [secondId, "V0"],
      [thirdId, "V1"],
      [secondId, "V2"],
    ]);
  });

  it("rotates round messages ahead of the single round message without repeating the previous round", async () => {
    const { service, look, game, store } = fixture({
      SERVER_COMMUNITY_WELCOME_ENABLED: false,
      SERVER_COMMUNITY_ROUND_MESSAGES: ["GG one", "GG two", "GG three"],
      SERVER_COMMUNITY_ROUND_MESSAGE: "Legacy GG",
    });
    await service.tick();
    for (const map of ["Europe", "Kavkazi", "Europe"]) {
      await look([firstId], map);
      for (let i = 0; i < 3; i++) await look([firstId], map, 25_000);
    }
    expect(game.execute.mock.calls.map(([action]) => [action.action, action.message])).toEqual([
      ["broadcast", "GG one"],
      ["broadcast", "GG two"],
      ["broadcast", "GG one"],
    ]);
    expect(store.begin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "Automatic observed round-transition message." }),
      expect.any(String),
    );
  });
});

describe("whitelist-aware welcomes", () => {
  const thirdId = "76561198000000003";
  const fourthId = "76561198000000004";
  const fifthId = "76561198000000005";
  const pools = {
    SERVER_COMMUNITY_WELCOME_VARIANTS: [["Get whitelisted", "Apply on the website"]],
    SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: [["Welcome back", "Thanks for being here"]],
  };
  const singles = {
    SERVER_COMMUNITY_WELCOME_VARIANTS: [["Get whitelisted"]],
    SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: [["Welcome back"]],
  };
  const whitelist = (...ids: string[]): ReservedSlots => ({ ids: new Set(ids), loadedAt: new Date().toISOString() });
  const sent = (game: ReturnType<typeof fixture>["game"]) =>
    game.execute.mock.calls.map(([action]) => [action.steamId, action.message]);
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(time);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("sends whitelisted joiners the whitelisted variants and everyone else the standard ones", async () => {
    const { service, look, game } = fixture(pools);
    game.reservedSlots.mockResolvedValue(whitelist(secondId));
    await service.tick();
    await look([firstId, secondId]);
    for (let i = 0; i < 10; i++) await look([firstId, secondId, thirdId]);
    expect(sent(game).filter(([steamId]) => steamId === secondId)).toEqual([
      [secondId, "Welcome back"],
      [secondId, "Thanks for being here"],
    ]);
    expect(sent(game).filter(([steamId]) => steamId === thirdId)).toEqual([
      [thirdId, "Get whitelisted"],
      [thirdId, "Apply on the website"],
    ]);
    // Only passes with new joiners ask; the connection's shared cache decides whether that reaches the game.
    expect(game.reservedSlots).toHaveBeenCalledTimes(2);
    expect(service.whitelistObservations()).toEqual({ lastLoadedAt: time.toISOString(), lastFailedAt: null });
  });

  it.each([
    [{}, "Welcome to The UNCs!"],
    [{ SERVER_COMMUNITY_WELCOME_VARIANTS: pools.SERVER_COMMUNITY_WELCOME_VARIANTS }, "Get whitelisted"],
  ])("never reads the whitelist while whitelisted variants are unset: %j", async (values, text) => {
    const { service, look, game, random } = fixture(values);
    game.reservedSlots.mockResolvedValue(whitelist(secondId));
    await service.tick();
    await look([firstId, secondId]);
    expect(sent(game)).toEqual([[secondId, text]]);
    expect(game.reservedSlots).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(service.whitelistObservations()).toEqual({ lastLoadedAt: null, lastFailedAt: null });
  });

  it("never reads the whitelist while welcomes are off", async () => {
    const { service, look, game } = fixture({ ...pools, SERVER_COMMUNITY_WELCOME_ENABLED: false });
    await service.tick();
    await look([firstId, secondId]);
    expect(game.reservedSlots).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("falls back to the standard variants when the whitelist cannot be read, and asks again after a minute", async () => {
    const { service, look, game } = fixture(singles);
    game.reservedSlots.mockRejectedValueOnce(new RconError("The game server could not be reached."));
    game.reservedSlots.mockImplementation(async () => whitelist(secondId, thirdId, fourthId));
    await service.tick();
    await look([firstId, secondId]);
    const failedAt = new Date().toISOString();
    expect(service.whitelistObservations()).toEqual({ lastLoadedAt: null, lastFailedAt: failedAt });
    const ids = [firstId, secondId, thirdId];
    await look(ids);
    while (Date.now() < Date.parse(failedAt) + WHITELIST_RETRY_MS) await look(ids);
    expect(game.reservedSlots).toHaveBeenCalledTimes(1);
    await look([...ids, fourthId]);
    expect(game.reservedSlots).toHaveBeenCalledTimes(2);
    expect(sent(game)).toEqual([
      [secondId, "Get whitelisted"],
      [thirdId, "Get whitelisted"],
      [fourthId, "Welcome back"],
    ]);
    expect(service.whitelistObservations()).toEqual({ lastLoadedAt: new Date().toISOString(), lastFailedAt: failedAt });
  });

  it("treats an unexpected whitelist error like an unreadable whitelist", async () => {
    const { service, look, game } = fixture(singles);
    game.reservedSlots.mockRejectedValueOnce(new TypeError("Unexpected response"));
    await service.tick();
    await expect(look([firstId, secondId])).resolves.toBe(5_000);
    expect(sent(game)).toEqual([[secondId, "Get whitelisted"]]);
  });

  it("reuses one running-whitelist read for five minutes of joins and reads again after an approval", async () => {
    const { service, look, game } = fixture(singles);
    const running = [secondId];
    const transport = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path === "/v1/reserved-slots")
        running.push((JSON.parse(String(init.body)) as { steamId: string }).steamId);
      return new Response(JSON.stringify(path === "/v1/reserved-slots" ? { reservedSlots: running } : { ok: true }));
    });
    const client = new WardogsClient({ rcon: () => ({ rconUrl: "https://rcon.example.test", password: "test-only" }) });
    game.reservedSlots.mockImplementation(() => client.reservedSlots());
    const reads = () =>
      transport.mock.calls.filter(([url, init]) => init?.method === "GET" && String(url).endsWith("/v1/reserved-slots"))
        .length;
    await service.tick();
    const ids = [firstId, secondId];
    await look(ids);
    const loadedAt = Date.now();
    let next = 10;
    while (Date.now() + 25_000 < loadedAt + RESERVED_SLOTS_CACHE_MS) {
      ids.push(`765611980000000${next++}`);
      await look(ids, "Kavkazi", 25_000);
    }
    expect(reads()).toBe(1);
    ids.push(`765611980000000${next++}`);
    await look(ids, "Kavkazi", 25_000);
    expect(reads()).toBe(2);
    // Gramps approves a whitelist application on the same connection, and the player joins right away.
    await client.request("POST", "/v1/reserved-slots", { steamId: fifthId });
    await look([...ids, fifthId]);
    expect(reads()).toBe(3);
    expect(sent(game).filter(([, message]) => message === "Welcome back")).toEqual([
      [secondId, "Welcome back"],
      [fifthId, "Welcome back"],
    ]);
  });

  it("keeps separate no-repeat history for whitelisted and standard variants", async () => {
    // The random source always prefers the first candidate, so only the exclusions move the choice.
    const { service, look, game } = fixture({
      SERVER_COMMUNITY_WELCOME_VARIANTS: [["S0"], ["S1"], ["S2"]],
      SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: [["W0"], ["W1"], ["W2"]],
    });
    game.reservedSlots.mockResolvedValue(whitelist(secondId, fourthId));
    await service.tick();
    const ids = [firstId];
    for (const steamId of [secondId, thirdId, fourthId, fifthId]) {
      ids.push(steamId);
      await look(ids);
    }
    // The second player stays away past the observer's leave grace, then rejoins as a new session.
    const others = ids.filter((steamId) => steamId !== secondId);
    for (let i = 0; i < 3; i++) await look(others, "Kavkazi", 25_000);
    await look([...others, secondId]);
    expect(sent(game)).toEqual([
      [secondId, "W0"],
      [thirdId, "S0"],
      [fourthId, "W1"],
      [fifthId, "S1"],
      [secondId, "W2"],
    ]);
  });

  it("checks each server's own whitelist and keeps a failure on one server from affecting another", async () => {
    const first = fixture(singles, "primary");
    const second = fixture(singles, "event");
    first.game.reservedSlots.mockResolvedValue(whitelist(secondId));
    second.game.reservedSlots.mockRejectedValue(new Error("offline"));
    await first.service.tick();
    await second.service.tick();
    await second.look([firstId, secondId]);
    await first.look([firstId, secondId]);
    expect(first.game.execute).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "primary", steamId: secondId, message: "Welcome back" }),
    );
    expect(second.game.execute).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "event", steamId: secondId, message: "Get whitelisted" }),
    );
    expect(first.service.whitelistObservations().lastFailedAt).toBeNull();
    expect(second.service.whitelistObservations()).toMatchObject({
      lastLoadedAt: null,
      lastFailedAt: expect.any(String),
    });
  });

  it("sends nothing when shut down during a whitelist read", async () => {
    const { service, look, game } = fixture(singles);
    game.reservedSlots.mockImplementationOnce(async () => {
      service.onModuleDestroy();
      return whitelist(secondId);
    });
    await service.tick();
    await expect(look([firstId, secondId])).resolves.toBe(30_000);
    expect(game.execute).not.toHaveBeenCalled();
  });
});

describe("sender lease across overlapping processes", () => {
  const thirdId = "76561198000000003";
  const fourthId = "76561198000000004";
  /** Stands in for the database lock: the test decides which lease, if any, this process holds. */
  function lease(initial: number | null) {
    let current = initial;
    return {
      lease: jest.fn((_serverId: string) => current),
      set: (value: number | null) => {
        current = value;
      },
    };
  }
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(time);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("keeps observing but queues, sends and reads nothing while another process holds the lease", async () => {
    const sender = lease(null);
    const { service, look, game, store } = fixture(
      { SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: [["Welcome back"]] },
      "primary",
      undefined,
      sender,
    );
    await service.tick();
    await look([firstId, secondId]);
    await look([firstId, secondId], "Europe");
    expect(service.observations().lastObservedAt).toBe(new Date().toISOString());
    expect(sender.lease).toHaveBeenCalledWith("primary");
    expect(game.reservedSlots).not.toHaveBeenCalled();
    expect(store.begin).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("takes over without replaying what it saw while observing, from the second observation under its lease", async () => {
    const sender = lease(null);
    const { service, look, game } = fixture({}, "primary", undefined, sender);
    await service.tick();
    await look([firstId, secondId]);
    sender.set(1);
    // The previous holder may already have welcomed this joiner, so the first observation only catches up.
    await look([firstId, secondId, thirdId]);
    await look([firstId, secondId, thirdId]);
    expect(game.execute).not.toHaveBeenCalled();
    await look([firstId, secondId, thirdId, fourthId]);
    expect(game.execute.mock.calls.map(([action]) => action.steamId)).toEqual([fourthId]);
  });

  it.each([
    ["lost", null],
    ["lost and regained between observations", 2],
  ])("drops a waiting follow-up once the lease is %s", async (_, next) => {
    const sender = lease(1);
    const { service, look, game } = fixture(
      { SERVER_COMMUNITY_WELCOME_MESSAGES: ["Welcome!", "More info"] },
      "primary",
      undefined,
      sender,
    );
    await service.tick();
    await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
    sender.set(next);
    for (let i = 0; i < 6; i++) await look([firstId, secondId]);
    sender.set(3);
    for (let i = 0; i < 6; i++) await look([firstId, secondId]);
    expect(game.execute).toHaveBeenCalledTimes(1);
  });

  it("starts no receipt when the lease is lost during the whitelist read", async () => {
    const sender = lease(1);
    const { service, look, game, store } = fixture(
      { SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: [["Welcome back"]] },
      "primary",
      undefined,
      sender,
    );
    game.reservedSlots.mockImplementationOnce(async () => {
      sender.set(null);
      return { ids: new Set([secondId]), loadedAt: new Date().toISOString() };
    });
    await service.tick();
    await look([firstId, secondId]);
    expect(store.begin).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("closes a receipt as failed and sends nothing when the lease is lost while the receipt is saved", async () => {
    const sender = lease(1);
    const { service, look, game, store } = fixture({}, "primary", undefined, sender);
    await service.tick();
    store.begin.mockImplementationOnce(async () => {
      sender.set(null);
      return { created: true, record: {} };
    });
    await look([firstId, secondId]);
    expect(game.execute).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(store.begin.mock.calls[0][1].id, {
      state: "failed",
      changed: false,
      message:
        "This Gramps process lost the community sender lock before sending this automatic message. Nothing was sent.",
    });
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

  it("validates welcome variants and round messages", () => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_VARIANTS.parse(undefined)).toBeUndefined();
    expect(Env.shape.SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS.parse(undefined)).toBeUndefined();
    expect(Env.shape.SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS.parse('[["Welcome back", "  Thanks  "]]')).toEqual([
      ["Welcome back", "Thanks"],
    ]);
    expect(Env.shape.SERVER_COMMUNITY_ROUND_MESSAGES.parse(undefined)).toBeUndefined();
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_VARIANTS.parse('[["Hi", "  Link  "], ["Hello"]]')).toEqual([
      ["Hi", "Link"],
      ["Hello"],
    ]);
    expect(Env.shape.SERVER_COMMUNITY_ROUND_MESSAGES.parse('["GG", "  GG all  "]')).toEqual(["GG", "GG all"]);
  });

  it("fits twenty full-length welcome variants and twenty full-length round messages", () => {
    const text = (index: number) => String.fromCharCode(65 + index).repeat(200);
    const variants = Array.from({ length: 20 }, (_, index) => Array.from({ length: 4 }, () => text(index)));
    const rounds = Array.from({ length: 20 }, (_, index) => text(index));
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_VARIANTS.parse(JSON.stringify(variants, null, 2))).toEqual(variants);
    expect(Env.shape.SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS.parse(JSON.stringify(variants))).toEqual(variants);
    expect(Env.shape.SERVER_COMMUNITY_ROUND_MESSAGES.parse(JSON.stringify(rounds, null, 2))).toEqual(rounds);
  });

  it.each([
    "not JSON",
    "{}",
    "[]",
    "[[]]",
    '["Not a sequence"]',
    '[[" "]]',
    "[[123]]",
    '[["line\\nbreak"]]',
    JSON.stringify([["x".repeat(201)]]),
    JSON.stringify([Array(5).fill("Hi")]),
    JSON.stringify(Array.from({ length: 21 }, (_, index) => [`Welcome ${index}`])),
    JSON.stringify([
      ["Same", "Link"],
      [" Same ", "Link"],
    ]),
    JSON.stringify([["Hi"]]) + " ".repeat(32_768),
  ])("rejects invalid welcome variants, whitelisted or not: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_VARIANTS.safeParse(value).success).toBe(false);
    expect(Env.shape.SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS.safeParse(value).success).toBe(false);
  });

  it.each([
    "not JSON",
    "{}",
    "[]",
    '[" "]',
    "[123]",
    '[["GG"]]',
    '["line\\nbreak"]',
    JSON.stringify(["x".repeat(201)]),
    JSON.stringify(Array.from({ length: 21 }, (_, index) => `GG ${index}`)),
    JSON.stringify(["GG", " GG "]),
    JSON.stringify(["GG"]) + " ".repeat(8_192),
  ])("rejects invalid round messages: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_ROUND_MESSAGES.safeParse(value).success).toBe(false);
  });

  it.each([-1, 61, 1.5])("rejects invalid loading delay: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_DELAY_SECONDS.safeParse(value).success).toBe(false);
  });

  it.each([0, 9, 121, 10.5])("rejects message spacing that is unsafe or unbounded: %s", (value) => {
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_SPACING_SECONDS.safeParse(value).success).toBe(false);
  });
});

describe("existing Discord status message", () => {
  // Card edits run apart from the observation pass; let the pending Discord calls finish.
  const settle = () => jest.advanceTimersByTimeAsync(0);
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
    await settle();
    expect(discord.channels.fetch).toHaveBeenCalledWith("123456789012345678");
    expect(channel.messages.fetch).toHaveBeenCalledWith("223456789012345678");
    expect(message.edit).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } }),
    );
    await look([firstId], "Europe");
    await settle();
    expect(message.edit).toHaveBeenCalledTimes(1);
    await look([firstId], "Europe", 60_000);
    await settle();
    expect(message.edit).toHaveBeenCalledTimes(2);
  });

  it("refreshes unchanged cards only after five minutes", async () => {
    const { service, look, message } = fixture({ SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true });
    await service.tick();
    await settle();
    await look([firstId], "Kavkazi", 60_000);
    await settle();
    expect(message.edit).toHaveBeenCalledTimes(1);
    await look([firstId], "Kavkazi", 240_000);
    await settle();
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
      await settle();
      expect(channel.messages.fetch).toHaveBeenCalledTimes(scenario === "other guild" ? 0 : 1);
      expect(message.edit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ADMIN_GUILD_ID is unset", "Set ADMIN_GUILD_ID"],
    ["the channel is in another server", "not a text channel in the ADMIN_GUILD_ID server"],
    ["the channel has no messages", "not a text channel in the ADMIN_GUILD_ID server"],
    ["another account posted the message", "not posted by Gramps"],
  ])("warns once and reports why the card is not updated when %s", async (scenario, problem) => {
    const { service, look, channel, message, discord } = fixture({
      SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true,
      ...(scenario === "ADMIN_GUILD_ID is unset" ? { ADMIN_GUILD_ID: undefined } : {}),
    });
    if (scenario === "the channel is in another server") channel.guildId = "wrong";
    if (scenario === "the channel has no messages") delete (channel as Partial<typeof channel>).messages;
    if (scenario === "another account posted the message") message.author.id = "someone else";
    const warn = jest.spyOn(Logger.prototype, "warn");
    await service.tick();
    await settle();
    await look([firstId], "Europe", 60_000);
    await settle();
    expect(discord.channels.fetch).toHaveBeenCalledTimes(scenario === "ADMIN_GUILD_ID is unset" ? 0 : 2);
    expect(warn.mock.calls.filter(([text]) => String(text).startsWith("Discord status card"))).toEqual([
      [expect.stringContaining(problem)],
    ]);
    expect(service.statusCardProblem()).toContain(problem);
    expect(service.statusCardProblem()).not.toMatch(/\d{6,}|guild|wrong|bot/);
    expect(message.edit).not.toHaveBeenCalled();
  });

  it("reports a failed edit until the next successful one", async () => {
    const { service, look, message } = fixture({ SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true });
    expect(service.statusCardProblem()).toBeNull();
    message.edit.mockRejectedValueOnce(new Error("Missing Permissions"));
    await service.tick();
    await settle();
    expect(service.statusCardProblem()).toBe(
      "Discord status card could not be updated. Check the configured existing message and channel permissions.",
    );
    await look([firstId], "Europe", 60_000);
    await settle();
    expect(message.edit).toHaveBeenCalledTimes(2);
    expect(service.statusCardProblem()).toBeNull();
  });

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
    await settle();
    expect(message.edit.mock.calls[0][0].content).toContain("No successful observation");
    expect(message.edit.mock.calls[0][0].content).not.toContain("Players: 0");
  });

  it("keeps observing while a card edit is slow, so a welcome queued meanwhile is still sent", async () => {
    const { service, game, message } = fixture({
      SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true,
      SERVER_COMMUNITY_WELCOME_DELAY_SECONDS: 10,
    });
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(55_000);
    expect(message.edit).toHaveBeenCalledTimes(1);
    // A player joins in the pass that edits the card, and Discord takes 70 seconds to answer. Had
    // the pass waited, the next observation would come after the 30-second gap and start over.
    message.edit.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 70_000)));
    game.overview.mockResolvedValue(snapshot([firstId, secondId]));
    await jest.advanceTimersByTimeAsync(45_000);
    expect(game.execute).toHaveBeenCalledTimes(1);
    expect(game.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "message", steamId: secondId }));
    // A minute after the slow edit began, it is still the only one under way.
    await jest.advanceTimersByTimeAsync(25_000);
    expect(message.edit).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
