import { Global, Logger, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { hash } from "../admin/admin.auth";
import { legacyServerSettings } from "../admin/game-server-fixture";
import { WardogsClient } from "../admin/wardogs.client";
import { EnvService } from "../env/env.service";
import { TelemetryStore } from "../telemetry/telemetry.store";
import { FIXTURE_IDS, FIXTURE_SLOT, fixtureAggregate, fixtureHighlights, fixtureRows } from "./weekly-fixtures";
import { WeeklyLeaderboardDiscord } from "./weekly-leaderboard.discord";
import { ADMIN_ONLY_MESSAGE } from "./weekly-leaderboard.service";
import { WeeklyLeaderboardModule } from "./weekly-leaderboard.module";

const values: Record<string, unknown> = {
  WARDOGS_FEED_ENABLED: true,
  WARDOGS_RCON_PASSWORD: "separate",
  ADMIN_GUILD_ID: "200000000000000001",
  WEEKLY_LEADERBOARD_ENABLED: true,
  WEEKLY_LEADERBOARD_CHANNEL_ID: "100000000000000001",
  WEEKLY_LEADERBOARD_DAY: "sunday",
  WEEKLY_LEADERBOARD_TIME: "20:00",
  WEEKLY_LEADERBOARD_MIN_KILLS: 100,
  WEEKLY_LEADERBOARD_MIN_PLAYERS: 10,
};
@Global()
@Module({
  providers: [{ provide: EnvService, useValue: { get: (key: string) => values[key] } }],
  exports: [EnvService],
})
class TestEnvModule {}

describe("weekly board HTTP boundaries", () => {
  let app: INestApplication;
  let roles: string[];
  const sessionToken = "c".repeat(64);
  const version = "0".repeat(64);
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
  const store = {
    tracking: jest.fn(),
    snapshot: jest.fn(),
    weeklyHighlights: jest.fn(),
    ingest: jest.fn(),
    events: jest.fn(),
  };
  const discord = { channel: jest.fn(), posted: jest.fn(), send: jest.fn() };
  const adminStore = { session: jest.fn() };
  const cookie = `__Host-uncs_admin_session=${sessionToken}`;
  const get = (path: string) => request(app.getHttpServer()).get(path).set("Cookie", cookie);
  const post = (path: string, body: object, csrf: string | null = "test") => {
    const req = request(app.getHttpServer())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", config.origin)
      .set("X-UNCs-Server-Version", version);
    if (csrf !== null) req.set("X-CSRF-Token", csrf);
    return req.send(body);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({
      now: Date.parse("2026-10-06T12:00:00Z"),
      // Only the clock is fixed; HTTP handling keeps real timers.
      doNotFake: [
        "nextTick",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "hrtime",
        "performance",
      ],
    });
    roles = ["viewer"];
    store.tracking.mockResolvedValue({
      firstReceivedAt: new Date(FIXTURE_SLOT - 20 * 86_400_000),
      lastReceivedAt: new Date(FIXTURE_SLOT - 3_600_000),
    });
    store.snapshot.mockResolvedValue(fixtureAggregate());
    store.weeklyHighlights.mockResolvedValue(fixtureHighlights());
    discord.channel.mockResolvedValue({});
    discord.posted.mockResolvedValue(false);
    discord.send.mockResolvedValue({ outcome: "posted", messageId: "1300000000000000001" });
    adminStore.session.mockImplementation(async (key) =>
      key === hash(sessionToken)
        ? {
            userId: "123456789012345678",
            displayName: "Staff",
            csrf: "test",
            expiresAt: new Date(Date.now() + 60_000),
          }
        : undefined,
    );
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ roles })));
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    const module = await Test.createTestingModule({ imports: [TestEnvModule, WeeklyLeaderboardModule] })
      .overrideProvider(TelemetryStore)
      .useValue(store)
      .overrideProvider(WeeklyLeaderboardDiscord)
      .useValue(discord)
      .overrideProvider(AdminSettings)
      .useValue({ ...legacyServerSettings, feedToken: () => "dedicated-test-feed-token-".repeat(2), get: () => config })
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
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("requires a staff session", async () => {
    await request(app.getHttpServer()).get("/admin/api/weekly-leaderboard").expect(401);
    await request(app.getHttpServer()).get("/admin/api/servers/primary/weekly-leaderboard/preview").expect(401);
    expect(store.snapshot).not.toHaveBeenCalled();
  });

  it("lets a viewer read the status but not preview or post", async () => {
    for (const path of ["/admin/api/weekly-leaderboard", "/admin/api/servers/primary/weekly-leaderboard"]) {
      const status = await get(path).expect(200);
      expect(status.body).toMatchObject({
        enabled: true,
        configured: true,
        feedConfigured: true,
        schedule: { timeZone: "America/New_York", nextPostAt: "2026-10-12T00:00:00.000Z", catchUpHours: 6 },
        thresholds: { minKills: 100, minPlayers: 10, minRankedPlayers: 5 },
        lastRun: null,
      });
      expect(status.text).not.toMatch(/\d{17}/);
    }
    const preview = await get("/admin/api/servers/primary/weekly-leaderboard/preview").expect(403);
    expect(preview.body).toEqual({ message: ADMIN_ONLY_MESSAGE });
    const posted = await post("/admin/api/servers/primary/weekly-leaderboard/post", {
      weekKey: "2026-W40",
      previewHash: "0".repeat(64),
      confirm: true,
    }).expect(403);
    expect(posted.body).toEqual({ message: ADMIN_ONLY_MESSAGE });
    expect(store.snapshot).not.toHaveBeenCalled();
    expect(discord.send).not.toHaveBeenCalled();
  });

  it("refuses a post without the dashboard's CSRF token before reaching the service", async () => {
    roles = ["staff"];
    for (const csrf of [null, "wrong"])
      await post("/admin/api/servers/primary/weekly-leaderboard/post", { confirm: true }, csrf).expect(403);
    expect(store.snapshot).not.toHaveBeenCalled();
    expect(discord.send).not.toHaveBeenCalled();
  });

  it("lets an administrator preview and then post exactly that preview", async () => {
    roles = ["staff"];
    const preview = await get("/admin/api/servers/primary/weekly-leaderboard/preview?week=last").expect(200);
    expect(preview.body).toMatchObject({ weekKey: "2026-W40", postable: true, eligible: true, alreadyPosted: false });
    expect(preview.text).not.toMatch(/\d{17}/);
    for (const id of FIXTURE_IDS) expect(preview.text).not.toContain(id);
    expect(preview.body.content).toContain(fixtureRows()[0].name);
    expect(discord.send).not.toHaveBeenCalled();
    await get("/admin/api/servers/primary/weekly-leaderboard/preview?week=year").expect(400);
    const body = { weekKey: preview.body.weekKey, previewHash: preview.body.previewHash, confirm: true };
    await post("/admin/api/servers/primary/weekly-leaderboard/post", { ...body, confirm: false }).expect(400);
    const result = await post("/admin/api/servers/primary/weekly-leaderboard/post", body).expect(201);
    expect(result.body).toEqual({ outcome: "posted", messageId: "1300000000000000001", weekKey: "2026-W40" });
    expect(discord.send).toHaveBeenCalledTimes(1);
    await post("/admin/api/servers/primary/weekly-leaderboard/post", body).expect(409);
    const status = await get("/admin/api/weekly-leaderboard").expect(200);
    expect(status.body.lastRun).toMatchObject({
      trigger: "staff",
      outcome: "posted",
      messageId: "1300000000000000001",
    });
  });
});
