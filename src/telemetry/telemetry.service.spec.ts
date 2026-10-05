import { BadRequestException, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EnvService } from "../env/env.service";
import { TelemetryDeliveries } from "./telemetry.deliveries";
import { TelemetryService, UNNAMED_PLAYER, publicListName, publicName } from "./telemetry.service";
import type { TelemetryStore } from "./telemetry.store";
import { emptyTotals, periodMilliseconds, type ServerStatsAggregate } from "./telemetry.types";
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
const emptyStatsAggregate = (): ServerStatsAggregate => ({
  groups: [],
  totals: { events: 0, deaths: 0, suicides: 0, falling: 0, players: 0 },
  longest: [],
  leaders: [],
});
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
    eventTypes: jest.fn().mockResolvedValue([]),
    serverStats: jest.fn().mockResolvedValue(emptyStatsAggregate()),
    rowExtras: jest.fn().mockResolvedValue({ weapons: [], streaks: [] }),
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
    await expect(service.ingest(`Bearer ${token}x`, f.payload)).rejects.toMatchObject({ status: 400 });
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
  it("delivers the game's unscoped route to the registry server whose feed token it carries", async () => {
    const f = fixture();
    const values: Record<string, unknown> = {
      WARDOGS_FEED_ENABLED: true,
      // Ignored once WARDOGS_SERVERS is set; primary's token lives in its registry entry.
      WARDOGS_FEED_TOKEN: `${token}-legacy`,
      WARDOGS_SERVERS: [
        { id: "primary", name: "Main", rconUrl: "https://main.example.test", password: "main-rcon", feedToken: token },
        { id: "event", name: "Events", rconUrl: "https://events.example.test", password: "event-rcon" },
        {
          id: "east",
          name: "East",
          rconUrl: "https://east.example.test",
          password: "east-rcon",
          feedToken: `${token}e`,
        },
      ],
    };
    const env = { get: (key: string) => values[key] } as EnvService;
    const servers = new GameServers(new AdminSettings(env));
    const deliveries = new TelemetryDeliveries(servers);
    const service = new TelemetryService(f.store as unknown as TelemetryStore, env, servers, deliveries);
    await service.ingest(`Bearer ${token}`, f.payload);
    await service.ingest(`Bearer ${token}e`, f.payload);
    expect(f.store.ingest.mock.calls.map((call) => call[2])).toEqual(["primary", "east"]);
    expect(deliveries.status("primary").lastBatch).toMatchObject({ accepted: 1 });
    expect(deliveries.status("east").lastBatch).toMatchObject({ accepted: 1 });
    // No exact match, including the ignored legacy token, is refused as before and filed under no server.
    for (const authorization of [undefined, "Bearer guess", `Bearer ${token}-legacy`, `Bearer ${token}ee`])
      await expect(service.ingest(authorization, f.payload)).rejects.toMatchObject({ status: 400 });
    // A matched delivery's own refusal is filed as that server's.
    await expect(service.ingest(`Bearer ${token}`, { ...f.payload, events: "bad" })).rejects.toMatchObject({
      status: 400,
    });
    expect(f.store.ingest).toHaveBeenCalledTimes(2);
    expect(deliveries.status("primary")).toMatchObject({ rejectedCount: 1, rejectedWithoutTokenCount: 0 });
    for (const id of ["event", "east"])
      expect(deliveries.status(id)).toMatchObject({ rejectedCount: 0, rejectedWithoutTokenCount: 0 });
  });
  it("keeps legacy single-server feed routing unchanged", async () => {
    const { service, store, payload } = fixture();
    const servers = fixtureServers({});
    servers.feedToken = () => token;
    const deliveries = new TelemetryDeliveries(servers);
    const legacy = new TelemetryService(
      store as unknown as TelemetryStore,
      { get: (key: string) => (key === "WARDOGS_FEED_ENABLED" ? true : undefined) } as EnvService,
      servers,
      deliveries,
    );
    await legacy.ingest(`Bearer ${token}`, payload);
    await service.ingest(`Bearer ${token}`, payload, "primary");
    expect(store.ingest.mock.calls.map((call) => call[2])).toEqual(["primary", "primary"]);
    // A wrong token on the unscoped route is still primary's refusal without the token, not "server not selected".
    await expect(legacy.ingest("Bearer guess", payload)).rejects.toMatchObject({ status: 401 });
    await expect(legacy.ingest(`Bearer ${token}`, payload, "other")).rejects.toMatchObject({ status: 404 });
    expect(deliveries.status("primary")).toMatchObject({
      lastBatch: { accepted: 1 },
      rejectedCount: 0,
      lastRejectedWithoutToken: { status: 401, reason: "token mismatch" },
      rejectedWithoutTokenCount: 1,
    });
    expect(deliveries.tokenServer("/api/ingest/events", `Bearer ${token}`)).toBe("primary");
    expect(deliveries.tokenServer("/api/ingest/events", "Bearer guess")).toBeNull();
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
    await expect(service.leaderboard()).resolves.toMatchObject({ enabled: false, leaderboard: [] });
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
      numeric = "76561198000000004",
      clan = "76561198000000005",
      script = "76561198000000006";
    // Another player's SteamID inside a name, and this player's own SteamID in Arabic-Indic digits.
    const clanName = "UNC|76561198000000009|";
    const scriptName = `Tag ${script.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit)))}`;
    store.snapshot.mockResolvedValue({
      leaderboard: [
        { steamId, name: "Player", kills: 3, deaths: 1, headshotKills: 1, kd: 3 },
        // Storage uses the SteamID as the name when the game never sent one.
        { steamId: unnamed, name: unnamed, kills: 2, deaths: 1, headshotKills: 0, kd: 2 },
        { steamId: embedded, name: `Tag ${embedded}`, kills: 1, deaths: 1, headshotKills: 0, kd: 1 },
        { steamId: numeric, name: "76561198999999999", kills: 0, deaths: 1, headshotKills: 0, kd: 0 },
        { steamId: clan, name: clanName, kills: 0, deaths: 2, headshotKills: 0, kd: 0 },
        { steamId: script, name: scriptName, kills: 0, deaths: 3, headshotKills: 0, kd: 0 },
      ],
      totals: { ...emptyTotals(), players: 6 },
    });
    const result = await service.leaderboard("week");
    const json = JSON.stringify(result);
    for (const id of [steamId, unnamed, embedded, numeric, clan, script, "76561198999999999", "76561198000000009"])
      expect(json).not.toContain(id);
    expect(json).not.toMatch(/steamId|7656119\d{10}/i);
    expect(json).not.toMatch(/\p{Nd}{17}/u);
    expect(result.leaderboard).toEqual([
      { name: "Player", kills: 3, deaths: 1, headshotKills: 1, kd: 3 },
      { name: UNNAMED_PLAYER, kills: 2, deaths: 1, headshotKills: 0, kd: 2 },
      { name: UNNAMED_PLAYER, kills: 1, deaths: 1, headshotKills: 0, kd: 1 },
      { name: UNNAMED_PLAYER, kills: 0, deaths: 1, headshotKills: 0, kd: 0 },
      { name: UNNAMED_PLAYER, kills: 0, deaths: 2, headshotKills: 0, kd: 0 },
      { name: UNNAMED_PLAYER, kills: 0, deaths: 3, headshotKills: 0, kd: 0 },
    ]);
    for (const row of result.leaderboard) expect(Object.keys(row).sort()).toEqual(publicKeys);
    const staff = await service.combat("week");
    expect(staff.leaderboard.map((row) => row.steamId)).toEqual([steamId, unnamed, embedded, numeric, clan, script]);
    expect(staff.leaderboard[1].name).toBe(unnamed);
    expect(staff.leaderboard[4].name).toBe(clanName);
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
  it("refuses a batch whose entries are all invalid instead of reporting the feed as receiving", async () => {
    const { service, store, payload } = fixture();
    const event = payload.events[0];
    const invalid = {
      ...payload,
      events: [1, 2, 3].map(() => ({ ...event, eventId: randomUUID(), eventTime: "12.5" })),
    };
    await expect(service.ingest(`Bearer ${token}`, invalid)).rejects.toMatchObject({ status: 400 });
    // The refusal names the malformed entry, not an earlier badly named type.
    await expect(
      service.ingest(`Bearer ${token}`, { ...payload, events: [{ type: "Round Ended" }, null] }),
    ).rejects.toMatchObject({ status: 400 });
    // Nothing reached storage, so receipt tracking did not advance.
    expect(store.ingest).not.toHaveBeenCalled();
    await expect(service.combat()).resolves.toMatchObject({
      connected: false,
      feedStatus: "waiting",
      lastBatch: null,
      lastRejected: { status: 400, reason: "invalid payload: events.1 (not an object)" },
      rejectedCount: 2,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      "Rejected a game feed delivery for server primary: 400 invalid payload: events.0.eventTime (missing or wrong type).",
    );
    // Batches with nothing invalid still count as deliveries, even with no killed event to store.
    store.ingest.mockResolvedValue({ inserted: 0, duplicates: 0, skipped: 1 });
    for (const events of [[], [{ eventId: randomUUID(), type: "player-joined" }]])
      await expect(service.ingest(`Bearer ${token}`, { ...payload, events })).resolves.toMatchObject({ ok: true });
    expect(store.ingest).toHaveBeenCalledTimes(2);
  });
  it("stores the event type counts of a batch with no killed event beside badly named or malformed entries", async () => {
    const { service, store, payload } = fixture();
    store.ingest.mockResolvedValue({ inserted: 0, duplicates: 0, skipped: 2 });
    await expect(
      service.ingest(`Bearer ${token}`, {
        ...payload,
        events: [{ type: "playerSpawned", steamId }, { type: "Round Ended" }],
      }),
    ).resolves.toEqual({ ok: true, inserted: 0, duplicates: 0, skipped: 2 });
    expect(store.ingest.mock.calls[0][0].types).toEqual([
      { type: "playerSpawned", count: 1, sample: { type: "playerSpawned", steamId } },
    ]);
    await expect(service.combat()).resolves.toMatchObject({
      lastBatch: { accepted: 0, skipped: 2, invalid: 1, firstInvalid: "events.1.type (bad format)", types: 1 },
      lastRejected: null,
      rejectedCount: 0,
    });
    // Badly named types alone were skipped, not refused, before names were checked; a valid type is
    // kept beside a malformed entry.
    for (const events of [[{ type: "Round Ended" }], [{ type: "playerSpawned" }, null]])
      await expect(service.ingest(`Bearer ${token}`, { ...payload, events })).resolves.toMatchObject({ ok: true });
    expect(store.ingest).toHaveBeenCalledTimes(3);
    await expect(service.combat()).resolves.toMatchObject({
      lastBatch: { accepted: 0, invalid: 1, firstInvalid: "events.1 (not an object)", types: 1 },
      rejectedCount: 0,
    });
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
  it("counts every event type for staff without changing the game's receipt", async () => {
    const { service, store, payload } = fixture();
    store.ingest.mockResolvedValueOnce({ inserted: 1, duplicates: 0, skipped: 3, typesOverLimit: 1 });
    await expect(
      service.ingest(`Bearer ${token}`, {
        ...payload,
        events: [
          ...payload.events,
          { type: "spawn", steamId },
          { type: "spawn", steamId, name: "Latest" },
          { type: "Secret.Type" },
        ],
      }),
    ).resolves.toEqual({ ok: true, inserted: 1, duplicates: 0, skipped: 3 });
    // One parsed batch reaches storage, which writes the per-type counts with the killed events.
    expect(store.ingest).toHaveBeenCalledTimes(1);
    expect(store.ingest.mock.calls[0][0].types).toEqual([
      { type: "killed", count: 1, sample: null },
      { type: "spawn", count: 2, sample: { type: "spawn", steamId, name: "Latest" } },
      { type: "Secret.Type", count: 1, sample: { type: "Secret.Type" } },
    ]);
    const staff = await service.combat();
    expect(staff.lastBatch).toEqual({
      at: now.toISOString(),
      accepted: 1,
      skipped: 3,
      invalid: 0,
      firstInvalid: null,
      types: 3,
      typesOverLimit: 1,
    });
    // The warning gives counts only, never the feed's type names or payload.
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      "Accepted a game feed batch for server primary but did not count 1 new event type: the daily limit of event types was reached.",
    );
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toMatch(/Secret|spawn|Latest/);
  });
  it("shows staff the event types received in the window, never the public leaderboard", async () => {
    const { service, store } = fixture();
    const otherEvents = [
      {
        type: "spawn",
        count: 12,
        firstReceivedAt: now,
        lastReceivedAt: now,
        sample: { type: "spawn", steamId, name: "Player" },
      },
    ];
    store.eventTypes.mockResolvedValue(otherEvents);
    const staff = await service.combat("day");
    const since = new Date(now.getTime() - periodMilliseconds.day);
    expect(store.eventTypes).toHaveBeenCalledWith(since, now, "primary");
    expect(staff.otherEvents).toEqual(otherEvents);
    store.eventTypes.mockClear();
    const publicView = await service.leaderboard("day");
    expect(publicView).not.toHaveProperty("otherEvents");
    expect(JSON.stringify(publicView)).not.toMatch(/spawn|sample/);
    expect(store.eventTypes).not.toHaveBeenCalled();
    // A player's history does not include them either.
    const player = await service.player(steamId, "day");
    expect(player).not.toHaveProperty("otherEvents");
    expect(store.eventTypes).not.toHaveBeenCalled();
  });
  it("still shows staff the combat view when event type counts cannot be read", async () => {
    const { service, store } = fixture();
    store.eventTypes.mockRejectedValueOnce(new Error('relation "game_feed_event_types" does not exist'));
    await expect(service.combat("day")).resolves.toMatchObject({ enabled: true, events: [], otherEvents: null });
    expect(store.events).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith("Could not read game event type counts for server primary.");
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toContain("relation");
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
  it("reports whether the feed is usable for the weekly board without a reason or token", () => {
    expect(fixture().service.feedAvailable("primary")).toBe(true);
    expect(fixture(false).service.feedAvailable("primary")).toBe(false);
    expect(fixture(true, "too-short-token").service.feedAvailable("primary")).toBe(false);
  });
  it("shares the public name rule with the weekly board unchanged", () => {
    expect(publicName(steamId, " Player ")).toBe(" Player ");
    expect(publicName(steamId, `Tag ${steamId}`)).toBe(UNNAMED_PLAYER);
    expect(publicName(null, "76561198000000009")).toBe(UNNAMED_PLAYER);
    expect(publicName(steamId, "   ")).toBe(UNNAMED_PLAYER);
    expect(publicName(steamId, 5)).toBe(UNNAMED_PLAYER);
    // The website's stricter rule (any 17-digit run) is applied by the Discord renderer, not here.
    expect(publicName(steamId, "x76561198000000009x")).toBe("x76561198000000009x");
    // Every public API name (leaderboard rows and stats lists) applies it on top.
    expect(publicListName(steamId, "x76561198000000009x")).toBe(UNNAMED_PLAYER);
    expect(publicListName(steamId, " Player ")).toBe("Player");
  });
});

describe("public server stats", () => {
  const [A, B, C, D, E] = ["01", "02", "03", "04", "05"].map((end) => `765611980000000${end}`);
  const contractKeys = [
    "asOf",
    "connected",
    "coverageNote",
    "enabled",
    "feedStatus",
    "hours",
    "lastReceivedAt",
    "longestKills",
    "maps",
    "period",
    "serverId",
    "tagLeaders",
    "tags",
    "totals",
    "trackingStartedAt",
    "weapons",
    "windowStartedAt",
  ];
  const tagCounts = { melee: 0, roadkill: 0, vehicleExplosion: 0, penetration: 0, ricochet: 0 };
  const group = (set: number, fields: Partial<ServerStatsAggregate["groups"][number]>) => ({
    ...tagCounts,
    set,
    causeKey: null,
    cause: null,
    mapName: null,
    hour: null,
    kills: 0,
    headshotKills: 0,
    longestCentimeters: null,
    ...fields,
  });
  const cause = (raw: string | null, kills: number, headshotKills = 0, longestCentimeters: number | null = null) =>
    group(3, { causeKey: raw?.toLowerCase() ?? null, cause: raw, kills, headshotKills, longestCentimeters });
  const aggregate = (): ServerStatsAggregate => ({
    groups: [
      cause("Id.Item.AK74M", 30, 9, 41_249),
      cause("ID.Item.AK74M", 12, 3, 52_000),
      cause("Id.Item.Mosin", 5, 2, 30_000),
      // Over the 2 km cap: counted, but its distance is left out.
      cause("ID.Item.MosinNagant", 4, 1, 250_000),
      cause("Vehicle.Variant.Air.Rotary.ROT_04.Default", 7),
      cause("Weapon.Rifle", 3, 1, 1_000),
      cause("76561198000000009", 2),
      cause(null, 4),
      group(5, { mapName: "Kavkazi", kills: 20 }),
      group(5, { mapName: "Bakurani", kills: 6 }),
      group(5, { mapName: "Europe", kills: 21 }),
      group(5, { mapName: "76561198000000005", kills: 3 }),
      group(5, { mapName: null, kills: 4 }),
      group(6, { hour: 0, kills: 10 }),
      group(6, { hour: 21, kills: 30 }),
      group(6, { hour: 23, kills: 14 }),
      group(7, { kills: 54, headshotKills: 16, melee: 6, roadkill: 1, vehicleExplosion: 2, penetration: 4 }),
    ],
    totals: { events: 60, deaths: 58, suicides: 2, falling: 3, players: 7 },
    longest: [
      { steamId: A, name: "OldManRiver", cause: "Id.Item.SR_04", mapName: "Europe", distanceCentimeters: 59_100 },
      // Storage falls back to the SteamID as the name.
      { steamId: B, name: B, cause: null, mapName: "Kavkazi", distanceCentimeters: 30_000 },
      { steamId: C, name: `Tag ${C}`, cause: "Weapon.Rifle", mapName: null, distanceCentimeters: 25_049 },
      {
        steamId: D,
        name: "x76561198999999999x",
        cause: "ID.Item.AK74M",
        mapName: "76561198000000005",
        distanceCentimeters: 20_000,
      },
      { steamId: A, name: "OldManRiver", cause: "Id.Item.M4", mapName: "Europe", distanceCentimeters: 10_000 },
      { steamId: E, name: "TooFar", cause: "Id.Item.M4", mapName: "Europe", distanceCentimeters: 250_000 },
    ],
    leaders: [
      { tag: "melee", steamId: A, name: "OldManRiver", count: 6 },
      { tag: "melee", steamId: B, name: null, count: 2 },
      { tag: "falling", steamId: C, name: `Tag ${C}`, count: 3 },
      { tag: "suicide", steamId: D, name: "Oops", count: 2 },
      { tag: "penetration", steamId: E, name: "Wallbanger", count: 0 },
    ],
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("builds the public stats from named, merged and capped aggregates only", async () => {
    const { service, store } = fixture();
    store.serverStats.mockResolvedValue(aggregate());
    store.tracking.mockResolvedValue({ firstReceivedAt: new Date(now.getTime() - 3_600_000), lastReceivedAt: now });
    const result = await service.stats("week");
    expect(store.serverStats).toHaveBeenCalledWith(new Date(now.getTime() - periodMilliseconds.week), now, "primary");
    expect(Object.keys(result).sort()).toEqual(contractKeys);
    expect(result).toMatchObject({
      serverId: "primary",
      enabled: true,
      connected: true,
      feedStatus: "receiving",
      period: "week",
      asOf: now.toISOString(),
    });
    expect(result.totals).toEqual({ events: 60, kills: 54, deaths: 58, headshotKills: 16, players: 7, suicides: 2 });
    expect(result.weapons).toEqual([
      // Id. and ID. rows are one weapon; so are two spellings of one name.
      { label: "AK-74M", kind: "firearm", kills: 42, headshotKills: 12, longestMeters: 520 },
      { label: "Mosin-Nagant", kind: "firearm", kills: 9, headshotKills: 3, longestMeters: 300 },
      { label: "ROT-04 helicopter", kind: "vehicle", kills: 7, headshotKills: 0, longestMeters: null },
      { label: "Unknown weapon", kind: "unknown", kills: 5, headshotKills: 1, longestMeters: 10 },
    ]);
    // Kavkazi is Bakurani's catalog ID; SteamID-like and missing map names are left out.
    expect(result.maps).toEqual([
      { label: "Bakurani", kills: 26 },
      { label: "Ozeti", kills: 21 },
    ]);
    expect(result.longestKills).toEqual([
      { name: "OldManRiver", weapon: "SR-04", meters: 591, map: "Ozeti" },
      { name: UNNAMED_PLAYER, weapon: null, meters: 300, map: "Bakurani" },
      { name: UNNAMED_PLAYER, weapon: "Unknown weapon", meters: 250, map: null },
      { name: UNNAMED_PLAYER, weapon: "AK-74M", meters: 200, map: null },
    ]);
    expect(result.hours).toHaveLength(24);
    expect([result.hours[0], result.hours[21], result.hours[23]]).toEqual([10, 30, 14]);
    expect(result.hours.reduce((total, kills) => total + kills, 0)).toBe(54);
    expect(result.tags).toEqual({
      melee: 6,
      roadkill: 1,
      vehicleExplosion: 2,
      penetration: 4,
      ricochet: 0,
      falling: 3,
      suicide: 2,
    });
    expect(result.tagLeaders).toEqual({
      melee: [
        { name: "OldManRiver", count: 6 },
        { name: UNNAMED_PLAYER, count: 2 },
      ],
      roadkill: [],
      vehicleExplosion: [],
      penetration: [],
      ricochet: [],
      falling: [{ name: UNNAMED_PLAYER, count: 3 }],
    });
    // Self-inflicted deaths are a count only, never a list of names.
    expect(result.tagLeaders).not.toHaveProperty("suicide");
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/steamId|\p{Nd}{17}/u);
    for (const id of [A, B, C, D, E]) expect(json).not.toContain(id);
    expect(json).not.toMatch(/Oops|Wallbanger|TooFar|Id\.Item|Weapon\.Rifle/);
  });

  it("keeps the top 25 weapons, ten long shots and five names per tag", async () => {
    const { service, store } = fixture();
    store.serverStats.mockResolvedValue({
      groups: Array.from({ length: 30 }, (_, index) => cause(`Id.Item.WEPN_${100 + index}`, 100 - index)),
      totals: { events: 0, deaths: 0, suicides: 0, falling: 0, players: 0 },
      longest: Array.from({ length: 15 }, (_, index) => ({
        steamId: String(76561198000000100n + BigInt(index)),
        name: `Shooter ${index}`,
        cause: null,
        mapName: null,
        distanceCentimeters: 50_000 - index * 100,
      })),
      leaders: Array.from({ length: 8 }, (_, index) => ({
        tag: "roadkill",
        steamId: String(76561198000000200n + BigInt(index)),
        name: `Driver ${index}`,
        count: 20 - index,
      })),
    });
    const result = await service.stats("month");
    expect(result.weapons).toHaveLength(25);
    expect(result.weapons[0]).toMatchObject({ label: "Weapon 100", kind: "firearm", kills: 100 });
    expect(result.weapons.at(-1)).toMatchObject({ label: "Weapon 124", kills: 76 });
    expect(result.longestKills).toHaveLength(10);
    expect(result.longestKills[0]).toEqual({ name: "Shooter 0", weapon: null, meters: 500, map: null });
    expect(result.tagLeaders.roadkill.map((row) => row.name)).toEqual([0, 1, 2, 3, 4].map((n) => `Driver ${n}`));
  });

  it("rejects a bad period or server before any store read", async () => {
    const { service, store } = fixture();
    for (const period of ["year", "", ["week"], "WEEK"])
      await expect(service.stats(period)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.stats("year")).rejects.toThrow("Choose day, week or month.");
    await expect(service.stats("week", "nope")).rejects.toMatchObject({ status: 404 });
    for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
    // No period means the 7-day view, as on the leaderboard.
    await expect(service.stats()).resolves.toMatchObject({ period: "week" });
  });

  it("serves the empty shape without reading storage while the feed is off", async () => {
    const { service, store } = fixture(false);
    const result = await service.stats("day");
    expect(Object.keys(result).sort()).toEqual(contractKeys);
    expect(result).toMatchObject({
      enabled: false,
      connected: false,
      feedStatus: "waiting",
      coverageNote: "Game event tracking is not enabled.",
      totals: { events: 0, kills: 0, deaths: 0, headshotKills: 0, players: 0, suicides: 0 },
      weapons: [],
      maps: [],
      longestKills: [],
      tags: { melee: 0, roadkill: 0, vehicleExplosion: 0, penetration: 0, ricochet: 0, falling: 0, suicide: 0 },
      tagLeaders: { melee: [], roadkill: [], vehicleExplosion: [], penetration: [], ricochet: [], falling: [] },
    });
    expect(result.hours).toEqual(Array.from({ length: 24 }, () => 0));
    for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
  });

  it("recomputes at most once a minute per server and period, whatever the traffic or feed batches", async () => {
    const { service, store, payload } = fixture();
    store.tracking.mockResolvedValue({ firstReceivedAt: now, lastReceivedAt: now });
    // Concurrent readers share one read.
    const [first, second] = await Promise.all([service.stats("week"), service.stats("week")]);
    expect(store.serverStats).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    jest.advanceTimersByTime(30_000);
    await service.ingest(`Bearer ${token}`, payload);
    // ingest() does not evict stats; numbers and feed status stay as of the cached read.
    await expect(service.stats("week")).resolves.toMatchObject({ asOf: now.toISOString(), feedStatus: "receiving" });
    expect(store.serverStats).toHaveBeenCalledTimes(1);
    await service.stats("day");
    expect(store.serverStats).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(29_999);
    await service.stats("week");
    expect(store.serverStats).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1_001);
    await expect(service.stats("week")).resolves.toMatchObject({
      asOf: new Date(now.getTime() + 61_000).toISOString(),
    });
    expect(store.serverStats).toHaveBeenCalledTimes(3);
  });

  it("evicts a failed recompute so the next reader tries again", async () => {
    const { service, store } = fixture();
    store.serverStats.mockRejectedValueOnce(new Error("postgres://user:secret@private-db"));
    await expect(service.stats("week")).rejects.toThrow();
    await expect(service.stats("week")).resolves.toMatchObject({ period: "week" });
    expect(store.serverStats).toHaveBeenCalledTimes(2);
  });
});

describe("leaderboard row extras", () => {
  const [A, B, C, D, E] = ["01", "02", "03", "04", "05"].map((end) => `765611980000000${end}`);
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("attaches each listed player's extras by SteamID without exposing it", async () => {
    const { service, store } = fixture();
    store.snapshot.mockResolvedValue({
      leaderboard: [
        { steamId: A, name: "UncDap", kills: 30, deaths: 10, headshotKills: 9, kd: 3 },
        { steamId: B, name: B, kills: 12, deaths: 12, headshotKills: 1, kd: 1 },
        { steamId: C, name: "Quiet", kills: 2, deaths: 9, headshotKills: 0, kd: 0.22 },
        { steamId: D, name: "Tied", kills: 2, deaths: 9, headshotKills: 0, kd: 0.22 },
      ],
      totals: { ...emptyTotals(), players: 4 },
    });
    store.rowExtras.mockResolvedValue({
      weapons: [
        { steamId: A, cause: "Id.Item.AK74M", kills: 10, longestCentimeters: 41_249 },
        { steamId: A, cause: "ID.Item.AK74M", kills: 5, longestCentimeters: null },
        { steamId: A, cause: "Id.Item.M4", kills: 12, longestCentimeters: 9_000 },
        { steamId: A, cause: null, kills: 3, longestCentimeters: 250_000 },
        // Only unnamed causes: no go-to weapon, but the distance still counts.
        { steamId: B, cause: "Weapon.Rifle", kills: 8, longestCentimeters: 30_000 },
        { steamId: B, cause: null, kills: 4, longestCentimeters: null },
        { steamId: D, cause: "Id.Item.SKS", kills: 1, longestCentimeters: null },
        { steamId: D, cause: "Id.Item.M4", kills: 1, longestCentimeters: null },
        // Not on the board: ignored.
        { steamId: E, cause: "Id.Item.SKS", kills: 9, longestCentimeters: 10_000 },
      ],
      streaks: [
        { steamId: A, bestStreak: 9 },
        { steamId: B, bestStreak: 0 },
        { steamId: D, bestStreak: 1 },
      ],
    });
    const result = await service.leaderboard("week");
    expect(store.rowExtras).toHaveBeenCalledWith(
      new Date(now.getTime() - periodMilliseconds.week),
      now,
      [A, B, C, D],
      "primary",
    );
    expect(result.leaderboard).toEqual([
      {
        name: "UncDap",
        kills: 30,
        deaths: 10,
        headshotKills: 9,
        kd: 3,
        topWeapon: "AK-74M",
        longestKillMeters: 412,
        bestStreak: 9,
      },
      { name: UNNAMED_PLAYER, kills: 12, deaths: 12, headshotKills: 1, kd: 1, longestKillMeters: 300 },
      { name: "Quiet", kills: 2, deaths: 9, headshotKills: 0, kd: 0.22 },
      // A tie goes to the alphabetically first label.
      { name: "Tied", kills: 2, deaths: 9, headshotKills: 0, kd: 0.22, topWeapon: "M4", bestStreak: 1 },
    ]);
    const allowed = [...publicKeys, "topWeapon", "longestKillMeters", "bestStreak"];
    for (const row of result.leaderboard) for (const key of Object.keys(row)) expect(allowed).toContain(key);
    expect(JSON.stringify(result)).not.toMatch(/steamId|\p{Nd}{17}/u);
    // Staff rankings are unchanged: SteamIDs, no extras.
    const staff = await service.combat("week");
    expect(Object.keys(staff.leaderboard[0]).sort()).toEqual([...publicKeys, "steamId"].sort());
  });

  it("serves the rows without extras when they cannot be read, and never fails the leaderboard", async () => {
    const { service, store } = fixture();
    store.snapshot.mockResolvedValue({
      leaderboard: [{ steamId: A, name: "UncDap", kills: 3, deaths: 1, headshotKills: 1, kd: 3 }],
      totals: emptyTotals(),
    });
    store.rowExtras.mockRejectedValueOnce(new Error(`postgres://user:secret@private-db ${A}`));
    const result = await service.leaderboard("week");
    expect(result.leaderboard).toEqual([{ name: "UncDap", kills: 3, deaths: 1, headshotKills: 1, kd: 3 }]);
    expect(Object.keys(result.leaderboard[0]).sort()).toEqual(publicKeys);
    expect(Logger.prototype.warn).toHaveBeenCalledWith("Leaderboard extras unavailable; serving rows without them.");
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toMatch(/7656119|postgres/);
    // The failure is not cached: the next read tries again.
    await service.leaderboard("week");
    expect(store.rowExtras).toHaveBeenCalledTimes(2);
  });

  it("keeps row extras for a minute even as feed batches refresh the rows", async () => {
    const { service, store, payload } = fixture();
    await service.leaderboard("week");
    await service.ingest(`Bearer ${token}`, payload);
    await service.leaderboard("week");
    expect(store.snapshot).toHaveBeenCalledTimes(2);
    expect(store.rowExtras).toHaveBeenCalledTimes(1);
    await service.leaderboard("day");
    expect(store.rowExtras).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(60_001);
    await service.leaderboard("week");
    expect(store.rowExtras).toHaveBeenCalledTimes(3);
  });
});
