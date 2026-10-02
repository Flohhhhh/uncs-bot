import "reflect-metadata";
import { Global, Logger, Module } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Client } from "discord.js";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { legacyServerSettings } from "../admin/game-server-fixture";
import { EnvService } from "../env/env.service";
import { TelemetryStore } from "../telemetry/telemetry.store";
import { FEED_CONTEXT, TelemetryFeedContext } from "./feed-context";
import { EnvWatchlistSource, NETWORK_BAN_SOURCES } from "./network-bans";
import { StaffAlertsMonitorModule } from "./staff-alerts-monitor.module";
import { StaffAlertsController } from "./staff-alerts.controller";
import { ZodError } from "zod";
import { AdminService } from "../admin/admin.service";
import type { GameServers } from "../admin/game-servers";
import { RconError } from "../admin/rcon-protocol";
import { channelId, discordDouble, gameDouble, guild, ids, snapshot, workerFixture } from "./staff-alerts.fixture";
import {
  ACTIVE_DELAY_MS,
  FAILED_DELAY_MS,
  failureKind,
  IDLE_DELAY_MS,
  StaffAlertsMonitor,
} from "./staff-alerts.monitor";
import { StaffAlerts } from "./staff-alerts.service";

const start = Date.parse("2026-10-02T23:00:00Z");
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(start);
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function monitorFixture(values: Record<string, unknown> = {}, serverIds = ["primary"], unconfigured: string[] = []) {
  const env: Record<string, unknown> = { ADMIN_GUILD_ID: guild, STAFF_ALERTS_CHANNEL_ID: channelId, ...values };
  const envService = { get: (key: string) => env[key] } as EnvService;
  const games = Object.fromEntries(serverIds.map((id) => [id, gameDouble(snapshot([{ steamId: ids[0], name: "A" }]))]));
  const definitions = [...serverIds, ...unconfigured].map((id) => ({
    id,
    name: `Server ${id}`,
    version: "0".repeat(64),
  }));
  const servers = {
    list: () => definitions,
    resolve: (id?: string) => id ?? "primary",
    get: jest.fn((id: string) => {
      if (!games[id]) throw new Error("Not configured");
      return games[id];
    }),
  } as unknown as GameServers;
  const discord = discordDouble();
  const alerts = new StaffAlerts(discord.client, envService);
  const monitor = new StaffAlertsMonitor(servers, alerts, envService, [], null);
  return { monitor, games, servers, alerts, discord, env };
}

