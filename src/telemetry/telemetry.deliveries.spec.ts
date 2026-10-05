import { Logger } from "@nestjs/common";
import type { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { fixtureServers } from "../admin/game-server-fixture";
import { GameServers } from "../admin/game-servers";
import { FEED_WARNING_INTERVAL_MS, TelemetryDeliveries } from "./telemetry.deliveries";

const now = new Date("2026-10-02T12:00:00.000Z");
const token = "dedicated-feed-token-".repeat(3);
const clean = {
  lastBatch: null,
  lastRejected: null,
  rejectedCount: 0,
  lastRejectedWithoutToken: null,
  rejectedWithoutTokenCount: 0,
};
function multiServer() {
  const values: Record<string, unknown> = {
    WARDOGS_SERVERS: [
      { id: "east", name: "East", rconUrl: "https://east.example.test", password: "east-rcon" },
      { id: "event", name: "Events", rconUrl: "https://events.example.test", password: "event-rcon" },
    ],
  };
  const env = { get: (key: string) => values[key] } as EnvService;
  return new TelemetryDeliveries(new GameServers(new AdminSettings(env)));
}
function tokenedRegistry(eventToken = `${token}-event`) {
  const values: Record<string, unknown> = {
    WARDOGS_FEED_TOKEN: `${token}-legacy`,
    WARDOGS_SERVERS: [
      { id: "primary", name: "Main", rconUrl: "https://main.example.test", password: "main-rcon", feedToken: token },
      {
        id: "event",
        name: "Events",
        rconUrl: "https://events.example.test",
        password: "event-rcon",
        feedToken: eventToken,
      },
      { id: "east", name: "East", rconUrl: "https://east.example.test", password: "east-rcon" },
    ],
  };
  const env = { get: (key: string) => values[key] } as EnvService;
  return new TelemetryDeliveries(new GameServers(new AdminSettings(env)));
}
describe("refused feed delivery record", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it("keeps the latest refusal and a running count per configured server", () => {
    const deliveries = multiServer();
    expect(deliveries.status("east")).toEqual(clean);
    deliveries.rejected("east", 503, "feed disabled", true);
    jest.advanceTimersByTime(1_000);
    deliveries.rejected("east", 400, "invalid payload: serverId (bad format)", true);
    expect(deliveries.status("east")).toEqual({
      ...clean,
      lastRejected: {
        at: new Date(now.getTime() + 1_000).toISOString(),
        status: 400,
        reason: "invalid payload: serverId (bad format)",
      },
      rejectedCount: 2,
    });
    expect(deliveries.status("event")).toEqual(clean);
  });
  it("keeps refusals without the feed token apart, so they cannot replace or silence the game's", () => {
    const deliveries = new TelemetryDeliveries(fixtureServers({}));
    deliveries.rejectedRequest("/api/ingest/events", 401, "missing credentials", undefined);
    deliveries.rejected("primary", 503, "storage unavailable", true);
    jest.advanceTimersByTime(1_000);
    deliveries.rejected("primary", 401, "token mismatch", false);
    deliveries.rejectedRequest("/api/ingest/events", 400, "invalid JSON", "Bearer guess");
    expect(deliveries.status("primary")).toEqual({
      ...clean,
      lastRejected: { at: now.toISOString(), status: 503, reason: "storage unavailable" },
      rejectedCount: 1,
      lastRejectedWithoutToken: {
        at: new Date(now.getTime() + 1_000).toISOString(),
        status: 400,
        reason: "invalid JSON",
      },
      rejectedWithoutTokenCount: 3,
    });
    // Each kind has its own warning window, so earlier noise cannot suppress the storage failure.
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Rejected a game feed request without the feed token for server primary: 401 missing credentials.",
      "Rejected a game feed delivery for server primary: 503 storage unavailable.",
      "Rejected a game feed request without the feed token for server primary: 401 token mismatch.",
      "Rejected a game feed request without the feed token for server primary: 400 invalid JSON.",
    ]);
  });
  it("logs unconfigured server routes without storing them or echoing the requested ID", () => {
    const deliveries = multiServer();
    deliveries.rejected("attacker\nforged-line", 404, "unknown server", false);
    deliveries.rejected("attacker\nother-line", 404, "unknown server", false);
    deliveries.rejected(undefined, 400, "server not selected", false);
    for (const id of ["east", "event", "attacker\nforged-line"]) expect(deliveries.status(id)).toEqual(clean);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Rejected a game feed delivery for an unconfigured server route: 404 unknown server.",
      "Rejected a game feed delivery for an unconfigured server route: 400 server not selected.",
    ]);
  });
  it.each([
    ["/api/ingest/events", "primary"],
    ["/api/ingest/events?retry=1", "primary"],
    ["/API/Ingest/Events/", "primary"],
    ["/api/ingest/servers/primary/events", "primary"],
  ])("attributes refusals made before the controller for %s by the feed token they carry", (url, serverId) => {
    const servers = fixtureServers({});
    servers.feedToken = () => token;
    const deliveries = new TelemetryDeliveries(servers);
    expect(deliveries.rejectedRequest(url, 429, "rate limited", `Bearer ${token}`)).toBe(true);
    expect(deliveries.rejectedRequest(url, 413, "too large", `Bearer ${token}x`)).toBe(true);
    expect(deliveries.status(serverId)).toMatchObject({
      lastRejected: { status: 429, reason: "rate limited" },
      rejectedCount: 1,
      lastRejectedWithoutToken: { status: 413, reason: "too large" },
      rejectedWithoutTokenCount: 1,
    });
  });
  it("never files a request as the game's when no usable feed token is configured", () => {
    const servers = fixtureServers({});
    for (const configured of [undefined, "short"]) {
      servers.feedToken = () => configured;
      const deliveries = new TelemetryDeliveries(servers);
      deliveries.rejectedRequest("/api/ingest/events", 429, "rate limited", `Bearer ${configured}`);
      expect(deliveries.status("primary")).toMatchObject({ rejectedCount: 0, rejectedWithoutTokenCount: 1 });
    }
    // A settings lookup that fails while recording a refusal must not throw from the error hook.
    servers.feedToken = () => {
      throw new Error("settings unavailable");
    };
    const deliveries = new TelemetryDeliveries(servers);
    expect(deliveries.rejectedRequest("/api/ingest/events", 429, "rate limited", `Bearer ${token}`)).toBe(true);
    expect(deliveries.status("primary").rejectedWithoutTokenCount).toBe(1);
  });
  it("ignores other routes and never attributes unknown or undecodable server routes", () => {
    const deliveries = new TelemetryDeliveries(fixtureServers({}));
    for (const url of ["/community/api/leaderboard", "/admin/api/combat", "/api/ingest/events/extra", "/api/other"])
      expect(deliveries.rejectedRequest(url, 429, "rate limited", undefined)).toBe(false);
    expect(deliveries.rejectedRequest("/api/ingest/servers/%FF/events", 400, "unreadable request", undefined)).toBe(
      true,
    );
    expect(deliveries.rejectedRequest("/api/ingest/servers/other/events", 413, "too large", undefined)).toBe(true);
    expect(deliveries.status("primary")).toEqual(clean);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it("names the targeted server only for requests carrying that server's feed token, recording nothing", () => {
    const servers = fixtureServers({});
    servers.feedToken = () => token;
    const deliveries = new TelemetryDeliveries(servers);
    for (const url of ["/api/ingest/events", "/API/Ingest/servers/primary/events?retry=1"])
      expect(deliveries.tokenServer(url, `Bearer ${token}`)).toBe("primary");
    const refused: [string, string | undefined][] = [
      ["/api/ingest/events", undefined],
      ["/api/ingest/events", `Bearer ${token}x`],
      ["/api/ingest/servers/other/events", `Bearer ${token}`],
      ["/api/ingest/servers/%FF/events", `Bearer ${token}`],
      ["/api/ingest/events/extra", `Bearer ${token}`],
    ];
    for (const [url, authorization] of refused) expect(deliveries.tokenServer(url, authorization)).toBeNull();
    expect(deliveries.status("primary")).toEqual(clean);
    expect(warn).not.toHaveBeenCalled();
  });
  it("routes the unscoped ingest URL to the one registry server whose feed token it carries", () => {
    const deliveries = tokenedRegistry();
    expect(deliveries.tokenServer("/api/ingest/events", `Bearer ${token}`)).toBe("primary");
    expect(deliveries.tokenServer("/API/Ingest/Events?retry=1", `Bearer ${token}-event`)).toBe("event");
    for (const authorization of [undefined, "Bearer guess", `Bearer ${token}-legacy`])
      expect(deliveries.tokenServer("/api/ingest/events", authorization)).toBeNull();
    expect(deliveries.rejectedRequest("/api/ingest/events", 413, "too large", `Bearer ${token}-event`)).toBe(true);
    expect(deliveries.rejectedRequest("/api/ingest/events", 400, "invalid JSON", "Bearer guess")).toBe(true);
    expect(deliveries.status("event")).toMatchObject({
      lastRejected: { status: 413, reason: "too large" },
      rejectedCount: 1,
      rejectedWithoutTokenCount: 0,
    });
    for (const id of ["primary", "east"]) expect(deliveries.status(id)).toEqual(clean);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Rejected a game feed delivery for server event: 413 too large.",
      "Rejected a game feed delivery for an unconfigured server route: 400 invalid JSON.",
    ]);
  });
  it("routes no unscoped request when two registry entries would match", () => {
    // Env validation keeps feed tokens unique; a single exact match is still required here.
    const deliveries = tokenedRegistry(token);
    expect(deliveries.tokenServer("/api/ingest/events", `Bearer ${token}`)).toBeNull();
    expect(deliveries.tokenServer("/api/ingest/servers/event/events", `Bearer ${token}`)).toBe("event");
  });
  it("rate-limits warnings per server and kind and reports how many were suppressed", () => {
    const deliveries = multiServer();
    for (let count = 0; count < 5; count++) deliveries.rejected("east", 503, "storage unavailable", true);
    for (let count = 0; count < 3; count++) deliveries.rejected("east", 400, `invalid payload: events.${count}`, true);
    deliveries.rejected("event", 503, "storage unavailable", true);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Rejected a game feed delivery for server east: 503 storage unavailable.",
      "Rejected a game feed delivery for server east: 400 invalid payload: events.0.",
      "Rejected a game feed delivery for server event: 503 storage unavailable.",
    ]);
    jest.advanceTimersByTime(FEED_WARNING_INTERVAL_MS - 1);
    deliveries.rejected("east", 503, "storage unavailable", true);
    expect(warn).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    deliveries.rejected("east", 503, "storage unavailable", true);
    expect(warn).toHaveBeenLastCalledWith(
      "Rejected a game feed delivery for server east: 503 storage unavailable. (5 similar warnings suppressed.)",
    );
    expect(deliveries.status("east").rejectedCount).toBe(10);
  });
  it("keeps each server's latest stored batch counts and warns about invalid entries at most once a minute", () => {
    const deliveries = multiServer();
    const types = { types: 1, typesOverLimit: 0 };
    deliveries.accepted("east", { accepted: 3, skipped: 1, invalid: 0, firstInvalid: null, ...types });
    expect(warn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    deliveries.accepted("east", {
      accepted: 1,
      skipped: 2,
      invalid: 2,
      firstInvalid: "events.0.eventId (bad format)",
      ...types,
    });
    deliveries.accepted("east", {
      accepted: 1,
      skipped: 1,
      invalid: 1,
      firstInvalid: "events.0 (not an object)",
      types: 2,
      typesOverLimit: 0,
    });
    deliveries.rejected("east", 503, "storage unavailable", true);
    expect(deliveries.status("east")).toEqual({
      ...clean,
      lastBatch: {
        at: new Date(now.getTime() + 2_000).toISOString(),
        accepted: 1,
        skipped: 1,
        invalid: 1,
        firstInvalid: "events.0 (not an object)",
        types: 2,
        typesOverLimit: 0,
      },
      lastRejected: { at: new Date(now.getTime() + 2_000).toISOString(), status: 503, reason: "storage unavailable" },
      rejectedCount: 1,
    });
    expect(deliveries.status("event").lastBatch).toBeNull();
    // Partial-batch and refusal warnings are limited separately, so one never hides the other.
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Accepted a game feed batch for server east but skipped 2 invalid entries; first: events.0.eventId (bad format).",
      "Rejected a game feed delivery for server east: 503 storage unavailable.",
    ]);
  });
  it("keeps the batch's type counts and warns about types over the daily limit at most once a minute", () => {
    const deliveries = multiServer();
    const batch = { accepted: 0, skipped: 5, invalid: 0, firstInvalid: null, types: 5 };
    deliveries.accepted("east", { ...batch, typesOverLimit: 3 });
    deliveries.accepted("east", { ...batch, typesOverLimit: 1 });
    expect(deliveries.status("east").lastBatch).toMatchObject({ types: 5, typesOverLimit: 1 });
    jest.advanceTimersByTime(60_000);
    deliveries.accepted("east", { ...batch, typesOverLimit: 2 });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Accepted a game feed batch for server east but did not count 3 new event types: the daily limit of event types was reached.",
      "Accepted a game feed batch for server east but did not count 2 new event types: the daily limit of event types was reached. (1 similar warning suppressed.)",
    ]);
  });
});
