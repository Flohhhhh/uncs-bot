import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EnvService } from "../env/env.service";
import { TelemetryDeliveries } from "./telemetry.deliveries";
import { TelemetryService, UNNAMED_PLAYER } from "./telemetry.service";
import type { TelemetryStore } from "./telemetry.store";
import { emptyTotals, periodMilliseconds } from "./telemetry.types";
import { fixtureServers } from "../admin/game-server-fixture";
import { GameServers } from "../admin/game-servers";
import { AdminSettings } from "../admin/admin.settings";

const token = "dedicated-feed-token-".repeat(3);
const steamId = "76561198000000001";
const now = new Date("2026-09-30T12:00:00.000Z");
const publicKeys = ["deaths", "headshotKills", "kd", "kills", "name"];
const deliveryKeys = [
  "lastBatch",
  "lastRejected",
  "rejectedCount",
  "lastRejectedWithoutToken",
  "rejectedWithoutTokenCount",
];
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
  const deliveries = new TelemetryDeliveries(servers);
  const service = new TelemetryService(
    store as unknown as TelemetryStore,
    { get: (key: string) => values[key] } as EnvService,
    servers,
    deliveries,
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
        {
          id: "east",
          name: "East",
          rconUrl: "https://east.example.test",
          password: "east-rcon",
          feedToken: token,
          joinId: "11111111-1111-4111-8111-111111111111",
        },
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
    const servers = new GameServers(new AdminSettings(env));
    const service = new TelemetryService(
      f.store as unknown as TelemetryStore,
      env,
      servers,
      new TelemetryDeliveries(servers),
    );
    expect(service.serversList()).toEqual([
      { id: "east", name: "East", joinId: "11111111-1111-4111-8111-111111111111" },
      { id: "event", name: "Events" },
    ]);
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
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
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
    expect(result.leaderboard[0]).toEqual({ name: "Player", kills: 2, deaths: 0, headshotKills: 1, kd: null });
    expect(JSON.stringify(result)).not.toMatch(/private|email|discordId|secret/);
    expect(result).not.toHaveProperty("events");
    const staff = await service.combat();
    expect(staff.leaderboard).toHaveLength(100);
    expect(staff.leaderboard[0]).toEqual(stats);
    expect(JSON.stringify(staff)).not.toMatch(/private|email|discordId|secret/);
  });
  it("never puts a SteamID in the public leaderboard while staff rankings keep them", async () => {
    const { service, store } = fixture();
    const unnamed = "76561198000000002",
      embedded = "76561198000000003",
      numeric = "76561198000000004";
    store.snapshot.mockResolvedValue({
      leaderboard: [
        { steamId, name: "Player", kills: 3, deaths: 1, headshotKills: 1, kd: 3 },
        // Storage uses the SteamID as the name when the game never sent one.
        { steamId: unnamed, name: unnamed, kills: 2, deaths: 1, headshotKills: 0, kd: 2 },
        { steamId: embedded, name: `Tag ${embedded}`, kills: 1, deaths: 1, headshotKills: 0, kd: 1 },
        { steamId: numeric, name: "76561198999999999", kills: 0, deaths: 1, headshotKills: 0, kd: 0 },
      ],
      totals: { ...emptyTotals(), players: 4 },
    });
    const result = await service.leaderboard("week");
    const json = JSON.stringify(result);
    for (const id of [steamId, unnamed, embedded, numeric, "76561198999999999"]) expect(json).not.toContain(id);
    expect(json).not.toMatch(/steamId|7656119\d{10}/i);
    expect(result.leaderboard).toEqual([
      { name: "Player", kills: 3, deaths: 1, headshotKills: 1, kd: 3 },
      { name: UNNAMED_PLAYER, kills: 2, deaths: 1, headshotKills: 0, kd: 2 },
      { name: UNNAMED_PLAYER, kills: 1, deaths: 1, headshotKills: 0, kd: 1 },
      { name: UNNAMED_PLAYER, kills: 0, deaths: 1, headshotKills: 0, kd: 0 },
    ]);
    for (const row of result.leaderboard) expect(Object.keys(row).sort()).toEqual(publicKeys);
    const staff = await service.combat("week");
    expect(staff.leaderboard.map((row) => row.steamId)).toEqual([steamId, unnamed, embedded, numeric]);
    expect(staff.leaderboard[1].name).toBe(unnamed);
    // Both views read the same 10-second snapshot.
    expect(store.snapshot).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_001);
    await service.leaderboard("week");
    expect(store.snapshot).toHaveBeenCalledTimes(2);
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
  it.each<{
    reason: string;
    status: number;
    withoutToken?: boolean;
    enabled?: boolean;
    secret?: string;
    authorization?: unknown;
    body?: (payload: ReturnType<typeof fixture>["payload"]) => unknown;
    storageFails?: boolean;
  }>([
    { reason: "feed disabled", status: 503, enabled: false },
    { reason: "feed token not configured", status: 503, secret: "short", withoutToken: true },
    { reason: "missing credentials", status: 401, authorization: undefined, withoutToken: true },
    { reason: "malformed credentials", status: 401, authorization: `Basic ${token}`, withoutToken: true },
    { reason: "token mismatch", status: 401, authorization: `Bearer ${"x".repeat(40)}`, withoutToken: true },
    { reason: "invalid payload: missing JSON body", status: 400, body: () => undefined },
    { reason: "invalid payload: batch (missing or wrong type)", status: 400, body: () => [token] },
    {
      reason: "invalid payload: serverId (bad format)",
      status: 400,
      body: (payload) => ({ ...payload, serverId: token }),
    },
    {
      reason: "invalid payload: serverId (missing or wrong type)",
      status: 400,
      body: ({ serverName, events }) => ({ serverName, events }),
    },
    {
      reason: "invalid payload: events (missing or wrong type)",
      status: 400,
      body: (payload) => ({ ...payload, events: { token } }),
    },
    {
      reason: "invalid payload: events (over the limit)",
      status: 400,
      body: (payload) => ({ ...payload, events: Array.from({ length: 201 }, () => payload.events[0]) }),
    },
    {
      reason: "invalid payload: serverName (over the limit)",
      status: 400,
      body: (payload) => ({ ...payload, serverName: token.repeat(4) }),
    },
    { reason: "too large", status: 400, body: (payload) => ({ ...payload, padding: token.repeat(2_000) }) },
    { reason: "storage unavailable", status: 503, storageFails: true },
  ])("records a refused delivery as $status $reason for staff only", async (test) => {
    const secret = test.secret ?? token;
    const { service, store, payload } = fixture(test.enabled ?? true, secret);
    if (test.storageFails) store.ingest.mockRejectedValueOnce(new Error(`postgres://user:${token}@private-db`));
    const authorization = "authorization" in test ? test.authorization : `Bearer ${secret}`;
    const rejected = service.ingest(authorization, test.body ? test.body(payload) : payload);
    if (test.storageFails) await expect(rejected).rejects.toThrow();
    else await expect(rejected).rejects.toMatchObject({ status: test.status });
    const staff = await service.combat();
    // A refusal is the game's own only when the request carried the server's feed token.
    const refusal = { at: now.toISOString(), status: test.status, reason: test.reason };
    expect(staff).toMatchObject(
      test.withoutToken
        ? { lastRejected: null, rejectedCount: 0, lastRejectedWithoutToken: refusal, rejectedWithoutTokenCount: 1 }
        : { lastRejected: refusal, rejectedCount: 1, lastRejectedWithoutToken: null, rejectedWithoutTokenCount: 0 },
    );
    // Only the time, status and category are kept: never the token, header, body or database text.
    const kept = test.withoutToken ? staff.lastRejectedWithoutToken : staff.lastRejected;
    expect(Object.keys(kept!).sort()).toEqual(["at", "reason", "status"]);
    expect(JSON.stringify(staff)).not.toMatch(new RegExp(`${token}|Bearer|Basic|postgres|private-db`));
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      test.withoutToken
        ? `Rejected a game feed request without the feed token for server primary: ${test.status} ${test.reason}.`
        : `Rejected a game feed delivery for server primary: ${test.status} ${test.reason}.`,
    );
    expect(staff.lastBatch).toBeNull();
    const publicView = await service.leaderboard();
    for (const key of deliveryKeys) expect(publicView).not.toHaveProperty(key);
  });
  it("counts refusals since start and keeps the latest one of each kind", async () => {
    const { service, payload } = fixture();
    await expect(service.combat()).resolves.toMatchObject({
      lastRejected: null,
      rejectedCount: 0,
      lastRejectedWithoutToken: null,
      rejectedWithoutTokenCount: 0,
    });
    await expect(service.ingest(undefined, payload)).rejects.toMatchObject({ status: 401 });
    jest.advanceTimersByTime(5_000);
    await expect(service.ingest(`Bearer ${token}`, { ...payload, serverId: "bad" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.ingest(`Bearer ${token}`, { ...payload, serverId: "worse" })).rejects.toMatchObject({
      status: 400,
    });
    await service.ingest(`Bearer ${token}`, payload);
    await expect(service.combat()).resolves.toMatchObject({
      lastRejected: {
        at: new Date(now.getTime() + 5_000).toISOString(),
        status: 400,
        reason: "invalid payload: serverId (bad format)",
      },
      rejectedCount: 2,
      lastRejectedWithoutToken: { at: now.toISOString(), status: 401, reason: "missing credentials" },
      rejectedWithoutTokenCount: 1,
    });
  });
  it("still logs and shows the game's storage failure after a refusal without the token", async () => {
    const { service, store, payload } = fixture();
    await expect(service.ingest(undefined, payload)).rejects.toMatchObject({ status: 401 });
    store.ingest.mockRejectedValueOnce(new Error("database error"));
    jest.advanceTimersByTime(1_000);
    await expect(service.ingest(`Bearer ${token}`, payload)).rejects.toThrow("database error");
    await expect(service.ingest(`Bearer ${"x".repeat(40)}`, payload)).rejects.toMatchObject({ status: 401 });
    await expect(service.combat()).resolves.toMatchObject({
      lastRejected: { at: new Date(now.getTime() + 1_000).toISOString(), status: 503, reason: "storage unavailable" },
      rejectedCount: 1,
      lastRejectedWithoutToken: { status: 401, reason: "token mismatch" },
      rejectedWithoutTokenCount: 2,
    });
    expect(jest.mocked(Logger.prototype.warn).mock.calls.map(([message]) => message)).toEqual([
      "Rejected a game feed request without the feed token for server primary: 401 missing credentials.",
      "Rejected a game feed delivery for server primary: 503 storage unavailable.",
      "Rejected a game feed request without the feed token for server primary: 401 token mismatch.",
    ]);
  });
  it("stores the valid events of a partly invalid batch and shows staff what was skipped", async () => {
    const { service, store, payload } = fixture();
    await expect(service.combat()).resolves.toMatchObject({ lastBatch: null });
    const good = payload.events[0];
    const rawId = "ABCDEF01-2345-0789-0BCD-EF0123456789";
    store.ingest.mockResolvedValueOnce({ inserted: 2, duplicates: 0, skipped: 4 });
    await expect(
      service.ingest(`Bearer ${token}`, {
        ...payload,
        events: [
          good,
          { ...good, eventId: rawId },
          { ...good, eventId: randomUUID(), eventTime: `${token}` },
          { eventId: randomUUID(), eventTime: 1 },
          null,
          { eventId: randomUUID(), type: "player-joined" },
        ],
      }),
    ).resolves.toEqual({ ok: true, inserted: 2, duplicates: 0, skipped: 4 });
    expect(store.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        skipped: 4,
        invalid: 3,
        events: [
          expect.objectContaining({ eventId: good.eventId }),
          expect.objectContaining({ eventId: rawId.toLowerCase() }),
        ],
      }),
      now,
      "primary",
    );
    const staff = await service.combat();
    expect(staff).toMatchObject({
      lastBatch: {
        at: now.toISOString(),
        accepted: 2,
        skipped: 4,
        invalid: 3,
        firstInvalid: "events.2.eventTime (missing or wrong type)",
      },
      lastRejected: null,
      rejectedCount: 0,
    });
    expect(JSON.stringify(staff)).not.toContain(token);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      "Accepted a game feed batch for server primary but skipped 3 invalid entries; first: events.2.eventTime (missing or wrong type).",
    );
    const publicView = await service.leaderboard();
    expect(publicView).not.toHaveProperty("lastBatch");
  });
  it("does not record a batch that storage failed to save", async () => {
    const { service, store, payload } = fixture();
    store.ingest.mockRejectedValueOnce(new Error("database error"));
    await expect(service.ingest(`Bearer ${token}`, payload)).rejects.toThrow();
    await expect(service.combat()).resolves.toMatchObject({
      lastBatch: null,
      lastRejected: { status: 503, reason: "storage unavailable" },
    });
  });
});
