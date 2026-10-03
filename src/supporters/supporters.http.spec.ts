import { Global, Logger, Module, type INestApplication, type MiddlewareConsumer } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { hash } from "../admin/admin.auth";
import { SupportersModule } from "./supporters.module";
import { SupportersStore } from "./supporters.store";
import { DiscordRolesDiscord } from "../discord-roles/discord-roles.discord";
import { DiscordRolesStore } from "../discord-roles/discord-roles.store";
import { PatreonSyncService } from "./patreon-sync.service";
import { AppExceptionFilter } from "../common/filters/app-exception.filter";

const secret = "separate-patreon-webhook-secret";
const values: Record<string, unknown> = {
  PATREON_ENABLED: true,
  PATREON_CAMPAIGN_ID: "123",
  PATREON_WEBHOOK_SECRET: secret,
};
@Global()
@Module({
  providers: [{ provide: EnvService, useValue: { get: (key: string) => values[key] } }],
  exports: [EnvService],
})
class TestEnvModule {}
describe("private supporters HTTP boundary", () => {
  let app: INestApplication;
  const sessionToken = "c".repeat(64);
  const store = { ingest: jest.fn(), list: jest.fn(), mutate: jest.fn(), register: jest.fn(), recordPaypal: jest.fn() };
  const adminStore = { session: jest.fn() };
  const game = { execute: jest.fn() };
  const sync = { configured: jest.fn(), status: jest.fn(), staffSync: jest.fn() };
  const config = {
    origin: "https://theuncs.example",
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
    store.ingest.mockResolvedValue({ duplicate: false });
    store.list.mockResolvedValue([]);
    store.mutate.mockResolvedValue({ ok: true, replayed: false });
    store.register.mockResolvedValue({ ok: true, replayed: false });
    store.recordPaypal.mockResolvedValue({ ok: true, replayed: false });
    sync.configured.mockReturnValue(true);
    sync.status.mockReturnValue({ configured: true, running: false, members: 2, lastError: null });
    sync.staffSync.mockResolvedValue({ joined: false, sync: { configured: true, running: false, members: 2 } });
    adminStore.session.mockImplementation(async (key) =>
      key === hash(sessionToken)
        ? { userId: "123456789012345678", displayName: "Admin", csrf: "csrf", expiresAt: new Date(Date.now() + 60_000) }
        : undefined,
    );
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ roles: ["staff"] })));
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    // Production registers this filter globally, so status assertions here go through it.
    const module = await Test.createTestingModule({
      imports: [TestEnvModule, SupportersModule],
      providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
    })
      .overrideProvider(SupportersStore)
      .useValue(store)
      .overrideProvider(AdminSettings)
      .useValue({ get: () => config })
      .overrideProvider(AdminStore)
      .useValue(adminStore)
      .overrideProvider(WardogsClient)
      .useValue(game)
      .overrideProvider(DiscordRolesStore)
      .useValue({})
      .overrideProvider(DiscordRolesDiscord)
      .useValue({ ready: () => false })
      .overrideProvider(PatreonSyncService)
      .useValue(sync)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  it("requires staff admin for all private ledger reads and supplies no-store headers", async () => {
    await request(app.getHttpServer()).get("/admin/api/supporters").expect(401);
    await request(app.getHttpServer()).get("/community/api/supporters").expect(404);
    expect(store.list).not.toHaveBeenCalled();
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["staff"] })));
    const result = await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["cdn-cache-control"]).toBe("no-store");
    expect(result.headers["vercel-cdn-cache-control"]).toBe("no-store");
  });
  it.each(["viewer", "moderator"])("rejects private ledger reads for %s", async (role) => {
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: [role] })));
    await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(403);
    expect(store.list).not.toHaveBeenCalled();
  });
  it("uses unchanged original JSON bytes for the signature, never browser cookies as webhook authority", async () => {
    const raw =
      JSON.stringify(
        {
          data: {
            id: "member-123",
            type: "member",
            attributes: { patron_status: "active_patron", email: "private@example.test" },
            relationships: { campaign: { data: { id: "123", type: "campaign" } } },
          },
        },
        null,
        2,
      ) + "\n";
    const signature = createHmac("md5", secret).update(raw).digest("hex");
    await request(app.getHttpServer())
      .post("/supporters/webhooks/patreon")
      .set("Content-Type", "application/json")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("X-Patreon-Event", "members:update")
      .send(raw)
      .expect(401);
    await request(app.getHttpServer())
      .post("/supporters/webhooks/patreon")
      .set("Content-Type", "application/json")
      .set("X-Patreon-Signature", signature)
      .set("X-Patreon-Event", "members:update")
      .send(raw)
      .expect(201);
    expect(store.ingest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.ingest.mock.calls)).not.toContain("private@example.test");
    await request(app.getHttpServer())
      .post("/supporters/webhooks/patreon")
      .set("Content-Type", "application/json")
      .set("X-Patreon-Signature", signature)
      .set("X-Patreon-Event", "members:update")
      .send(raw.trim())
      .expect(401);
  });
  describe("webhook rate limits", () => {
    const raw = JSON.stringify({
      data: {
        id: "member-123",
        type: "member",
        attributes: { patron_status: "active_patron" },
        relationships: { campaign: { data: { id: "123", type: "campaign" } } },
      },
    });
    const signature = createHmac("md5", secret).update(raw).digest("hex");
    const webhook = (sign?: string) => {
      const post = request(app.getHttpServer())
        .post("/supporters/webhooks/patreon")
        .set("Content-Type", "application/json")
        .set("X-Patreon-Event", "members:update");
      return (sign ? post.set("X-Patreon-Signature", sign) : post).send(raw);
    };
    it("keeps signed Patreon webhooks flowing while unsigned traffic is rate limited", async () => {
      for (let count = 0; count < 180; count++) await webhook().expect(401);
      await webhook().expect(429);
      // A well-formed but wrong signature still counts as unsigned.
      await webhook("0".repeat(32)).expect(429);
      await webhook(signature).expect(201);
      expect(store.ingest).toHaveBeenCalledTimes(1);
    });
    it("limits signed webhooks in their own bucket, leaving unsigned traffic its own allowance", async () => {
      for (let count = 0; count < 180; count++) await webhook(signature).expect(201);
      await webhook(signature).expect(429);
      expect(store.ingest).toHaveBeenCalledTimes(180);
      await webhook().expect(401);
    });
    it("never refuses signed webhooks because unsigned addresses filled the limiter", () => {
      let limit!: (req: Request, res: Response, next: NextFunction) => void;
      app.get(SupportersModule).configure({
        apply: (middleware: typeof limit) => {
          limit = middleware;
          return { forRoutes: () => undefined };
        },
      } as unknown as MiddlewareConsumer);
      const deliver = (remoteAddress: string, sign?: string) => {
        let status: number | "passed" = 0;
        const res = {} as Response;
        Object.assign(res, { set: () => res, json: () => res, status: (code: number) => ((status = code), res) });
        const req = {
          originalUrl: "/supporters/webhooks/patreon",
          socket: { remoteAddress },
          headers: sign ? { "x-patreon-signature": sign } : {},
          rawBody: Buffer.from(raw),
        };
        limit(req as unknown as Request, res, () => (status = "passed"));
        return status;
      };
      for (let index = 0; index < 5000; index++) expect(deliver(`2001:db8::${index.toString(16)}`)).toBe("passed");
      expect(deliver("2001:db8::ffff")).toBe(429);
      expect(deliver("2001:db8::ffff", signature)).toBe("passed");
    });
  });
  it("requires same-origin CSRF, fresh admin role, and explicit confirmation for manual linking", async () => {
    const endpoint = `/admin/api/supporters/${randomUUID()}/link`;
    const body = {
      id: randomUUID(),
      version: 1,
      discordId: "123456789012345678",
      steamId: "76561198000000001",
      reason: "Checked identity with supporter",
      confirm: "member-123",
    };
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", "https://other.example")
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["moderator"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    expect(store.mutate).not.toHaveBeenCalled();
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["staff"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(201);
    expect(store.mutate).toHaveBeenCalledTimes(1);
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("does not reveal database credentials or receipt data in failures", async () => {
    store.list.mockRejectedValueOnce(new Error("postgres://secret@private-db private receipt"));
    const result = await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(503);
    expect(result.text).not.toMatch(/postgres|secret|private-db|private receipt/);
  });
  it("authorizes and bounds search before reading all campaign records", async () => {
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: ["staff"] })));
    await request(app.getHttpServer()).get("/admin/api/supporters?search=old-member").expect(401);
    await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .query({ search: ["one", "two"] })
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(400);
    expect(store.list).not.toHaveBeenCalled();
    const result = await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .query({ search: "old%_member" })
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(store.list).toHaveBeenCalledWith("123", expect.any(Object), undefined, "old%_member", undefined);
    expect(result.body).toMatchObject({ search: "old%_member", limit: 100 });
  });
  it("returns the additive Patreon sync status with the private list", async () => {
    const result = await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(result.body).toMatchObject({
      configured: true,
      webhookConfigured: true,
      supporters: [],
      sync: { configured: true, running: false, members: 2, lastError: null },
    });
  });
  it("starts a Patreon sync only for a fresh admin with same-origin CSRF", async () => {
    const endpoint = "/admin/api/supporters/sync";
    await request(app.getHttpServer()).post(endpoint).expect(401);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", "https://other.example")
      .set("X-CSRF-Token", "csrf")
      .expect(403);
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["moderator"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .expect(403);
    expect(sync.staffSync).not.toHaveBeenCalled();
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: ["staff"] })));
    const result = await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .expect(201);
    expect(result.body).toEqual({ ok: true, joined: false, sync: { configured: true, running: false, members: 2 } });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(sync.staffSync).toHaveBeenCalledTimes(1);
    sync.configured.mockReturnValue(false);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .expect(503);
    expect(sync.staffSync).toHaveBeenCalledTimes(1);
    expect(store.mutate).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("requires admin, same-origin CSRF and campaign attestation for manual donor entry", async () => {
    const endpoint = "/admin/api/supporters/manual-member";
    const body = {
      id: randomUUID(),
      patreonMemberId: "member-123",
      campaignMembershipVerified: true,
      reason: "Checked this member on the UNC Patreon page",
    };
    await request(app.getHttpServer()).post(endpoint).send(body).expect(401);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", "https://other.example")
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["moderator"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    expect(store.register).not.toHaveBeenCalled();
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: ["staff"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send({ ...body, campaignMembershipVerified: false })
      .expect(400);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(201);
    expect(store.register).toHaveBeenCalledTimes(1);
    expect(store.register).toHaveBeenCalledWith(
      expect.objectContaining({ ...body, displayName: null }),
      expect.objectContaining({ role: "admin" }),
      "123",
      expect.any(Object),
    );
    expect(store.mutate).not.toHaveBeenCalled();
    expect(store.ingest).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("requires admin, same-origin CSRF and the payment check for PayPal entries, and explains founder refusals", async () => {
    const endpoint = "/admin/api/supporters/paypal";
    const body = {
      id: randomUUID(),
      displayName: "PayPal donor",
      discordId: "123456789012345678",
      paidAt: "2026-10-01T12:00:00-04:00",
      amountCents: 500,
      currency: "USD",
      transactionId: "8AB12345CD678901E",
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: true,
      awardFounder: true,
      reason: "Checked the completed PayPal payment",
    };
    await request(app.getHttpServer()).post(endpoint).send(body).expect(401);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", "https://other.example")
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: ["moderator"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    expect(store.recordPaypal).not.toHaveBeenCalled();
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: ["staff"] })));
    const send = (payload: object) =>
      request(app.getHttpServer())
        .post(endpoint)
        .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
        .set("Origin", config.origin)
        .set("X-CSRF-Token", "csrf")
        .send(payload);
    await send({ ...body, completedPaymentVerified: false }).expect(400);
    await send(body).expect(201);
    expect(store.recordPaypal).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: body.transactionId }),
      expect.objectContaining({ role: "admin" }),
      "123",
      expect.any(Object),
    );
    store.recordPaypal.mockRejectedValueOnce(
      new ConflictException({
        message: "This payment was not made inside the founder window. Nothing was recorded.",
        blockedReason: "outside_window",
      }),
    );
    const refused = await send({ ...body, id: randomUUID() }).expect(409);
    expect(refused.body).toEqual({
      message: "This payment was not made inside the founder window. Nothing was recorded.",
      blockedReason: "outside_window",
    });
    store.recordPaypal.mockRejectedValueOnce(new ServiceUnavailableException("Unavailable"));
    expect((await send({ ...body, id: randomUUID() }).expect(503)).body).toEqual({ message: "Unavailable" });
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("filters the ledger by provider", async () => {
    await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .query({ provider: "paypal" })
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(store.list).toHaveBeenCalledWith("123", expect.any(Object), undefined, "", "paypal");
    await request(app.getHttpServer())
      .get("/admin/api/supporters")
      .query({ provider: "venmo" })
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(400);
  });
});
