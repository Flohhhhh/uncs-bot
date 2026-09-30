import { Global, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { hash } from "../admin/admin.auth";
import { SupportersModule } from "./supporters.module";
import { SupportersStore } from "./supporters.store";

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
  const store = { ingest: jest.fn(), list: jest.fn(), mutate: jest.fn() };
  const adminStore = { session: jest.fn() };
  const game = { execute: jest.fn() };
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
    adminStore.session.mockImplementation(async (key) =>
      key === hash(sessionToken)
        ? { userId: "123456789012345678", displayName: "Admin", csrf: "csrf", expiresAt: new Date(Date.now() + 60_000) }
        : undefined,
    );
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ roles: ["staff"] })));
    const module = await Test.createTestingModule({ imports: [TestEnvModule, SupportersModule] })
      .overrideProvider(SupportersStore)
      .useValue(store)
      .overrideProvider(AdminSettings)
      .useValue({ get: () => config })
      .overrideProvider(AdminStore)
      .useValue(adminStore)
      .overrideProvider(WardogsClient)
      .useValue(game)
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
});