describe("staff alerts monitor", () => {
  it("starts no worker and reads nothing by default", async () => {
    const { monitor, games, servers } = monitorFixture();
    monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(servers.get).not.toHaveBeenCalled();
    expect(games.primary.overview).not.toHaveBeenCalled();
    await expect(monitor.status("primary")).resolves.toMatchObject({
      enabled: false,
      features: { health: false, seeding: false, performance: "off", watchlist: false },
      worker: { state: "off" },
      alerts: [],
    });
  });

  it("starts nothing when the master switch is on but every feature is off", async () => {
    const { monitor, servers } = monitorFixture({ STAFF_ALERTS_ENABLED: true });
    monitor.onApplicationBootstrap();
    expect(servers.get).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("runs one worker per server, never sends a game action and never injects AdminService", async () => {
    const { monitor, games } = monitorFixture(
      { STAFF_ALERTS_ENABLED: true, STAFF_ALERTS_HEALTH_ENABLED: true, STAFF_ALERTS_PERFORMANCE_ENABLED: "true" },
      ["primary", "event"],
    );
    monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    for (const game of Object.values(games)) {
      expect(game.overview.mock.calls.length).toBeGreaterThan(20);
      expect(game.execute).not.toHaveBeenCalled();
    }
    const parameters: unknown[] = Reflect.getMetadata("design:paramtypes", StaffAlertsMonitor);
    expect(parameters).not.toContain(AdminService);
    expect((await monitor.status("event")).worker).toMatchObject({ state: "running", reachable: true, players: 1 });
    monitor.onApplicationShutdown();
  });

  it("reads every 10 s with players and performance on, every 15 s otherwise and 30 s after a failure", async () => {
    const { monitor, games } = monitorFixture({
      STAFF_ALERTS_ENABLED: true,
      STAFF_ALERTS_PERFORMANCE_ENABLED: "observe",
    });
    const game = games.primary;
    monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(game.overview).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ACTIVE_DELAY_MS - 1);
    expect(game.overview).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(game.overview).toHaveBeenCalledTimes(2);
    game.set(snapshot([]));
    await jest.advanceTimersByTimeAsync(ACTIVE_DELAY_MS);
    expect(game.overview).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(IDLE_DELAY_MS - 1);
    expect(game.overview).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(game.overview).toHaveBeenCalledTimes(4);
    game.overview.mockRejectedValueOnce(new RconError("The game server could not be reached.", false, "unreachable"));
    await jest.advanceTimersByTimeAsync(IDLE_DELAY_MS);
    expect(game.overview).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(FAILED_DELAY_MS - 1);
    expect(game.overview).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(1);
    expect(game.overview).toHaveBeenCalledTimes(6);
    monitor.onApplicationShutdown();
  });

  it("clears its timers on shutdown", async () => {
    const { monitor, games } = monitorFixture({ STAFF_ALERTS_ENABLED: true, STAFF_ALERTS_HEALTH_ENABLED: true });
    monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(30_000);
    const calls = games.primary.overview.mock.calls.length;
    monitor.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(games.primary.overview).toHaveBeenCalledTimes(calls);
  });

  it("keeps a failing or unconfigured server from affecting another", async () => {
    const { monitor, games } = monitorFixture(
      { STAFF_ALERTS_ENABLED: true, STAFF_ALERTS_HEALTH_ENABLED: true },
      ["primary", "event"],
      ["missing"],
    );
    games.event.failWith(new Error("socket hang up"));
    monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(15 * 60_000);
    expect(games.primary.overview.mock.calls.length).toBeGreaterThan(50);
    expect((await monitor.status("primary")).worker).toMatchObject({ reachable: true, failingSince: null });
    expect((await monitor.status("event")).worker).toMatchObject({ reachable: false, failureKind: "error" });
    expect((await monitor.status("event")).alerts.map((alert) => alert.kind)).toEqual(["game-down"]);
    expect((await monitor.status("primary")).alerts).toEqual([]);
    expect((await monitor.status("missing")).worker.state).toBe("not-configured");
    monitor.onApplicationShutdown();
  });

  it("classifies read failures, counting a schema mismatch as unreadable", () => {
    expect(failureKind(new RconError("x", false, "rejected"))).toBe("rejected");
    expect(failureKind(new RconError("x"))).toBe("error");
    expect(failureKind(new ZodError([]))).toBe("unreadable");
    expect(failureKind(new Error("x"))).toBe("error");
  });

  it("reports thresholds and counts only, never list contents", async () => {
    const { monitor } = monitorFixture({
      STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: [ids[2]],
      STAFF_ALERTS_WATCHLIST: [{ steamId: ids[3], reason: "Aimbot" }],
    });
    const status = await monitor.status("primary");
    expect(status.settings).toMatchObject({ knownGoodCount: 1, watchlistCount: 1, timeZone: "America/New_York" });
    expect(status.channel).toEqual({ configured: true, state: "ok", ping: "off" });
    const text = JSON.stringify(status);
    expect(text).not.toContain(ids[2]);
    expect(text).not.toContain(ids[3]);
    expect(text).not.toContain("Aimbot");
  });
});

describe("staff alerts worker", () => {
  const scores = {
    factionScores: [
      { name: "Lonestar", score: 20 },
      { name: "Valkyra", score: 25 },
    ],
  };

  it("raises game-down after ten minutes of failed reads and game-back after recovery", async () => {
    const { pass, game, alerts, discord } = workerFixture({ STAFF_ALERTS_HEALTH_ENABLED: true });
    game.set(snapshot([{ steamId: ids[0], name: "A" }]));
    expect(await pass(undefined, 0)).toBe(IDLE_DELAY_MS);
    game.failWith(new RconError("The game server could not be reached.", false, "unreachable"));
    for (let index = 0; index < 21; index++) expect(await pass(undefined, 30_000)).toBe(FAILED_DELAY_MS);
    expect(alerts.list("primary").map((alert) => [alert.kind, alert.severity, alert.delivery.state])).toEqual([
      ["game-down", "high", "posted"],
    ]);
    game.failWith(null);
    await pass(undefined, 30_000);
    await pass(undefined, 15_000);
    expect(alerts.list("primary").map((alert) => alert.kind)).toEqual(["game-back", "game-down"]);
    expect(discord.channel.send).toHaveBeenCalledTimes(2);
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("infers its own round from status reads, with no other worker involved", async () => {
    const { pass, worker } = workerFixture({ STAFF_ALERTS_PERFORMANCE_ENABLED: "observe" });
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 0, deaths: 0 }], scores), 0);
    const first = worker.view().round;
    expect(first).toMatchObject({ id: expect.stringMatching(/^clock:\d+$/), phase: "live" });
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 1, deaths: 0 }], scores));
    expect(worker.view().round?.id).toBe(first?.id);
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 1, deaths: 0 }], { factionScores: [] }));
    expect(worker.view().round).toEqual({ ...first, phase: "unknown" });
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 0, deaths: 0 }], { ...scores, map: "Europe" }));
    expect(worker.view().round).toMatchObject({ phase: "live" });
    expect(worker.view().round?.id).not.toBe(first?.id);
    expect(worker.peaks()).toHaveLength(2);
  });

  it("does not process the same shared observation twice", async () => {
    const { worker, game } = workerFixture({ STAFF_ALERTS_HEALTH_ENABLED: true });
    const fixed = snapshot([]);
    game.overview.mockResolvedValue(fixed);
    await worker.tick();
    const before = worker.view().lastReadAt;
    jest.setSystemTime(Date.now() + 15_000);
    await worker.tick();
    expect(worker.view().lastReadAt).toBe(before);
  });

  it("records performance alerts without posting them in observe mode", async () => {
    const { pass, alerts, discord, game } = workerFixture({ STAFF_ALERTS_PERFORMANCE_ENABLED: "observe" });
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 0, deaths: 1 }], scores), 0);
    for (let step = 1; step <= 31; step++)
      expect(await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: step, deaths: 1 }], scores))).toBe(
        ACTIVE_DELAY_MS,
      );
    const [alert] = alerts.list("primary");
    expect(alert).toMatchObject({
      kind: "performance-window",
      severity: "warning",
      title: "Review: unusual kill rate",
      player: { steamId: ids[0], name: "Ace" },
      delivery: { state: "observe", reason: null },
    });
    expect(alert.lines[0]).toBe("Ace had 30 kills in 5 min (6/min).");
    expect(alert.lines.at(-1)).toBe("From game counters only. Not proof of cheating. Gramps took no action.");
    expect(alert.lines.join(" ")).not.toMatch(/cheater|suspected cheat/i);
    expect(discord.client.channels.fetch).not.toHaveBeenCalled();
    expect(game.reservedSlots).not.toHaveBeenCalled();
  });

  it("posts performance alerts when on, never reading the whitelist unless asked", async () => {
    const { pass, alerts, discord, game } = workerFixture({ STAFF_ALERTS_PERFORMANCE_ENABLED: "true" });
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 0, deaths: 1 }], scores), 0);
    for (let step = 1; step <= 31; step++)
      await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: step, deaths: 1 }], scores));
    expect(alerts.list("primary")[0].delivery.state).toBe("posted");
    expect(discord.channel.send.mock.calls[0][0].content).toBeUndefined();
    expect(game.reservedSlots).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("reads no counters, raises nothing and says so when the roster has no kills", async () => {
    const { pass, alerts, worker } = workerFixture({ STAFF_ALERTS_PERFORMANCE_ENABLED: "true" });
    for (let step = 0; step < 40; step++) await pass(snapshot([{ steamId: ids[0], name: "Ace" }], scores));
    expect(alerts.list("primary")).toEqual([]);
    expect(worker.view().counters).toBe("unavailable");
  });

  it("skips whitelisted players, reading the live reserved slots lazily with a 10-minute cache, and notes a failed read", async () => {
    const { pass, alerts, game } = workerFixture({
      STAFF_ALERTS_PERFORMANCE_ENABLED: "true",
      STAFF_ALERTS_PERFORMANCE_SKIP_WHITELISTED: true,
    });
    game.reservedSlots.mockResolvedValue({ ids: new Set([ids[0]]), loadedAt: new Date().toISOString() });
    const roster = (kills: number) =>
      snapshot(
        [
          { steamId: ids[0], name: "Member", kills, deaths: 1 },
          { steamId: ids[1], name: "Visitor", kills, deaths: 1 },
        ],
        scores,
      );
    await pass(roster(0), 0);
    for (let step = 1; step <= 20; step++) await pass(roster(step));
    expect(game.reservedSlots).not.toHaveBeenCalled();
    for (let step = 21; step <= 31; step++) await pass(roster(step));
    expect(game.reservedSlots).toHaveBeenCalledTimes(1);
    expect(alerts.list("primary").map((alert) => alert.player?.steamId)).toEqual([ids[1]]);
    expect(alerts.list("primary")[0].lines.join(" ")).not.toContain("Whitelist unavailable");

    // A new round eleven minutes later reads the whitelist again; this time the read fails.
    game.reservedSlots.mockRejectedValue(new RconError("The game server could not be reached.", false, "unreachable"));
    const next = (kills: number) =>
      snapshot([{ steamId: ids[2], name: "Third", kills, deaths: 1 }], { ...scores, map: "Europe" });
    await pass(next(0), 11 * 60_000);
    for (let step = 1; step <= 31; step++) await pass(next(step));
    expect(game.reservedSlots).toHaveBeenCalledTimes(2);
    expect(game.whitelist).not.toHaveBeenCalled();
    const [latest] = alerts.list("primary");
    expect(latest.player?.steamId).toBe(ids[2]);
    expect(latest.lines).toContain("Whitelist unavailable, so whitelisted players were not skipped.");
  });

  it("amends a round K/D alert when the kill-rate rule fires later, keeping its title, kind and notes in step", async () => {
    const { pass, alerts, game } = workerFixture({
      STAFF_ALERTS_PERFORMANCE_ENABLED: "true",
      STAFF_ALERTS_PERFORMANCE_SKIP_WHITELISTED: true,
      STAFF_ALERTS_PERFORMANCE_MATCH_KILLS: 10,
      STAFF_ALERTS_PERFORMANCE_MATCH_KD: 2,
      STAFF_ALERTS_PERFORMANCE_WINDOW_MINUTES: 2,
      STAFF_ALERTS_PERFORMANCE_WINDOW_KILLS: 20,
    });
    game.reservedSlots.mockRejectedValue(new RconError("The game server could not be reached.", false, "unreachable"));
    const roster = (kills: number) => snapshot([{ steamId: ids[0], name: "Ace", kills, deaths: 1 }], scores);
    let kills = 0;
    await pass(roster(kills), 0);
    // One kill every 10 seconds: the round K/D rule fires at 10 kills, the 2-minute rate stays below 20.
    while (kills < 10) await pass(roster(++kills));
    expect(alerts.list("primary")).toEqual([
      expect.objectContaining({ kind: "performance-match", title: "Review: unusual round K/D" }),
    ]);
    // Then a burst: three kills every 10 seconds trips the kill-rate rule in the same round.
    for (let step = 0; step < 12; step++) await pass(roster((kills += 3)));
    const [amended] = alerts.list("primary");
    expect(alerts.list("primary")).toHaveLength(1);
    expect(amended).toMatchObject({ kind: "performance-window", title: "Review: unusual kill rate" });
    expect(amended.lines[0]).toMatch(/^Ace had \d+ kills in 2 min/);
    expect(amended.lines).toContain("Whitelist unavailable, so whitelisted players were not skipped.");
  });

  it("attaches feed context only from the feed reader, never using it for the rule", async () => {
    const feed = {
      context: jest.fn().mockResolvedValue({
        kills: 4,
        windowKills: 3,
        headshotShare: 0.5,
        topCauses: ["Rifle"],
        maxDistanceMeters: 120,
        since: new Date(start).toISOString(),
      }),
    };
    const { pass, alerts } = workerFixture({ STAFF_ALERTS_PERFORMANCE_ENABLED: "observe" }, { feed });
    await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 0, deaths: 1 }], scores), 0);
    for (let step = 1; step <= 31; step++)
      await pass(snapshot([{ steamId: ids[0], name: "Ace", kills: step, deaths: 1 }], scores));
    expect(feed.context).toHaveBeenCalledTimes(1);
    const [, , range] = feed.context.mock.calls[0] as [string, string, { until: number; windowSince: number }];
    expect(range.windowSince).toBe(range.until - 5 * 60_000);
    expect(alerts.list("primary")[0].feed).toMatchObject({ kills: 4, headshotShare: 0.5 });

    const slow = { context: jest.fn(() => new Promise<never>(() => undefined)) };
    const late = workerFixture({ STAFF_ALERTS_PERFORMANCE_ENABLED: "observe" }, { feed: slow });
    await late.pass(snapshot([{ steamId: ids[0], name: "Ace", kills: 0, deaths: 1 }], scores), 0);
    for (let step = 1; step <= 29; step++)
      await late.pass(snapshot([{ steamId: ids[0], name: "Ace", kills: step, deaths: 1 }], scores));
    jest.setSystemTime(Date.now() + 10_000);
    late.game.set(snapshot([{ steamId: ids[0], name: "Ace", kills: 30, deaths: 1 }], scores));
    const tick = late.worker.tick();
    await jest.advanceTimersByTimeAsync(2_000);
    await tick;
    expect(late.alerts.list("primary")[0]).toMatchObject({ kind: "performance-window", feed: null });
  });

  it("infers a restart and feeds the seeding watch from the same reads", async () => {
    const base = Date.parse("2026-10-02T08:00:00Z");
    jest.setSystemTime(base);
    const { pass, alerts, game, discord, worker } = workerFixture({
      STAFF_ALERTS_HEALTH_ENABLED: true,
      STAFF_ALERTS_SEEDING_ENABLED: true,
    });
    const players = Array.from({ length: 12 }, (_, index) => ({ steamId: `765611980000${10000 + index}`, name: "P" }));
    await pass(snapshot(players), 0);
    await pass(snapshot(players), 15_000);
    // A restart: RCON fails briefly, then the server is back on another map with a new clock, empty.
    game.overview.mockRejectedValueOnce(new RconError("The game server could not be reached.", false, "unreachable"));
    game.overview.mockRejectedValueOnce(new RconError("The game server could not be reached.", false, "unreachable"));
    await pass(undefined, 15_000);
    await pass(undefined, 30_000);
    const empty = () => snapshot([], { map: "Europe", matchSeconds: 10, factionScores: [] });
    await pass(empty(), 30_000);
    expect(alerts.list("primary").map((alert) => [alert.kind, alert.severity])).toEqual([["game-restart", "warning"]]);
    expect(worker.view().lastRestartAt).toBe(new Date(base + 30_000).toISOString());
    for (let minute = 0; minute < 31; minute++) await pass(empty(), 60_000);
    expect(alerts.list("primary").map((alert) => alert.kind)).toEqual(["seeding-after-restart", "game-restart"]);
    expect(alerts.list("primary")[0].title).toBe("Still empty 30 min after the 04:00 ET restart");
    expect(worker.view().seeding).toEqual({
      lowSince: new Date(base + 90_000).toISOString(),
      alerted: ["after-restart"],
    });
    expect(discord.channel.send).toHaveBeenCalledTimes(2);
    expect(game.execute).not.toHaveBeenCalled();
  });

  const crowd = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ steamId: `765611980000${10000 + index}`, name: "P" }));
  const live = {
    map: "Kavkazi",
    matchSeconds: 1500,
    factionScores: [
      { name: "Lonestar", score: 400 },
      { name: "Valkyra", score: 350 },
    ],
  };
  const nextMap = {
    map: "Europe",
    matchSeconds: 5,
    factionScores: [
      { name: "Lonestar", score: 0 },
      { name: "Valkyra", score: 0 },
    ],
  };

  it("does not call an ordinary rotation a restart when the next map loads with an empty roster", async () => {
    jest.setSystemTime(Date.parse("2026-10-03T02:00:00Z"));
    const { pass, alerts, worker, discord } = workerFixture({
      STAFF_ALERTS_HEALTH_ENABLED: true,
      STAFF_ALERTS_SEEDING_ENABLED: true,
      STAFF_ALERTS_SEEDING_PRIME_HOURS: "",
    });
    const players = crowd(30);
    await pass(snapshot(players, live), 0);
    await pass(snapshot(players, live), 15_000);
    // Map travel: the next map reports an empty roster, reset scores and a new clock, then refills.
    await pass(snapshot([], nextMap), 15_000);
    await pass(snapshot([], nextMap), 15_000);
    await pass(snapshot(players.slice(0, 12), nextMap), 15_000);
    for (let read = 0; read < 80; read++) await pass(snapshot(players, nextMap), 15_000);
    expect(alerts.list("primary")).toEqual([]);
    expect(worker.view().lastRestartAt).toBeNull();
    // Later the server empties naturally. Nothing restarted, so there is no post-restart seeding alert.
    await pass(snapshot(players.slice(0, 3), nextMap), 15_000);
    for (let read = 0; read < 160; read++) await pass(snapshot([], nextMap), 15_000);
    expect(worker.view().seeding.lowSince).not.toBeNull();
    expect(alerts.list("primary")).toEqual([]);
    expect(discord.channel.send).not.toHaveBeenCalled();
  });

  it("does not call one failed read across an ordinary rotation a restart", async () => {
    const { pass, alerts, worker, game } = workerFixture({ STAFF_ALERTS_HEALTH_ENABLED: true });
    const players = crowd(30);
    const unreachable = () => new RconError("The game server could not be reached.", false, "unreachable");
    await pass(snapshot(players, live), 0);
    await pass(snapshot(players, live), 15_000);
    game.overview.mockRejectedValueOnce(unreachable());
    await pass(undefined, 15_000);
    // Everyone is still connected on the next map.
    await pass(snapshot(players, nextMap), 30_000);
    for (let read = 0; read < 40; read++) await pass(snapshot(players, nextMap), 15_000);
    // Again, but the first read on the next map is still loading with an empty roster.
    game.overview.mockRejectedValueOnce(unreachable());
    await pass(undefined, 15_000);
    const back = { ...nextMap, map: "Kavkazi", matchSeconds: 3 };
    await pass(snapshot([], back), 30_000);
    await pass(snapshot(players.slice(0, 20), back), 15_000);
    await pass(snapshot(players, back), 15_000);
    expect(alerts.list("primary")).toEqual([]);
    expect(worker.view().lastRestartAt).toBeNull();
  });
});

