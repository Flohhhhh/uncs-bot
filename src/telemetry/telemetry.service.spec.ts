import { randomUUID } from "node:crypto";
import type { EnvService } from "../env/env.service";
import { TelemetryService } from "./telemetry.service";
import type { TelemetryStore } from "./telemetry.store";
import { emptyTotals, periodMilliseconds } from "./telemetry.types";
import { fixtureServers } from "../admin/game-server-fixture";
import { GameServers } from "../admin/game-servers";
import { AdminSettings } from "../admin/admin.settings";

const token = "dedicated-feed-token-".repeat(3);
const steamId = "76561198000000001";
const now = new Date("2026-09-30T12:00:00.000Z");
function fixture(enabled = true, secret = token, rcon = "different-rcon-password") {
  const values: Record<string, unknown> = {
    WARDOGS_FEED_ENABLED: enabled,
    WARDOGS_FEED_TOKEN: secret,
    WARDOGS_RCON_PASSWORD: rcon,
  };
  const store = {
    ingest: jest.fn().mockResolvedValue({ inserted: 1, duplicates: 0, skipped: 0 }),
    snapshot: jest.fn().mockResolvedValue({ leaderboard: [], totals: emptyTotals() }),
    tracking: jest.fn().mockResolvedValue(null),
    events: jest.fn().mockResolvedValue([]),
  };
  const servers = fixtureServers({});
  servers.feedToken = () => (secret !== rcon ? secret : undefined);
  const service = new TelemetryService(
    store as unknown as TelemetryStore,
    { get: (key: string) => values[key] } as EnvService,
    servers,
  );
  const payload = {
    serverId: randomUUID(),
    serverName: "The UNCs",
    events: [{ eventId: randomUUID(), type: "killed", eventTime: 12.5, victimSteamId: steamId }],
  };
  return { service, store, payload };
}
describe("telemetry authorization and reporting", () => {
  it("binds feed authorization and snapshot caches to configured servers, never the payload UUID", async () => {
    const f = fixture();
    const values: Record<string, unknown> = {
      WARDOGS_FEED_ENABLED: true,
      WARDOGS_SERVERS: [
        { id: "east", name: "East", rconUrl: "https://east.example.test", password: "east-rcon", feedToken: token },
        {
          id: "event",
          name: "Events",
          rconUrl: "https://events.example.test",
          password: "event-rcon",
          feedToken: token + "-event",
        },
      ],
    };
    const env = { get: (key: string) => values[key] } as EnvService;
    const service = new TelemetryService(
      f.store as unknown as TelemetryStore,
      env,
      new GameServers(new AdminSettings(env)),
    );
    await expect(service.ingest(`Bearer ${token}`, f.payload)).rejects.toMatchObject({ status: 400 });
    await expect(service.ingest(`Bearer ${token}`, f.payload, "event")).rejects.toMatchObject({ status: 401 });
    expect(f.store.ingest).not.toHaveBeenCalled();
    await service.leaderboard("week", "east");
    await service.leaderboard("week", "event");
    await service.ingest(`Bearer ${token}`, f.payload, "east");
    expect(f.store.ingest).toHaveBeenCalledWith(expect.objectContaining({ serverId: f.payload.serverId }), now, "east");
    await service.leaderboard("week", "event");
    expect(f.store.snapshot).toHaveBeenCalledTimes(2);
    await service.leaderboard("week", "east");
    expect(f.store.snapshot).toHaveBeenCalledTimes(3);
    expect(f.store.snapshot.mock.calls.map((call) => call[3])).toEqual(["east", "event", "east"]);
  });
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  it("stays disconnected with no database reads when disabled", async () => {
    const { service, store, payload } = fixture(false);
    await expect(service.ingest(`Bearer ${token}`, payload)).rejects.toMatchObject({ status: 503 });
    await expect(service.combat()).resolves.toMatchObject({
      enabled: false,
      connected: false,
      feedStatus: "waiting",
      leaderboard: [],
      events: [],
    });
    await expect(service.player(steamId)).resolves.toMatchObject({ player: null, events: [] });
    for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "",
    "Basic abc",
    `Bearer ${token}extra`,
    `Bearer ${token}\n`,
    [token],
    "Bearer " + "x".repeat(513),
  ])("rejects incorrect bearer credentials before parsing or storage", async (authorization) => {
    const { service, store } = fixture();
    await expect(service.ingest(authorization, null)).rejects.toMatchObject({ status: 401 });
    expect(store.ingest).not.toHaveBeenCalled();
  });
  it("fails closed for a missing/short token or reused RCON password", async () => {
    for (const secret of ["", "short", "rcon-password-that-is-long-enough-1234"]) {
      const { service } = fixture(true, secret, "rcon-password-that-is-long-enough-1234");
      await expect(service.ingest(`Bearer ${secret}`, {})).rejects.toMatchObject({ status: 503 });
    }
  });
  it("records server receipt time and invalidates waiting summaries after a valid batch", async () => {
    const { service, store, payload } = fixture();
    await service.leaderboard();
    await service.leaderboard();
    expect(store.snapshot).toHaveBeenCalledTimes(1);
    await expect(service.ingest(`Bearer ${token}`, payload)).resolves.toEqual({
      ok: true,
      inserted: 1,
      duplicates: 0,
      skipped: 0,
    });
    expect(store.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: payload.serverId,
        events: [expect.objectContaining({ eventTime: 12.5, victimSteamId: steamId })],
      }),
      now,
      "primary",
    );
    store.tracking.mockResolvedValue({ firstReceivedAt: now, lastReceivedAt: now });
    await expect(service.leaderboard()).resolves.toMatchObject({
      connected: true,
      feedStatus: "receiving",
      lastReceivedAt: now.toISOString(),
    });
    expect(store.snapshot).toHaveBeenCalledTimes(2);
  });
  it.each(["day", "week", "month"] as const)("uses the exact rolling %s receipt-time window", async (period) => {
    const { service, store } = fixture();
    const result = await service.combat(period);
    const since = new Date(now.getTime() - periodMilliseconds[period]);
    expect(store.snapshot).toHaveBeenCalledWith(since, now, undefined, "primary");
    expect(store.events).toHaveBeenCalledWith(since, now, undefined, "primary");
    expect(result).toMatchObject({ period, windowStartedAt: since.toISOString(), asOf: now.toISOString() });
  });
  it("labels quiet history without claiming the game server is offline", async () => {
    const { service, store } = fixture();
    store.tracking.mockResolvedValue({
      firstReceivedAt: new Date(now.getTime() - 3_600_000),
      lastReceivedAt: new Date(now.getTime() - 60_001),
    });
    const result = await service.leaderboard("day");
    expect(result).toMatchObject({ connected: true, feedStatus: "quiet" });
    expect(result.coverageNote).toContain("no deaths occurred");
  });
  it("projects only public game stats and caps the leaderboard even if storage gains private fields", async () => {
    const { service, store } = fixture();
    const stats = { steamId, name: "Player", kills: 2, deaths: 0, headshotKills: 1, kd: null };
    store.snapshot.mockResolvedValue({
      leaderboard: Array.from({ length: 101 }, () => ({
        ...stats,
        email: "private@example.test",
        discordId: "private",
      })),
      totals: { ...emptyTotals(), secret: "private" },
      events: [{ secret: "private" }],
    });
    const result = await service.leaderboard();
    expect(result.leaderboard).toHaveLength(100);
    expect(result.leaderboard[0]).toEqual(stats);
    expect(JSON.stringify(result)).not.toMatch(/private|email|discordId|secret/);
    expect(result).not.toHaveProperty("events");
  });
  it("scopes player queries and rejects malformed periods and identities before querying", async () => {
    const { service, store } = fixture();
    await expect(service.leaderboard("year")).rejects.toMatchObject({ status: 400 });
    await expect(service.player("7656119' OR 1=1")).rejects.toMatchObject({ status: 400 });
    expect(store.snapshot).not.toHaveBeenCalled();
    await service.player(steamId, "week");
    expect(store.snapshot).toHaveBeenCalledWith(
      new Date(now.getTime() - periodMilliseconds.week),
      now,
      steamId,
      "primary",
    );
    expect(store.events).toHaveBeenCalledWith(
      new Date(now.getTime() - periodMilliseconds.week),
      now,
      steamId,
      "primary",
    );
  });
});
