// Test doubles for staff-alert specs: a game client, a Discord channel and a clock-driven worker.
// Never imported by the application.
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { fixtureServers } from "../admin/game-server-fixture";
import type { Overview, WardogsClient } from "../admin/wardogs.client";
import type { EnvService } from "../env/env.service";
import type { FeedContextSource } from "./feed-context";
import type { NetworkBanSource } from "./network-bans";
import { StaffAlertsWorker } from "./staff-alerts.monitor";
import { StaffAlerts } from "./staff-alerts.service";

export const guild = "234567890123456789";
export const channelId = "345678901234567890";
export const ids = ["76561198000000001", "76561198000000002", "76561198000000003", "76561198000000004"];
export type Player = { steamId: string; name: string; kills?: number; deaths?: number };

export function snapshot(players: Player[], overrides: Partial<Overview["status"]> = {}, build = "CL-507060") {
  return {
    observedAt: new Date().toISOString(),
    capabilities: { routes: [], build },
    status: {
      serverName: "The UNCs",
      map: "Kavkazi",
      players: { current: players.length, max: 100 },
      factionScores: [
        { name: "Lonestar", score: 20 },
        { name: "Valkyra", score: 25 },
      ],
      matchSeconds: 900,
      ...overrides,
    },
    players,
    unlinkedPlayerCount: 0,
  } as Overview;
}

/** A Discord channel double that passes every staff-channel check and records what is sent. */
export function discordDouble() {
  const everyone = { id: guild };
  const channel = {
    id: channelId,
    type: ChannelType.GuildText,
    guildId: guild,
    guild: { members: { me: { id: "bot" } }, roles: { everyone, cache: new Map() } },
    permissionsFor: (target: unknown) => ({
      has: (wanted: bigint | bigint[]) =>
        target === everyone
          ? false
          : (Array.isArray(wanted) ? wanted : [wanted]).every((permission) =>
              [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ReadMessageHistory,
              ].includes(permission),
            ),
    }),
    send: jest.fn().mockResolvedValue({ id: "999999999999999999" }),
    messages: { edit: jest.fn() },
  };
  const client = { isReady: () => true, channels: { fetch: jest.fn().mockResolvedValue(channel) } };
  return { channel, client: client as unknown as Client };
}

/** A game whose match clock keeps running between reads, as a live server's does. */
export function gameDouble(initial = snapshot([])) {
  let current = initial;
  let setAt = Date.now();
  const clock = () =>
    current.status.matchSeconds === undefined
      ? {}
      : { matchSeconds: current.status.matchSeconds + Math.floor((Date.now() - setAt) / 1000) };
  let failure: Error | null = null;
  return {
    overview: jest.fn(async () => {
      if (failure) throw failure;
      return {
        ...current,
        status: { ...current.status, ...clock() },
        observedAt: new Date().toISOString(),
      };
    }),
    /** The live reserved slots: the only whitelist read staff alerts make. */
    reservedSlots: jest.fn(async () => ({
      ids: new Set<string>() as ReadonlySet<string>,
      loadedAt: new Date().toISOString(),
    })),
    /** Also reads the configuration document; staff alerts must never call it. */
    whitelist: jest.fn(),
    execute: jest.fn(),
    failWith(error: Error | null) {
      failure = error;
    },
    set(next: Overview) {
      if (next.status.matchSeconds !== current.status.matchSeconds || next.status.map !== current.status.map)
        setAt = Date.now();
      current = next;
    },
  };
}

export function workerFixture(
  values: Record<string, unknown> = {},
  options: { sources?: NetworkBanSource[]; feed?: FeedContextSource | null; game?: ReturnType<typeof gameDouble> } = {},
) {
  const env: Record<string, unknown> = {
    ADMIN_GUILD_ID: guild,
    STAFF_ALERTS_CHANNEL_ID: channelId,
    STAFF_ALERTS_ENABLED: true,
    STAFF_ALERTS_TIME_ZONE: "America/New_York",
    ...values,
  };
  const envService = { get: (key: string) => env[key] } as EnvService;
  const game = options.game ?? gameDouble();
  const servers = fixtureServers(game);
  const discord = discordDouble();
  const alerts = new StaffAlerts(discord.client, envService);
  const worker = new StaffAlertsWorker(
    { id: "primary", name: "The UNCs", version: "0".repeat(64) },
    game as unknown as WardogsClient,
    alerts,
    envService,
    options.sources ?? [],
    options.feed ?? null,
  );
  /** Advances the clock and runs one pass against this roster, then lets its alert posts finish. */
  const pass = async (next?: Overview, advance = 10_000) => {
    jest.setSystemTime(Date.now() + advance);
    if (next) game.set(next);
    const delay = await worker.tick();
    await jest.advanceTimersByTimeAsync(0);
    return delay;
  };
  return { env, game, servers, discord, alerts, worker, pass };
}
