import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Logger, type INestApplication } from "@nestjs/common";
import type { Client } from "discord.js";
import request from "supertest";
import { AdminModule } from "../admin/admin.module";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { hash } from "../admin/admin.auth";
import { GameServers } from "../admin/game-servers";
import { WardogsClient } from "../admin/wardogs.client";
import { EnvService } from "../env/env.service";
import { NETWORK_BAN_SOURCES } from "./network-bans";
import { StaffAlertsController } from "./staff-alerts.controller";
import { StaffAlertsMonitor } from "./staff-alerts.monitor";
import { StaffAlerts } from "./staff-alerts.service";

describe("staff alerts API", () => {
  let app: INestApplication;
  let alerts: StaffAlerts;
  let roles: string[];
  const token = "c".repeat(64),
    userId = "123456789012345678",
    player = "76561198000000001",
    knownGood = "76561198000000008",
    watched = "76561198000000009";
  const definitions = [
    { id: "east", name: "East", version: "1".repeat(64) },
    { id: "central", name: "Central", version: "2".repeat(64) },
  ];
  const config = {
    origin: "https://admin.example.test",
    clientId: "test",
    clientSecret: "private",
    secret: "s".repeat(40),
    guildId: "guild",
    botToken: "bot",
    ownerIds: [] as string[],
    adminRoleIds: ["staff"],
    moderatorRoleIds: ["mod"],
    viewerRoleIds: ["viewer"],
    secure: true,
  };
  const settings = {
    get: () => config,
    servers: () => definitions,
    explicitServers: () => true,
    serverRoles: () => undefined,
  };
  const store = {
    session: jest.fn(async (key: string) =>
      key === hash(token)
        ? { userId, displayName: "Mod One", csrf: "test", expiresAt: new Date(Date.now() + 60_000) }
        : undefined,
    ),
  };
  const games = {
    east: { overview: jest.fn(), execute: jest.fn() },
    central: { overview: jest.fn(), execute: jest.fn() },
  };
  const registry = new GameServers(settings as unknown as AdminSettings);
  registry.get = (id) => {
    registry.resolve(id);
    return games[id as keyof typeof games] as unknown as WardogsClient;
  };
  registry.connectionHash = () => "a".repeat(64);
  const values: Record<string, unknown> = {
    STAFF_ALERTS_ENABLED: false,
    STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: [{ steamId: knownGood, note: "owner" }],
    STAFF_ALERTS_WATCHLIST: [{ steamId: watched, reason: "Aimbot" }],
  };
  const env = { get: (key: string) => values[key] } as EnvService;
  const read = (path: string) =>
    request(app.getHttpServer()).get(`/admin/api/${path}`).set("Cookie", `__Host-uncs_admin_session=${token}`);
  const post = (server: string, path: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/admin/api/servers/${server}/staff-alerts/${path}`)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "test")
      .set("X-UNCs-Server-Version", definitions.find((definition) => definition.id === server)!.version)
      .send(body as object);

  beforeEach(async () => {
    roles = ["mod"];
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ roles })));
    alerts = new StaffAlerts({ isReady: () => false } as unknown as Client, env);
    const adapter = new ExpressAdapter(),
      host = new HttpAdapterHost();
    host.httpAdapter = adapter;
    const module = await Test.createTestingModule({
      imports: [AdminModule],
      controllers: [StaffAlertsController],
      providers: [
        StaffAlertsMonitor,
        { provide: StaffAlerts, useValue: alerts },
        { provide: EnvService, useValue: env },
        { provide: NETWORK_BAN_SOURCES, useValue: [] },
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(host)
      .overrideProvider(AdminSettings)
      .useValue(settings)
      .overrideProvider(AdminStore)
      .useValue(store)
      .overrideProvider(GameServers)
      .useValue(registry)
      .compile();
    app = module.createNestApplication(adapter, { logger: false });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  const raise = (serverId: string, kind: "performance-match" | "game-down" = "performance-match") =>
    alerts.raise({
      serverId,
      kind,
      severity: "warning",
      key: `${kind}:${Math.random()}`,
      title: kind === "game-down" ? "Game unreachable for 10 min" : "Review: unusual round K/D",
      lines: ["Gramps took no action."],
      ...(kind === "performance-match" ? { player: { steamId: player, name: "Ace" } } : {}),
      deliver: false,
    });

  it("scopes the status to the selected server and starts no worker while off", async () => {
    const east = await raise("east");
    await raise("central", "game-down");
    const body = (await read("servers/east/staff-alerts").expect(200)).body;
    expect(body).toMatchObject({ serverId: "east", enabled: false, worker: { state: "off" } });
    expect(body.alerts.map((alert: { id: string }) => alert.id)).toEqual([east!.id]);
    const central = (await read("servers/central/staff-alerts").expect(200)).body;
    expect(central.alerts.map((alert: { kind: string }) => alert.kind)).toEqual(["game-down"]);
    await read("staff-alerts").expect(400);
    await read("servers/missing/staff-alerts").expect(404);
    expect(games.east.overview).not.toHaveBeenCalled();
    expect(games.east.execute).not.toHaveBeenCalled();
  });

  it("returns list counts, never the known-good or watch-list contents", async () => {
    const body = (await read("servers/east/staff-alerts").expect(200)).body;
    expect(body.settings).toMatchObject({ knownGoodCount: 1, watchlistCount: 1 });
    const text = JSON.stringify(body);
    expect(text).not.toContain(knownGood);
    expect(text).not.toContain(watched);
    expect(text).not.toContain("Aimbot");
  });

  it("lets a viewer read but not review or snooze", async () => {
    roles = ["viewer"];
    const alert = await raise("east");
    await read("servers/east/staff-alerts").expect(200);
    await post("east", `${alert!.id}/review`, { decision: "ack" }).expect(403);
    await post("east", "snooze", { category: "all", minutes: 60 }).expect(403);
    expect(alerts.list("east")[0].review).toBeNull();
    expect(alerts.activeSnoozes("east")).toEqual([]);
  });

  it("lets a moderator mark a performance alert legit or never flag it", async () => {
    const alert = await raise("east");
    const legit = (await post("east", `${alert!.id}/review`, { decision: "legit" }).expect(201)).body;
    expect(legit.alert.review).toMatchObject({ decision: "legit", by: "Mod One" });
    expect(legit.knownGoodEntry).toBeUndefined();
    const never = (await post("east", `${alert!.id}/review`, { decision: "never" }).expect(201)).body;
    expect(JSON.parse(never.knownGoodEntry)).toMatchObject({ steamId: player });
    expect(alerts.sessionNever().has(player)).toBe(true);
    const snoozed = (await post("east", "snooze", { category: "performance", minutes: 60 }).expect(201)).body;
    expect(snoozed.snoozes).toEqual([expect.objectContaining({ category: "performance", by: "Mod One" })]);
    await post("east", "snooze", { category: "performance", minutes: 0 }).expect(201);
    expect(alerts.activeSnoozes("east")).toEqual([]);
  });

  it("returns 404 for unknown or other-server alerts and 400 for a bad body", async () => {
    const alert = await raise("east");
    const down = await raise("east", "game-down");
    await post("east", "aaaaaaaaaaaa/review", { decision: "ack" }).expect(404);
    await post("east", "not-an-id/review", { decision: "ack" }).expect(404);
    await post("central", `${alert!.id}/review`, { decision: "ack" }).expect(404);
    await post("east", `${alert!.id}/review`, { decision: "ban" }).expect(400);
    await post("east", `${alert!.id}/review`, { decision: "ack", extra: true }).expect(400);
    await post("east", `${down!.id}/review`, { decision: "legit" }).expect(400);
    await post("east", "snooze", { category: "all", minutes: 10 }).expect(400);
    await post("east", "snooze", { category: "everything", minutes: 60 }).expect(400);
    await post("east", "snooze", { category: "all", minutes: 60, until: "forever" }).expect(400);
  });
});
