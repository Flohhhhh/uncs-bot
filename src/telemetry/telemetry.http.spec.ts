import { Global, Logger, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { hash } from "../admin/admin.auth";
import { legacyServerSettings } from "../admin/game-server-fixture";
import { TelemModule } from "./telemetry.module";
import { TelemetryStore } from "./telemetry.store";
import { emptyTotals } from "./telemetry.types";

const feedToken = "dedicated-test-feed-token-".repeat(2);
const deliveryKeys = [
  "lastBatch",
  "lastRejected",
  "rejectedCount",
  "lastRejectedWithoutToken",
  "rejectedWithoutTokenCount",
];
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
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    const module = await Test.createTestingModule({ imports: [TestEnvModule, TelemModule] })
      .overrideProvider(TelemetryStore)
      .useValue(store)
      .overrideProvider(AdminSettings)
      .useValue({ ...legacyServerSettings, feedToken: () => feedToken, get: () => config })
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
  it("serves public leaderboards without SteamIDs on both routes while staff keep them", async () => {
    const steamId = "76561198000000001",
      unnamed = "76561198000000002";
    store.snapshot.mockResolvedValue({
      leaderboard: [
        { steamId, name: "Player", kills: 2, deaths: 1, headshotKills: 1, kd: 2 },
        { steamId: unnamed, name: unnamed, kills: 1, deaths: 2, headshotKills: 0, kd: 0.5 },
      ],
      totals: { ...emptyTotals(), kills: 3, deaths: 3, players: 2 },
    });
    for (const path of ["/community/api/leaderboard", "/community/api/servers/primary/leaderboard"]) {
      const result = await request(app.getHttpServer()).get(`${path}?period=week`).expect(200);
      expect(result.text).not.toContain(steamId);
      expect(result.text).not.toContain(unnamed);
      expect(result.text).not.toMatch(/steamId/i);
      expect(result.body.leaderboard).toEqual([
        { name: "Player", kills: 2, deaths: 1, headshotKills: 1, kd: 2 },
        { name: "Unnamed player", kills: 1, deaths: 2, headshotKills: 0, kd: 0.5 },
      ]);
    }
    const staff = await request(app.getHttpServer())
      .get("/admin/api/combat?period=week")
      .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
      .expect(200);
    expect(staff.body.leaderboard.map((row: { steamId: string }) => row.steamId)).toEqual([steamId, unnamed]);
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
    expect(store.events).toHaveBeenLastCalledWith(expect.any(Date), expect.any(Date), "76561198000000001", "primary");
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
    // A batch with nothing storable and only malformed killed events is refused, not stored empty.
    const allInvalid = batch();
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ ...allInvalid, events: [{ ...allInvalid.events[0], eventTime: "5" }] })
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
  const staffCombat = async () =>
    (
      await request(app.getHttpServer())
        .get("/admin/api/combat")
        .set("Cookie", `__Host-uncs_admin_session=${sessionToken}`)
        .expect(200)
    ).body;
  it("shows staff, not the public, why a delivery that reached Gramps was refused", async () => {
    await expect(staffCombat()).resolves.toMatchObject({ lastRejected: null, rejectedCount: 0 });
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .set("Content-Type", "application/json")
      .send(`{"serverId":"${feedToken}",`)
      .expect(400);
    await expect(staffCombat()).resolves.toMatchObject({
      lastRejected: { status: 400, reason: "invalid JSON" },
      rejectedCount: 1,
    });
    await request(app.getHttpServer())
      .post("/api/ingest/servers/primary/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ ...batch(), padding: "x".repeat(150_000) })
      .expect(413);
    await expect(staffCombat()).resolves.toMatchObject({
      lastRejected: { status: 413, reason: "too large" },
      rejectedCount: 2,
    });
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ ...batch(), serverId: 12 })
      .expect(400);
    const staff = await staffCombat();
    expect(staff).toMatchObject({
      lastRejected: { status: 400, reason: "invalid payload: serverId (missing or wrong type)" },
      rejectedCount: 3,
    });
    for (const secret of [feedToken, "Bearer", "127.0.0.1", "::1"]) expect(JSON.stringify(staff)).not.toContain(secret);
    const publicView = await request(app.getHttpServer()).get("/community/api/leaderboard").expect(200);
    for (const key of deliveryKeys) expect(publicView.body).not.toHaveProperty(key);
    // A refused public read is not a feed delivery.
    await request(app.getHttpServer())
      .post("/community/api/leaderboard")
      .set("Content-Type", "application/json")
      .send("{")
      .expect(400);
    expect((await staffCombat()).rejectedCount).toBe(3);
  });
  it("files body-parser refusals without the feed token apart from the game's deliveries", async () => {
    await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ ...batch(), serverId: 12 })
      .expect(400);
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const junk = request(app.getHttpServer()).post("/api/ingest/events").set("Content-Type", "application/json");
      await (authorization ? junk.set("Authorization", authorization) : junk).send("{").expect(400);
    }
    await expect(staffCombat()).resolves.toMatchObject({
      lastRejected: { status: 400, reason: "invalid payload: serverId (missing or wrong type)" },
      rejectedCount: 1,
      lastRejectedWithoutToken: { status: 400, reason: "invalid JSON" },
      rejectedWithoutTokenCount: 2,
    });
  });
  it("accepts the valid events of a batch with one odd event and shows staff the skip", async () => {
    const value = batch();
    const odd = { ...value.events[0], eventId: "not-a-guid" };
    const nonRfc = { ...value.events[0], eventId: "ABCDEF01-2345-0789-0BCD-EF0123456789" };
    store.ingest.mockResolvedValueOnce({ inserted: 2, duplicates: 0, skipped: 1 });
    const result = await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ ...value, events: [value.events[0], odd, nonRfc] })
      .expect(201);
    expect(result.body).toEqual({ ok: true, inserted: 2, duplicates: 0, skipped: 1 });
    expect(store.ingest.mock.calls[0][0].events.map((event: { eventId: string }) => event.eventId)).toEqual([
      value.events[0].eventId,
      nonRfc.eventId.toLowerCase(),
    ]);
    await expect(staffCombat()).resolves.toMatchObject({
      lastBatch: { accepted: 2, skipped: 1, invalid: 1, firstInvalid: "events.1.eventId (bad format)" },
      lastRejected: null,
    });
    const publicView = await request(app.getHttpServer()).get("/community/api/leaderboard").expect(200);
    expect(publicView.body).not.toHaveProperty("lastBatch");
  });
  it("records rate-limited feed deliveries against the server they targeted", async () => {
    for (let count = 0; count < 300; count++)
      await request(app.getHttpServer()).post("/api/ingest/servers/primary/events").send(batch()).expect(401);
    await request(app.getHttpServer())
      .post("/api/ingest/servers/primary/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send(batch())
      .expect(429);
    await request(app.getHttpServer()).post("/api/ingest/servers/primary/events").send(batch()).expect(429);
    expect(store.ingest).not.toHaveBeenCalled();
    // The 300 refusals without the token neither replaced nor counted as the game's refusal.
    await expect(staffCombat()).resolves.toMatchObject({
      lastRejected: { status: 429, reason: "rate limited" },
      rejectedCount: 1,
      lastRejectedWithoutToken: { status: 429, reason: "rate limited" },
      rejectedWithoutTokenCount: 301,
    });
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
