import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AdminModule } from "./admin.module";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import { WardogsClient } from "./wardogs.client";
import { hash } from "./admin.auth";
import { AppController } from "../app.controller";
import { MapVotesController } from "../map-votes/map-votes.controller";
import { MapVotesService } from "../map-votes/map-votes.service";
import { ServerEventsController } from "../server-events/server-events.controller";
import { ServerEventsService } from "../server-events/server-events.service";
import { GameServers } from "./game-servers";
import { fixtureServers, legacyServerSettings } from "./game-server-fixture";

describe("admin HTTP boundaries", () => {
  let app: INestApplication;
  const token = "c".repeat(64);
  const session = {
    userId: "123456789012345678",
    displayName: "UNC admin",
    csrf: "test-csrf",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const store = {
    session: jest.fn(),
    createSession: jest.fn(),
    deleteSession: jest.fn(),
    begin: jest.fn(),
    finish: jest.fn(),
    history: jest.fn(),
  };
  const game = { overview: jest.fn(), execute: jest.fn(), configuration: jest.fn() };
  const votes = {
    controls: jest.fn().mockResolvedValue({ serverId: "primary", version: 0 }),
    saveControls: jest.fn().mockResolvedValue({ serverId: "primary", version: 1 }),
    setup: jest.fn().mockResolvedValue({ serverId: "primary", checks: [] }),
    list: jest.fn().mockResolvedValue({ enabled: false, votes: [] }),
    start: jest.fn(),
    cancel: jest.fn(),
  };
  const events = {
    list: jest.fn().mockResolvedValue({ enabled: false, events: [] }),
    history: jest.fn().mockResolvedValue({ operations: [] }),
    start: jest.fn(),
    stop: jest.fn(),
    restore: jest.fn(),
  };
  const config = {
    origin: "https://admin.example.test",
    clientId: "123",
    clientSecret: "private",
    secret: "s".repeat(40),
    guildId: "guild",
    botToken: "bot-token",
    ownerIds: [],
    adminRoleIds: ["staff"],
    moderatorRoleIds: ["moderator"],
    viewerRoleIds: ["viewer"],
    secure: true,
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    store.session.mockImplementation(async (key) => (key === hash(token) ? session : undefined));
    store.begin.mockResolvedValue({ created: true });
    store.finish.mockResolvedValue(undefined);
    game.overview.mockResolvedValue({ status: { serverName: "The UNCs" }, players: [] });
    game.execute.mockResolvedValue({ state: "accepted", message: "Accepted" });
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ roles: ["staff"] })));
    const adapter = new ExpressAdapter();
    const adapterHost = new HttpAdapterHost();
    adapterHost.httpAdapter = adapter;
    const module = await Test.createTestingModule({
      imports: [AdminModule],
      controllers: [AppController, MapVotesController, ServerEventsController],
      providers: [
        { provide: MapVotesService, useValue: votes },
        { provide: ServerEventsService, useValue: events },
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(adapterHost)
      .overrideProvider(AdminSettings)
      .useValue({ ...legacyServerSettings, get: () => config })
      .overrideProvider(AdminStore)
      .useValue(store)
      .overrideProvider(WardogsClient)
      .useValue(game)
      .overrideProvider(GameServers)
      .useValue(fixtureServers(game))
      .compile();
    app = module.createNestApplication(adapter);
    app.useLogger(false);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  it.each(["viewer", "moderator"])("keeps settings private from %s", async (role) => {
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ roles: [role] })));
    await request(app.getHttpServer())
      .get("/admin/api/settings")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(403);
    expect(game.configuration).not.toHaveBeenCalled();
  });
  it("opens staff tools at the admin host root while health checks stay independent of the game", async () => {
    await request(app.getHttpServer())
      .get("/")
      .expect(302)
      .expect("Location", "/admin")
      .expect("Cache-Control", "no-store");
    await request(app.getHttpServer()).get("/health").expect(200, { status: "ok" });
    expect(game.overview).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("serves the same static interface with security headers and blocks anonymous data", async () => {
    const page = await request(app.getHttpServer()).get("/admin").expect(200);
    expect(page.text).toContain('<div id="root"></div>');
    expect(page.text).toMatch(/type="module"[^>]+src="\/admin\/assets\/[^"]+\.js"/);
    expect(page.text).toContain('href="https://theuncsgaming.com/"');
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["cdn-cache-control"]).toBe("no-store");
    expect(page.headers["vercel-cdn-cache-control"]).toBe("no-store");
    expect(page.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    await request(app.getHttpServer()).get("/admin/api/overview").expect(401);
    expect(game.overview).not.toHaveBeenCalled();
  });
  it("serves compiled assets with matching CSP while rejecting traversal and missing assets", async () => {
    for (const file of ["barlow-condensed-bold.woff2", "barlow-condensed-extrabold.woff2", "dm-sans.woff2"]) {
      const font = await request(app.getHttpServer()).get(`/admin/assets/${file}`).expect(200);
      expect(font.headers["content-type"]).toBe("font/woff2");
      expect(font.headers["content-security-policy"]).toContain("font-src 'self'");
      expect(font.headers["cdn-cache-control"]).toBe("no-store");
      expect(font.headers["vercel-cdn-cache-control"]).toBe("no-store");
    }
    await request(app.getHttpServer())
      .get("/admin/assets/uncs-mascot.png")
      .expect(200)
      .expect("Content-Type", "image/png");
    await request(app.getHttpServer()).get("/admin/assets/package.json").expect(404);
    await request(app.getHttpServer()).get("/admin/assets/constructor").expect(404);
    const traversal = await request(app.getHttpServer()).get("/admin/assets/..%2F..%2Fadmin.settings.ts").expect(403);
    expect(traversal.text).not.toContain("clientSecret");
    expect(traversal.body).toEqual({ message: "Forbidden." });
  });
  it("answers a missing or unreadable asset without the server's filesystem path", async () => {
    for (const path of ["missing.js", "package.json", "uncs-mascot.png/missing", `${"a".repeat(300)}.js`]) {
      const response = await request(app.getHttpServer()).get(`/admin/assets/${path}`).expect(404);
      expect(response.body).toEqual({ message: "Not found." });
      expect(response.text).not.toMatch(/ENOENT|ENOTDIR|ENAMETOOLONG|dist|public/);
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    }
    const hidden = await request(app.getHttpServer()).get("/admin/assets/.env").expect(403);
    expect(hidden.body).toEqual({ message: "Forbidden." });
  });
  it("answers a dashboard page without the server's filesystem path when the build is missing", async () => {
    jest.spyOn(process, "cwd").mockReturnValue(join(process.cwd(), "missing-build"));
    for (const path of ["/admin", "/admin/overview", "/admin/players"]) {
      const response = await request(app.getHttpServer()).get(path).expect(503);
      expect(response.body).toEqual({ message: "The dashboard is unavailable." });
      expect(response.text).not.toMatch(/ENOENT|missing-build|dist|public|index\.html/);
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    }
  });
  it("supports dashboard deep links without swallowing API, auth, or missing-file errors", async () => {
    for (const path of ["players", "applications", "supporters", "combat", "match", "votes"]) {
      const page = await request(app.getHttpServer()).get(`/admin/${path}`).expect(200);
      expect(page.text).toContain('<div id="root"></div>');
      expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    }
    const page = await request(app.getHttpServer()).get("/admin").expect(200);
    const script = page.text.match(/src="(\/admin\/assets\/[^"]+\.js)"/)?.[1];
    expect(script).toBeDefined();
    const asset = await request(app.getHttpServer()).get(script!).expect(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["content-security-policy"]).toContain("script-src 'self'");
    for (const path of ["api/missing", "auth/missing", "assets/missing.js", "app.js", "style.css", "missing"]) {
      const response = await request(app.getHttpServer()).get(`/admin/${path}`).expect(404);
      expect(response.text).not.toContain('<div id="root"></div>');
    }
    expect(game.overview).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("requires both the correct origin and session CSRF for mutations", async () => {
    const action = { id: randomUUID(), action: "broadcast", message: "Hello", reason: "Community welcome" };
    await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .send(action)
      .expect(403);
    await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send(action)
      .expect(201);
    expect(game.execute).toHaveBeenCalledTimes(1);
    expect(store.begin.mock.invocationCallOrder[0]).toBeLessThan(game.execute.mock.invocationCallOrder[0]);
  });
  it("keeps map ballot data private and prevents shared caching", async () => {
    await request(app.getHttpServer()).get("/admin/api/map-votes").expect(401);
    expect(votes.list).not.toHaveBeenCalled();
    const result = await request(app.getHttpServer())
      .get("/admin/api/map-votes")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(votes.list).toHaveBeenCalledWith(expect.objectContaining({ id: session.userId }));
  });
  it("keeps the voting setup check authenticated, uncached and scoped to a known server", async () => {
    const path = "/admin/api/servers/primary/map-votes/setup";
    await request(app.getHttpServer()).get(path).expect(401);
    expect(votes.setup).not.toHaveBeenCalled();
    const result = await request(app.getHttpServer())
      .get(path)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(votes.setup).toHaveBeenCalledWith(expect.objectContaining({ id: session.userId, serverId: "primary" }));
    votes.setup.mockClear();
    await request(app.getHttpServer())
      .get("/admin/api/servers/unknown/map-votes/setup")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(404);
    expect(votes.setup).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("protects voting switches with the session, same-origin CSRF and explicit server target", async () => {
    const path = "/admin/api/servers/primary/map-votes/controls";
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer()).post(path).send({}).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .send({})
      .expect(403);
    expect(votes.saveControls).not.toHaveBeenCalled();
    const result = await request(app.getHttpServer())
      .get(path)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(votes.controls).toHaveBeenCalledWith(expect.objectContaining({ serverId: "primary", id: session.userId }));
    expect(game.execute).not.toHaveBeenCalled();
  });
  it.each(["/admin/api/events", "/admin/api/events/d0a3cdd7-a1c7-4904-a99e-cf058b432c34/operations"])(
    "keeps %s private and uncached",
    async (path) => {
      await request(app.getHttpServer()).get(path).expect(401);
      expect(events.list).not.toHaveBeenCalled();
      expect(events.history).not.toHaveBeenCalled();
      const result = await request(app.getHttpServer())
        .get(path)
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .expect(200);
      expect(result.headers["cache-control"]).toBe("no-store");
    },
  );
  it.each([
    "/admin/api/events",
    "/admin/api/events/d0a3cdd7-a1c7-4904-a99e-cf058b432c34/stop",
    "/admin/api/events/d0a3cdd7-a1c7-4904-a99e-cf058b432c34/restore",
  ])("guards %s with session, origin and CSRF", async (path) => {
    await request(app.getHttpServer()).post(path).send({}).expect(401);
    for (const [origin, csrf] of [
      ["https://evil.example.test", session.csrf],
      [config.origin, "wrong"],
      [config.origin, ""],
    ])
      await request(app.getHttpServer())
        .post(path)
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .set("Origin", origin)
        .set("X-CSRF-Token", csrf)
        .send({})
        .expect(403);
    expect(events.start).not.toHaveBeenCalled();
    expect(events.stop).not.toHaveBeenCalled();
    expect(events.restore).not.toHaveBeenCalled();
    const body = { id: randomUUID(), reason: "Reviewed event" };
    await request(app.getHttpServer())
      .post(path)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send(body)
      .expect(201);
    const calls = path.endsWith("stop")
      ? events.stop.mock.calls
      : path.endsWith("restore")
        ? events.restore.mock.calls
        : events.start.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].at(-1)).toEqual(body);
  });
  it.each(["/admin/api/map-votes", "/admin/api/map-votes/d0a3cdd7-a1c7-4904-a99e-cf058b432c34/cancel"])(
    "protects %s with session, origin and CSRF checks",
    async (path) => {
      await request(app.getHttpServer()).post(path).send({}).expect(401);
      for (const [origin, csrf] of [
        ["https://evil.example.test", session.csrf],
        [config.origin, "wrong"],
        [config.origin, ""],
      ]) {
        await request(app.getHttpServer())
          .post(path)
          .set("Cookie", `__Host-uncs_admin_session=${token}`)
          .set("Origin", origin)
          .set("X-CSRF-Token", csrf)
          .send({})
          .expect(403);
      }
      expect(votes.start).not.toHaveBeenCalled();
      expect(votes.cancel).not.toHaveBeenCalled();
      const body = { id: randomUUID(), reason: "Test ballot" };
      await request(app.getHttpServer())
        .post(path)
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .set("Origin", config.origin)
        .set("X-CSRF-Token", session.csrf)
        .send(body)
        .expect(201);
      const calls = path.endsWith("cancel") ? votes.cancel.mock.calls : votes.start.mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0].at(-1)).toEqual(body);
    },
  );
  it.each(["Discord outage", "removed staff role"])(
    "allows sign-out during %s without a membership request",
    async (failure) => {
      const network = jest.mocked(fetch);
      if (failure === "Discord outage") network.mockRejectedValue(new Error("Discord unavailable"));
      else network.mockResolvedValue(new Response(JSON.stringify({ roles: [] })));
      const result = await request(app.getHttpServer())
        .post("/admin/api/logout")
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .set("Origin", config.origin)
        .set("X-CSRF-Token", session.csrf)
        .send({})
        .expect(201, { ok: true });
      expect(store.deleteSession).toHaveBeenCalledWith(hash(token));
      expect(String(result.headers["set-cookie"])).toContain("__Host-uncs_admin_session=;");
      expect(network).not.toHaveBeenCalled();
      expect(game.overview).not.toHaveBeenCalled();
      expect(game.execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["https://evil.example.test", session.csrf],
    [config.origin, "wrong-csrf"],
    [config.origin, ""],
  ])("rejects sign-out with invalid origin/CSRF (%s, %s)", async (origin, csrf) => {
    await request(app.getHttpServer())
      .post("/admin/api/logout")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .send({})
      .expect(403);
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects anonymous sign-out and does not revoke sessions on GET", async () => {
    await request(app.getHttpServer()).post("/admin/api/logout").set("Origin", config.origin).send({}).expect(401);
    await request(app.getHttpServer())
      .get("/admin/api/logout")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(404);
    expect(store.deleteSession).not.toHaveBeenCalled();
  });
  it("rejects expired sign-out sessions without contacting Discord", async () => {
    store.session.mockResolvedValue({ ...session, expiresAt: new Date(Date.now() - 1) });
    await request(app.getHttpServer())
      .post("/admin/api/logout")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send({})
      .expect(401);
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not confirm sign-out or clear cookies when session revocation fails", async () => {
    store.deleteSession.mockRejectedValueOnce(new Error("private database connection details"));
    const result = await request(app.getHttpServer())
      .post("/admin/api/logout")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send({})
      .expect(503);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.text).not.toContain("private database");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects foreign origins even when forwarded headers pretend to be the website", async () => {
    await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", "https://evil.example.test")
      .set("X-Forwarded-Host", "admin.example.test")
      .set("X-Forwarded-Proto", "https")
      .set("X-CSRF-Token", session.csrf)
      .send({ id: randomUUID(), action: "broadcast", message: "Hello", reason: "Community welcome" })
      .expect(403);
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("enforces viewer permissions on the server instead of trusting hidden controls", async () => {
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["viewer"] })));
    await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send({ id: randomUUID(), action: "broadcast", message: "Hello", reason: "Community welcome" })
      .expect(403);
    expect(store.begin).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it.each(["Valkyra", "Lonestar", "Manticore"])(
    "allows a moderator to move a player to %s with an individual audit record",
    async (faction) => {
      jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["moderator"] })));
      const action = {
        id: randomUUID(),
        action: "team",
        steamId: "76561198066952872",
        confirm: "76561198066952872",
        faction,
        reason: "Staff requested team balance",
      };
      const result = await request(app.getHttpServer())
        .post("/admin/api/actions")
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .set("Origin", config.origin)
        .set("X-CSRF-Token", session.csrf)
        .send(action)
        .expect(201);
      expect(result.body).toEqual({ id: action.id, state: "accepted", message: "Accepted" });
      expect(store.begin).toHaveBeenCalledWith(
        expect.objectContaining({ id: session.userId, role: "moderator" }),
        { ...action, serverId: "primary", serverVersion: "0".repeat(64) },
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
      expect(store.begin.mock.invocationCallOrder[0]).toBeLessThan(game.execute.mock.invocationCallOrder[0]);
      expect(game.execute).toHaveBeenCalledTimes(1);
      expect(game.execute).toHaveBeenCalledWith({ ...action, serverId: "primary", serverVersion: "0".repeat(64) });
      expect(store.finish).toHaveBeenCalledWith(action.id, { state: "accepted", message: "Accepted" });
    },
  );
  it("rejects a viewer's direct team-change request before audit or game execution", async () => {
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["viewer"] })));
    await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send({
        id: randomUUID(),
        action: "team",
        steamId: "76561198066952872",
        confirm: "76561198066952872",
        faction: "Manticore",
        reason: "Staff requested team balance",
      })
      .expect(403);
    expect(store.begin).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("rejects a team-change confirmation for a different player", async () => {
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["moderator"] })));
    const result = await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send({
        id: randomUUID(),
        action: "team",
        steamId: "76561198066952872",
        confirm: "76561198066952873",
        faction: "Valkyra",
        reason: "Staff requested team balance",
      })
      .expect(400);
    expect(result.body.message).toContain("confirmation SteamID does not match");
    expect(store.begin).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("limits OAuth traffic without trusting caller-supplied forwarded addresses", async () => {
    for (let count = 0; count < 60; count++) {
      await request(app.getHttpServer())
        .get("/admin/auth/login")
        .set("X-Forwarded-For", `192.0.2.${count}`)
        .expect(302);
    }
    const denied = await request(app.getHttpServer())
      .get("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.1")
      .expect(429);
    expect(denied.headers["retry-after"]).toBe("60");
    expect(denied.headers["cache-control"]).toBe("no-store");
  });
  it("does not send invalid SteamIDs or unknown payload fields to RCON", async () => {
    await request(app.getHttpServer())
      .post("/admin/api/actions")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", session.csrf)
      .send({
        id: randomUUID(),
        action: "ban",
        steamId: "not-an-id",
        confirm: "not-an-id",
        reason: "Bad actor",
        path: "/v1/config",
      })
      .expect(400);
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("contains internal failures instead of leaking database or upstream secrets", async () => {
    store.session.mockRejectedValue(new Error("postgres://username:password@internal-host/private"));
    const result = await request(app.getHttpServer())
      .get("/admin/api/me")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(503);
    expect(result.text).not.toMatch(/postgres|password|internal-host/);
  });
  it("completes OAuth into a revocable secure session without exposing tokens", async () => {
    const login = await request(app.getHttpServer()).get("/admin/auth/login").expect(302);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const state = new URL(login.headers.location).searchParams.get("state");
    const network = jest.mocked(fetch);
    network.mockReset();
    network
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "discord-access-secret" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: session.userId, username: "UNC admin", mfa_enabled: true })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ["staff"] })));
    const callback = await request(app.getHttpServer())
      .get("/admin/auth/callback")
      .query({ code: "one-time-code", state })
      .set("Cookie", cookie)
      .expect(302);
    expect(callback.headers.location).toBe("/admin");
    const cookies = String(callback.headers["set-cookie"]);
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).not.toContain("discord-access-secret");
    expect(store.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: session.userId, tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    );
  });
});
