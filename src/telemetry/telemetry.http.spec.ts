import { Global, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { hash } from "../admin/admin.auth";
import { TelemModule } from "./telemetry.module";
import { TelemetryStore } from "./telemetry.store";
import { emptyTotals } from "./telemetry.types";

const feedToken = "dedicated-test-feed-token-".repeat(2);
const values: Record<string, unknown> = {
  WARDOGS_FEED_ENABLED: true,
  WARDOGS_FEED_TOKEN: feedToken,
  WARDOGS_RCON_PASSWORD: "separate",
};
@Global()
@Module({
  providers: [{ provide: EnvService, useValue: { get: (key: string) => values[key] } }],
  exports: [EnvService],
})
class TestEnvModule {}

describe("telemetry HTTP boundaries", () => {
  let app: INestApplication;
  const sessionToken = "c".repeat(64);
  const store = {
    ingest: jest.fn(),
    snapshot: jest.fn(),
    tracking: jest.fn(),
    events: jest.fn(),
  };
  const adminStore = { session: jest.fn() };
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
  const batch = () => ({
    serverId: randomUUID(),
    serverName: "The UNCs",
    events: [{ eventId: randomUUID(), type: "killed", eventTime: 5 }],
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    values.WARDOGS_FEED_ENABLED = true;
    store.ingest.mockResolvedValue({ inserted: 1, duplicates: 0, skipped: 0 });
    store.snapshot.mockResolvedValue({ leaderboard: [], totals: emptyTotals() });
    store.tracking.mockResolvedValue(null);
    store.events.mockResolvedValue([]);
    adminStore.session.mockImplementation(async (key) =>
      key === hash(sessionToken)
        ? {
            userId: "123456789012345678",
            displayName: "Viewer",
            csrf: "test",
            expiresAt: new Date(Date.now() + 60_000),
          }
        : undefined,
    );
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ roles: ["viewer"] })));
    const module = await Test.createTestingModule({ imports: [TestEnvModule, TelemModule] })
      .overrideProvider(TelemetryStore)
      .useValue(store)
      .overrideProvider(AdminSettings)
      .useValue({ get: () => config })
      .overrideProvider(AdminStore)
      .useValue(adminStore)
      .overrideProvider(WardogsClient)
      .useValue({})
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  it("allows only safe public summaries and protects all raw/player history", async () => {
    const result = await request(app.getHttpServer()).get("/community/api/leaderboard?period=day").expect(200);
    expect(result.body).toMatchObject({ feedStatus: "waiting", leaderboard: [] });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["cdn-cache-control"]).toBe("no-store");
    expect(result.headers["vercel-cdn-cache-control"]).toBe("no-store");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    await request(app.getHttpServer()).get("/community/api/events").expect(404);
    await request(app.getHttpServer()).get("/admin/api/combat").expect(401);
    await request(app.getHttpServer()).get("/admin/api/combat/players/76561198000000001").expect(401);
    expect(store.events).not.toHaveBeenCalled();
  });
  it("allows staff viewers to read combat history through the existing staff guard", async () => {
    await request(app.getHttpServer())
      .get("/admin/api/combat?period=month")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(store.events).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer())
      .get("/admin/api/combat/players/76561198000000001?period=day")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(store.events).toHaveBeenLastCalledWith(expect.any(Date), expect.any(Date), "76561198000000001");
  });
  it("requires the dedicated feed credential and validates before persisting", async () => {
    await request(app.getHttpServer()).post("/api/ingest/events").send(batch()).expect(401);
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", "Bearer separate")
      .send(batch())
      .expect(401);
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ invalid: true })
      .expect(400);
    expect(store.ingest).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send(batch())
      .expect(201);
    expect(store.ingest).toHaveBeenCalledTimes(1);
  });
  it("keeps feed deliveries independent of saturated public reads from the same proxy", async () => {
    for (let count = 0; count < 300; count++)
      await request(app.getHttpServer()).get("/community/api/leaderboard").expect(200);
    await request(app.getHttpServer()).get("/community/api/leaderboard").expect(429);
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send(batch())
      .expect(201);
    expect(store.ingest).toHaveBeenCalledTimes(1);
  });
  it("returns safe errors when the database is unavailable", async () => {
    store.snapshot.mockRejectedValueOnce(new Error("postgres://user:password@private-db applications.email"));
    const result = await request(app.getHttpServer()).get("/community/api/leaderboard").expect(503);
    expect(result.text).not.toMatch(/postgres|password|private-db|applications.email/);
    values.WARDOGS_FEED_ENABLED = false;
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send(batch())
      .expect(503);
    expect(store.ingest).not.toHaveBeenCalled();
  });
});