describe("staff alerts module wiring", () => {
  it("resolves the monitor, the watch-list source and the feed context without AdminService", async () => {
    const env = { get: () => undefined } as unknown as EnvService;
    @Global()
    @Module({
      providers: [
        { provide: EnvService, useValue: env },
        { provide: Client, useValue: discordDouble().client },
      ],
      exports: [EnvService, Client],
    })
    class TestGlobals {}
    const adapter = new ExpressAdapter(),
      host = new HttpAdapterHost();
    host.httpAdapter = adapter;
    const module = await Test.createTestingModule({ imports: [TestGlobals, StaffAlertsMonitorModule] })
      .overrideProvider(HttpAdapterHost)
      .useValue(host)
      .overrideProvider(AdminSettings)
      .useValue({ ...legacyServerSettings, get: () => ({}) })
      .overrideProvider(AdminStore)
      .useValue({})
      .overrideProvider(TelemetryStore)
      .useValue({})
      .compile();
    expect(module.get(StaffAlertsMonitor)).toBeInstanceOf(StaffAlertsMonitor);
    expect(module.get(NETWORK_BAN_SOURCES)).toEqual([expect.any(EnvWatchlistSource)]);
    expect(module.get(FEED_CONTEXT)).toBeInstanceOf(TelemetryFeedContext);
    expect(module.get(StaffAlertsController)).toBeInstanceOf(StaffAlertsController);
    await module.close();
  });
});
