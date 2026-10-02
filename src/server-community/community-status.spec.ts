import { BadRequestException, Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { AdminStore } from "../admin/admin.store";
import type { GameServers } from "../admin/game-servers";
import type { EnvService } from "../env/env.service";
import { ServerCommunityService } from "./server-community.service";

const definitions = ["primary", "event"].map((id) => ({ id, name: id, version: "0".repeat(64) }));
function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    SERVER_COMMUNITY_ENABLED: false,
    SERVER_COMMUNITY_WELCOME_ENABLED: true,
    SERVER_COMMUNITY_ROUND_ENABLED: false,
    SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true,
    SERVER_COMMUNITY_WELCOME_MESSAGE: "Welcome",
    SERVER_COMMUNITY_ROUND_MESSAGE: "GG",
    SERVER_COMMUNITY_WELCOME_DELAY_SECONDS: 10,
    SERVER_COMMUNITY_WELCOME_SPACING_SECONDS: 20,
    SERVER_COMMUNITY_DISCORD_CHANNEL_ID: "legacy-channel",
    SERVER_COMMUNITY_DISCORD_MESSAGE_ID: "legacy-message",
    WARDOGS_SERVERS: definitions.map((server) => ({
      ...server,
      communityStatus:
        server.id === "primary" ? { channelId: "private-channel", messageId: "private-message" } : undefined,
    })),
    ...overrides,
  };
  const snapshot = {
    observedAt: "2026-10-01T12:00:00.000Z",
    status: { map: "Europe", players: { current: 0, max: 100 }, factionScores: [] },
    players: [],
  };
  const games = Object.fromEntries(
    definitions.map(({ id }) => [
      id,
      {
        overview: jest.fn().mockResolvedValue(snapshot),
        execute: jest.fn(),
        reservedSlots: jest.fn().mockResolvedValue({ ids: new Set<string>(), loadedAt: "2026-10-01T12:00:15.000Z" }),
      },
    ]),
  );
  const servers = {
    resolve: (id?: string) => {
      if (!id || !games[id]) throw new BadRequestException("Choose a server");
      return id;
    },
    list: () => definitions,
    get: jest.fn((id: string) => games[id]),
  };
  const service = new ServerCommunityService(
    servers as unknown as GameServers,
    {} as AdminStore,
    { get: (key: string) => values[key] } as EnvService,
    { isReady: () => false } as Client,
  );
  return { service, servers, games };
}
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("reads disabled configuration without constructing a game client or claiming a running worker", () => {
  const { service, servers } = fixture();
  const status = service.status("primary");
  expect(status).toMatchObject({
    enabled: false,
    workerStarted: false,
    lastObservedAt: null,
    welcome: {
      enabled: false,
      messages: ["Welcome"],
      variants: [["Welcome"]],
      whitelistedVariants: null,
      whitelist: null,
      delaySeconds: 10,
      spacingSeconds: 20,
    },
    round: { enabled: false, message: "GG", messages: ["GG"] },
  });
  expect(servers.get).not.toHaveBeenCalled();
  expect(() => service.status()).toThrow("Choose a server");
});

it("keeps per-server status-card targets separate and never returns target IDs", () => {
  const { service } = fixture({
    SERVER_COMMUNITY_ENABLED: true,
    SERVER_COMMUNITY_WELCOME_MESSAGES: ["First", "Second"],
  });
  expect(service.status("primary")).toMatchObject({
    welcome: { messages: ["First", "Second"], variants: [["First", "Second"]] },
    discordStatus: { enabled: true, configured: true },
  });
  expect(service.status("event")).toMatchObject({ discordStatus: { enabled: true, configured: false } });
  expect(JSON.stringify(service.status("primary"))).not.toMatch(/private-|legacy-/);
});

it("lists configured welcome variants and round messages while keeping the first of each in the older fields", () => {
  const { service } = fixture({
    SERVER_COMMUNITY_WELCOME_VARIANTS: [["Hello", "Link"], ["Hi"]],
    SERVER_COMMUNITY_WELCOME_MESSAGES: ["Old", "Sequence"],
    SERVER_COMMUNITY_ROUND_MESSAGES: ["GG one", "GG two"],
  });
  expect(service.status("primary")).toMatchObject({
    welcome: { messages: ["Hello", "Link"], variants: [["Hello", "Link"], ["Hi"]], delaySeconds: 10 },
    round: { message: "GG one", messages: ["GG one", "GG two"] },
  });
});

it("distinguishes configured workers from observed activity without the status read triggering work", async () => {
  jest.useFakeTimers();
  const { service, servers, games } = fixture({ SERVER_COMMUNITY_ENABLED: true });
  expect(service.status("primary").workerStarted).toBe(false);
  service.onApplicationBootstrap();
  expect(service.status("primary")).toMatchObject({ workerStarted: true, lastObservedAt: null });
  expect(games.primary.overview).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(0);
  expect(service.status("primary").lastObservedAt).toBe("2026-10-01T12:00:00.000Z");
  expect(games.primary.overview).toHaveBeenCalledTimes(1);
  expect(games.primary.execute).not.toHaveBeenCalled();
  service.onModuleDestroy();
  expect(service.status("primary").workerStarted).toBe(false);
  expect(servers.get).toHaveBeenCalledTimes(2);
});

it("lists whitelisted welcome variants with where and when each server's whitelist was read", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  const { service, games } = fixture({
    SERVER_COMMUNITY_ENABLED: true,
    SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: false,
    SERVER_COMMUNITY_WELCOME_VARIANTS: [["Get whitelisted"]],
    SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: [["Welcome back"], ["Good to see you"]],
  });
  const unread = { source: "running-whitelist", cacheSeconds: 300, lastLoadedAt: null, lastFailedAt: null };
  expect(service.status("primary").welcome).toMatchObject({
    variants: [["Get whitelisted"]],
    whitelistedVariants: [["Welcome back"], ["Good to see you"]],
    whitelist: unread,
  });
  service.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(0);
  // A player joins the primary server only, so only that server reads its whitelist.
  games.primary.overview.mockResolvedValue({
    observedAt: "2026-10-01T12:00:15.000Z",
    status: { map: "Europe", players: { current: 1, max: 100 }, factionScores: [] },
    players: [{ name: "Example player", steamId: "76561198000000001" }],
  });
  await jest.advanceTimersByTimeAsync(15_000);
  expect(games.primary.reservedSlots).toHaveBeenCalledTimes(1);
  expect(games.event.reservedSlots).not.toHaveBeenCalled();
  expect(service.status("primary").welcome.whitelist).toEqual({ ...unread, lastLoadedAt: "2026-10-01T12:00:15.000Z" });
  expect(service.status("event").welcome.whitelist).toEqual(unread);
  service.onModuleDestroy();
});
