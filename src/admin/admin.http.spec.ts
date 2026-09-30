import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AdminModule } from "./admin.module";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import { WardogsClient } from "./wardogs.client";
import { hash } from "./admin.auth";
import { AppController } from "../app.controller";

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
  const game = { overview: jest.fn(), execute: jest.fn() };
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
    const module = await Test.createTestingModule({ imports: [AdminModule], controllers: [AppController] })
      .overrideProvider(HttpAdapterHost)
      .useValue(adapterHost)
      .overrideProvider(AdminSettings)
      .useValue({ get: () => config })
      .overrideProvider(AdminStore)
      .useValue(store)
      .overrideProvider(WardogsClient)
      .useValue(game)
      .compile();
    app = module.createNestApplication(adapter);
    app.useLogger(false);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
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
    for (const file of ["barlow-condensed-bold.ttf", "barlow-condensed-extrabold.ttf", "dm-sans.ttf"]) {
      const font = await request(app.getHttpServer()).get(`/admin/assets/${file}`).expect(200);
      expect(font.headers["content-type"]).toBe("font/ttf");
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
  });
  it("supports dashboard deep links without swallowing API, auth, or missing-file errors", async () => {
    for (const path of ["players", "applications", "supporters", "combat", "match"]) {
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
        action,
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
      expect(store.begin.mock.invocationCallOrder[0]).toBeLessThan(game.execute.mock.invocationCallOrder[0]);
      expect(game.execute).toHaveBeenCalledTimes(1);
      expect(game.execute).toHaveBeenCalledWith(action);
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
