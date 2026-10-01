import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AdminModule } from "./admin.module";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import { GameServers } from "./game-servers";
import { WardogsClient } from "./wardogs.client";
import { hash } from "./admin.auth";
import type { AdminAction, Staff } from "./admin.types";

describe("two-server HTTP isolation", () => {
  let app: INestApplication;
  const token = "c".repeat(64),
    userId = "123456789012345678",
    steamId = "76561198000000001";
  const definitions = [
    { id: "east", name: "East", version: "1".repeat(64) },
    { id: "central", name: "Central", version: "2".repeat(64) },
  ];
  let roles: string[], centralAccess: "admin" | "viewer" | "none";
  const records = new Map<
    string,
    { actorId: string; requestHash: string; details: AdminAction; state: string; message: string }
  >();
  const store = {
    session: jest.fn(async (key: string) =>
      key === hash(token)
        ? { userId, displayName: "Staff", csrf: "test", expiresAt: new Date(Date.now() + 60_000) }
        : undefined,
    ),
    begin: jest.fn(async (staff: Staff, action: AdminAction, requestHash: string) => {
      const previous = records.get(action.id);
      if (previous) return { created: false, record: previous };
      const record = { actorId: staff.id, requestHash, details: action, state: "started", message: "Started" };
      records.set(action.id, record);
      return { created: true, record };
    }),
    finish: jest.fn(async (id: string, result: { state: string; message: string }) =>
      Object.assign(records.get(id)!, result),
    ),
    history: jest.fn(async (id: string) => [...records.values()].filter((r) => r.details.serverId === id)),
    receipt: jest.fn(async (id: string, serverId: string) =>
      records.get(id)?.details.serverId === serverId ? records.get(id) : null,
    ),
  };
  const games = Object.fromEntries(
    definitions.map(({ id }) => [
      id,
      {
        overview: jest.fn(async () => ({ status: { serverName: id }, players: [{ steamId, name: `${id} player` }] })),
        whitelist: jest.fn(async () => ({ entries: [{ steamId, active: id === "east" }] })),
        execute: jest.fn(async () => ({ state: "accepted", message: `Accepted by ${id}` })),
      },
    ]),
  );
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
    serverRoles: (id: string) =>
      id === "east"
        ? undefined
        : {
            admin: centralAccess === "admin" ? ["staff", "viewer"] : [],
            moderator: [],
            viewer: centralAccess === "viewer" ? ["staff", "viewer"] : [],
          },
  };
  const registry = new GameServers(settings as unknown as AdminSettings);
  registry.get = (id) => {
    registry.resolve(id);
    return games[id] as unknown as WardogsClient;
  };
  const read = (path: string) =>
    request(app.getHttpServer()).get(`/admin/api/${path}`).set("Cookie", `__Host-uncs_admin_session=${token}`);
  const send = (
    server: string,
    body: object,
    version: string | null = definitions.find((d) => d.id === server)!.version,
  ) => {
    const req = request(app.getHttpServer())
      .post(`/admin/api/servers/${server}/actions`)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "test");
    if (version !== null) req.set("X-UNCs-Server-Version", version);
    return req.send(body);
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    records.clear();
    roles = ["staff"];
    centralAccess = "admin";
    config.ownerIds = [];
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ roles })));
    const adapter = new ExpressAdapter(),
      host = new HttpAdapterHost();
    host.httpAdapter = adapter;
    const module = await Test.createTestingModule({ imports: [AdminModule] })
      .overrideProvider(HttpAdapterHost)
      .useValue(host)
      .overrideProvider(AdminSettings)
      .useValue(settings)
      .overrideProvider(AdminStore)
      .useValue(store)
      .overrideProvider(GameServers)
      .useValue(registry)
      .overrideProvider(WardogsClient)
      .useValue({})
      .compile();
    app = module.createNestApplication(adapter, { logger: false });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  it("requires selection even with valid staff access and returns only safe permitted labels", async () => {
    centralAccess = "none";
    const res = await read("servers").expect(200);
    expect(res.body).toEqual({ legacy: false, servers: [{ ...definitions[0], role: "admin" }] });
    await read("overview").expect(400);
    await read("servers/central/overview").expect(403);
    await read("servers/missing/overview").expect(404);
    expect(games.east.overview).not.toHaveBeenCalled();
    expect(games.central.overview).not.toHaveBeenCalled();
  });
  it("keeps simultaneous reads and matching SteamIDs separate, including cached resources", async () => {
    const [east, central] = await Promise.all([
      read("servers/east/overview").expect(200),
      read("servers/central/overview").expect(200),
    ]);
    expect(east.body.players[0]).toEqual({ steamId, name: "east player" });
    expect(central.body.players[0]).toEqual({ steamId, name: "central player" });
    expect((await read("servers/east/whitelist")).body.entries[0].active).toBe(true);
    expect((await read("servers/central/whitelist")).body.entries[0].active).toBe(false);
    await read("servers/east/whitelist");
    await read("servers/central/whitelist");
    expect(games.east.whitelist).toHaveBeenCalledTimes(1);
    expect(games.central.whitelist).toHaveBeenCalledTimes(1);
  });
  it("records and executes only the selected target and refuses cross-server receipt replay", async () => {
    const action = { id: randomUUID(), action: "broadcast", message: "Test notice", reason: "Isolation rehearsal" };
    await send("east", action).expect(201);
    expect(games.east.execute).toHaveBeenCalledWith({
      ...action,
      serverId: "east",
      serverVersion: definitions[0].version,
    });
    await send("central", action).expect(409);
    expect(games.central.execute).not.toHaveBeenCalled();
    expect((await read(`servers/east/audit/${action.id}`)).body.record.details.serverId).toBe("east");
    expect((await read(`servers/central/audit/${action.id}`)).body.record).toBeNull();
    expect((await read("servers/central/audit")).body).toEqual([]);
  });
  it("rejects missing, stale and mismatched review targets before recording anything", async () => {
    const body = { id: randomUUID(), action: "broadcast", message: "Test notice", reason: "Reviewed" };
    await send("east", body, null).expect(409);
    await send("east", body, definitions[1].version).expect(409);
    await send("east", { ...body, serverId: "central" }).expect(400);
    expect(store.begin).not.toHaveBeenCalled();
    expect(games.east.execute).not.toHaveBeenCalled();
  });
  it("restricts each server without elevating global staff roles and rechecks role removal on writes", async () => {
    centralAccess = "viewer";
    expect((await read("servers")).body.servers[1].role).toBe("viewer");
    await send("central", { id: randomUUID(), action: "broadcast", message: "Test", reason: "Reviewed" }).expect(403);
    roles = ["viewer"];
    centralAccess = "admin";
    await send("central", { id: randomUUID(), action: "broadcast", message: "Test", reason: "Reviewed" }).expect(403);
    roles = [];
    await send("east", { id: randomUUID(), action: "broadcast", message: "Test", reason: "Reviewed" }).expect(403);
    expect(store.begin).not.toHaveBeenCalled();
  });
  it("retains explicit community-owner access while still requiring server selection", async () => {
    config.ownerIds = [userId];
    roles = [];
    centralAccess = "none";
    expect((await read("servers")).body.servers.map((server: { role: string }) => server.role)).toEqual([
      "admin",
      "admin",
    ]);
    await read("overview").expect(400);
  });
});
