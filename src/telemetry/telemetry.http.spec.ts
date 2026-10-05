import { Global, Logger, Module, type INestApplication, type MiddlewareConsumer } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { hash } from "../admin/admin.auth";
import { legacyServerSettings } from "../admin/game-server-fixture";
import { TelemetryDeliveries } from "./telemetry.deliveries";
import { TelemModule } from "./telemetry.module";
import { TelemetryStore } from "./telemetry.store";
import { emptyTotals } from "./telemetry.types";
import { AppExceptionFilter } from "../common/filters/app-exception.filter";

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
    eventTypes: jest.fn(),
    serverStats: jest.fn(),
    rowExtras: jest.fn(),
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
    store.eventTypes.mockResolvedValue([]);
    store.serverStats.mockResolvedValue({
      groups: [],
      totals: { events: 0, deaths: 0, suicides: 0, falling: 0, players: 0 },
      longest: [],
      leaders: [],
    });
    store.rowExtras.mockResolvedValue({ weapons: [], streaks: [] });
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
    // Production registers this filter globally, so status assertions here go through it.
    const module = await Test.createTestingModule({
      imports: [TestEnvModule, TelemModule],
      providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
    })
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
  it("accepts a batch of other event types beside a badly named type and stores their counts", async () => {
    store.ingest.mockResolvedValueOnce({ inserted: 0, duplicates: 0, skipped: 2 });
    const result = await request(app.getHttpServer())
      .post("/api/ingest/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send({ ...batch(), events: [{ type: "playerSpawned" }, { type: "Round Ended" }] })
      .expect(201);
    expect(result.body).toEqual({ ok: true, inserted: 0, duplicates: 0, skipped: 2 });
    expect(store.ingest.mock.calls[0][0].types).toEqual([
      { type: "playerSpawned", count: 1, sample: { type: "playerSpawned" } },
    ]);
    await expect(staffCombat()).resolves.toMatchObject({
      lastBatch: { accepted: 0, invalid: 1, firstInvalid: "events.1.type (bad format)", types: 1 },
      lastRejected: null,
      rejectedCount: 0,
    });
  });
  it("keeps the game's deliveries flowing while traffic without the token is rate limited", async () => {
    for (let count = 0; count < 300; count++)
      await request(app.getHttpServer()).post("/api/ingest/servers/primary/events").send(batch()).expect(401);
    await request(app.getHttpServer()).post("/api/ingest/servers/primary/events").send(batch()).expect(429);
    await request(app.getHttpServer())
      .post("/api/ingest/servers/primary/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send(batch())
      .expect(201);
    expect(store.ingest).toHaveBeenCalledTimes(1);
    // The 300 refusals without the token neither replaced nor counted as the game's refusal.
    await expect(staffCombat()).resolves.toMatchObject({
      lastRejected: null,
      rejectedCount: 0,
      lastRejectedWithoutToken: { status: 429, reason: "rate limited" },
      rejectedWithoutTokenCount: 301,
    });
  });
  it("rate limits the game's own deliveries per server and records the refusal as the game's", async () => {
    for (let count = 0; count < 300; count++)
      await request(app.getHttpServer())
        .post("/api/ingest/events")
        .set("Authorization", `Bearer ${feedToken}`)
        .send(batch())
        .expect(201);
    await request(app.getHttpServer())
      .post("/api/ingest/servers/primary/events")
      .set("Authorization", `Bearer ${feedToken}`)
      .send(batch())
      .expect(429);
    expect(store.ingest).toHaveBeenCalledTimes(300);
    // Requests without the token still have their own allowance from the same address.
    await request(app.getHttpServer()).post("/api/ingest/servers/primary/events").send(batch()).expect(401);
    await expect(staffCombat()).resolves.toMatchObject({
      lastRejected: { status: 429, reason: "rate limited" },
      rejectedCount: 1,
      lastRejectedWithoutToken: { status: 401, reason: "missing credentials" },
      rejectedWithoutTokenCount: 1,
    });
  });
  it("never refuses the game's deliveries because addresses without the token filled the limiter", () => {
    let limit!: (req: Request, res: Response, next: NextFunction) => void;
    app.get(TelemModule).configure({
      apply: (middleware: typeof limit) => {
        limit = middleware;
        return { forRoutes: () => undefined };
      },
    } as unknown as MiddlewareConsumer);
    const deliver = (remoteAddress: string, authorization?: string) => {
      let status: number | "passed" = 0;
      const res = {} as Response;
      Object.assign(res, { set: () => res, json: () => res, status: (code: number) => ((status = code), res) });
      const req = { originalUrl: "/api/ingest/events", socket: { remoteAddress }, headers: { authorization } };
      limit(req as unknown as Request, res, () => (status = "passed"));
      return status;
    };
    for (let index = 0; index < 5000; index++) expect(deliver(`2001:db8::${index.toString(16)}`)).toBe("passed");
    expect(deliver("2001:db8::ffff")).toBe(429);
    expect(deliver("2001:db8::ffff", `Bearer ${feedToken}`)).toBe("passed");
  });
  it("keeps staff combat reads out of the public leaderboard's bucket", () => {
    const rejected = jest.spyOn(app.get(TelemetryDeliveries), "rejectedRequest");
    let limit!: (req: Request, res: Response, next: NextFunction) => void;
    app.get(TelemModule).configure({
      apply: (middleware: typeof limit) => {
        limit = middleware;
        return { forRoutes: () => undefined };
      },
    } as unknown as MiddlewareConsumer);
    const read = (originalUrl: string) => {
      let status: number | "passed" = 0;
      const res = {} as Response;
      Object.assign(res, { set: () => res, json: () => res, status: (code: number) => ((status = code), res) });
      const req = { originalUrl, socket: { remoteAddress: "10.0.0.1" }, headers: {} };
      limit(req as unknown as Request, res, () => (status = "passed"));
      return status;
    };
    // One proxy address: anonymous public reads use up their own allowance only.
    for (let count = 0; count < 300; count++) expect(read("/community/api/leaderboard")).toBe("passed");
    expect(read("/community/api/leaderboard")).toBe(429);
    expect(read("/admin/api/combat?period=week")).toBe("passed");
    expect(read("/admin/api/servers/primary/combat")).toBe("passed");
    for (let count = 2; count < 300; count++) read("/admin/api/combat");
    expect(read("/ADMIN/API/COMBAT")).toBe(429);
    // Read refusals are never filed as feed refusals.
    expect(rejected).not.toHaveBeenCalled();
  });
  it("shows staff the game event types received with their latest sample, never the public", async () => {
    const at = new Date("2026-10-04T18:00:00.000Z");
    const steamId = "76561198000000001";
    store.eventTypes.mockResolvedValue([
      { type: "killed", count: 40, firstReceivedAt: at, lastReceivedAt: at, sample: null },
      {
        type: "playerJoined",
        count: 7,
        firstReceivedAt: at,
        lastReceivedAt: at,
        sample: { type: "playerJoined", steamId, name: "<b>Player</b>" },
      },
    ]);
    const staff = await staffCombat();
    expect(staff.otherEvents).toEqual([
      { type: "killed", count: 40, firstReceivedAt: at.toISOString(), lastReceivedAt: at.toISOString(), sample: null },
      {
        type: "playerJoined",
        count: 7,
        firstReceivedAt: at.toISOString(),
        lastReceivedAt: at.toISOString(),
        sample: { type: "playerJoined", steamId, name: "<b>Player</b>" },
      },
    ]);
    expect(store.eventTypes).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), "primary");
    store.eventTypes.mockClear();
    for (const path of ["/community/api/leaderboard", "/community/api/servers/primary/leaderboard"]) {
      const publicView = await request(app.getHttpServer()).get(`${path}?period=week`).expect(200);
      expect(publicView.body).not.toHaveProperty("otherEvents");
      expect(publicView.body).not.toHaveProperty("events");
      expect(publicView.text).not.toMatch(/playerJoined|sample|<b>|7656119/);
    }
    await request(app.getHttpServer()).get("/community/api/events").expect(404);
    expect(store.eventTypes).not.toHaveBeenCalled();
    // Staff only: no session, no event types.
    await request(app.getHttpServer()).get("/admin/api/combat").expect(401);
    expect(store.eventTypes).not.toHaveBeenCalled();
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
  const ids = ["76561198000000001", "76561198000000002", "76561198000000003", "76561198000000004"];
  /** Storage rows that still carry SteamIDs, as the real store's do, including SteamID-like names. */
  function storeWithSteamIds() {
    store.snapshot.mockResolvedValue({
      leaderboard: [
        { steamId: ids[0], name: "Player", kills: 4, deaths: 1, headshotKills: 2, kd: 4 },
        { steamId: ids[1], name: ids[1], kills: 2, deaths: 2, headshotKills: 0, kd: 1 },
        { steamId: ids[2], name: `Tag ${ids[2]}`, kills: 1, deaths: 3, headshotKills: 0, kd: 0.33 },
        // Another player's SteamID inside a name: the own-ID check alone would let it through.
        { steamId: ids[3], name: `Clan ${ids[1]}`, kills: 0, deaths: 1, headshotKills: 0, kd: 0 },
      ],
      totals: { ...emptyTotals(), events: 7, kills: 7, deaths: 6, headshotKills: 2, players: 4 },
    });
    store.rowExtras.mockResolvedValue({
      weapons: [
        { steamId: ids[0], cause: "Id.Item.AK74M", kills: 3, longestCentimeters: 41_200 },
        { steamId: ids[1], cause: "76561198000000009", kills: 2, longestCentimeters: null },
      ],
      streaks: [{ steamId: ids[0], bestStreak: 3 }],
    });
    store.serverStats.mockResolvedValue({
      groups: [
        {
          set: 3,
          causeKey: "id.item.ak74m",
          cause: "Id.Item.AK74M",
          mapName: null,
          hour: null,
          kills: 3,
          headshotKills: 2,
          longestCentimeters: 41_200,
          melee: 0,
          roadkill: 0,
          vehicleExplosion: 0,
          penetration: 1,
          ricochet: 0,
        },
        {
          set: 5,
          causeKey: null,
          cause: null,
          mapName: "76561198000000008",
          hour: null,
          kills: 3,
          headshotKills: 2,
          longestCentimeters: null,
          melee: 0,
          roadkill: 0,
          vehicleExplosion: 0,
          penetration: 0,
          ricochet: 0,
        },
      ],
      totals: { events: 7, deaths: 6, suicides: 1, falling: 1, players: 3 },
      longest: [
        { steamId: ids[1], name: ids[1], cause: "ID.Item.AK74M", mapName: "Kavkazi", distanceCentimeters: 41_200 },
      ],
      leaders: [
        { tag: "penetration", steamId: ids[2], name: `Tag ${ids[2]}`, count: 1 },
        { tag: "falling", steamId: ids[0], name: "Player", count: 1 },
      ],
    });
  }
  it("serves public server stats on both routes without SteamIDs or 17-digit runs", async () => {
    storeWithSteamIds();
    for (const path of ["/community/api/stats", "/community/api/servers/primary/stats"]) {
      const result = await request(app.getHttpServer()).get(`${path}?period=week`).expect(200);
      expect(result.text).not.toMatch(/steamId|\d{17}/i);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.headers["cdn-cache-control"]).toBe("no-store");
      expect(result.body).toMatchObject({
        serverId: "primary",
        period: "week",
        totals: { events: 7, kills: 0, deaths: 6, headshotKills: 0, players: 3, suicides: 1 },
        weapons: [{ label: "AK-74M", kind: "firearm", kills: 3, headshotKills: 2, longestMeters: 412 }],
        maps: [],
        longestKills: [{ name: "Unnamed player", weapon: "AK-74M", meters: 412, map: "Bakurani" }],
        tagLeaders: { penetration: [{ name: "Unnamed player", count: 1 }], falling: [{ name: "Player", count: 1 }] },
      });
      expect(result.body.hours).toHaveLength(24);
    }
    // One recompute served both routes.
    expect(store.serverStats).toHaveBeenCalledTimes(1);
  });
  it("refuses a bad period or unknown server on the stats routes before reading storage", async () => {
    for (const path of ["/community/api/stats", "/community/api/servers/primary/stats"]) {
      const result = await request(app.getHttpServer()).get(`${path}?period=year`).expect(400);
      expect(result.body).toEqual({ message: "Choose day, week or month." });
    }
    await request(app.getHttpServer()).get("/community/api/servers/nope/stats?period=week").expect(404);
    await request(app.getHttpServer()).get("/community/api/stats/x").expect(404);
    expect(store.serverStats).not.toHaveBeenCalled();
  });
  it("counts stats reads in the public leaderboard's read bucket", async () => {
    for (let count = 0; count < 150; count++) {
      await request(app.getHttpServer()).get("/community/api/leaderboard").expect(200);
      await request(app.getHttpServer()).get("/community/api/stats").expect(200);
    }
    await request(app.getHttpServer()).get("/community/api/stats").expect(429);
    await request(app.getHttpServer()).get("/community/api/servers/primary/stats").expect(429);
  });
  it("returns a safe error when stats storage is unavailable", async () => {
    store.serverStats.mockRejectedValueOnce(new Error(`postgres://user:password@private-db ${ids[0]}`));
    const result = await request(app.getHttpServer()).get("/community/api/stats").expect(503);
    expect(result.text).not.toMatch(/postgres|password|private-db|7656119/);
  });
  it("never puts a steamId key or a 17-digit run in any public response, on any route or period", async () => {
    storeWithSteamIds();
    const paths = ["/community/api/servers"];
    for (const period of ["day", "week", "month"])
      for (const route of ["leaderboard", "stats"])
        paths.push(
          `/community/api/${route}?period=${period}`,
          `/community/api/servers/primary/${route}?period=${period}`,
        );
    const keys = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keys)
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)])
          : [];
    for (const path of paths) {
      const result = await request(app.getHttpServer()).get(path).expect(200);
      expect(keys(result.body).filter((key) => /steam/i.test(key))).toEqual([]);
      expect(result.text).not.toMatch(/\d{17}/);
      expect(result.text).not.toMatch(/\p{Nd}{17}/u);
    }
    // The extras are on the public rows, so the leaderboard path above did carry them.
    const board = await request(app.getHttpServer()).get("/community/api/leaderboard?period=week").expect(200);
    expect(board.body.leaderboard[0]).toEqual({
      name: "Player",
      kills: 4,
      deaths: 1,
      headshotKills: 2,
      kd: 4,
      topWeapon: "AK-74M",
      longestKillMeters: 412,
      bestStreak: 3,
    });
    expect(board.body.leaderboard.slice(1).map((row: { name: string }) => row.name)).toEqual([
      "Unnamed player",
      "Unnamed player",
      "Unnamed player",
    ]);
  });
});
