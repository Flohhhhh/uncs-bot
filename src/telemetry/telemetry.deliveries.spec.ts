import { Logger } from "@nestjs/common";
import type { EnvService } from "../env/env.service";
import { AdminSettings } from "../admin/admin.settings";
import { fixtureServers } from "../admin/game-server-fixture";
import { GameServers } from "../admin/game-servers";
import { FEED_WARNING_INTERVAL_MS, TelemetryDeliveries } from "./telemetry.deliveries";

const now = new Date("2026-10-02T12:00:00.000Z");
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
    expect(deliveries.status("east")).toEqual({ lastBatch: null, lastRejected: null, rejectedCount: 0 });
    deliveries.rejected("east", 401, "token mismatch");
    jest.advanceTimersByTime(1_000);
    deliveries.rejected("east", 400, "invalid payload: serverId (bad format)");
    expect(deliveries.status("east")).toEqual({
      lastBatch: null,
      lastRejected: {
        at: new Date(now.getTime() + 1_000).toISOString(),
        status: 400,
        reason: "invalid payload: serverId (bad format)",
      },
      rejectedCount: 2,
    });
    expect(deliveries.status("event")).toEqual({ lastBatch: null, lastRejected: null, rejectedCount: 0 });
  });
  it("logs unconfigured server routes without storing them or echoing the requested ID", () => {
    const deliveries = multiServer();
    deliveries.rejected("attacker\nforged-line", 404, "unknown server");
    deliveries.rejected(undefined, 400, "server not selected");
    for (const id of ["east", "event", "attacker\nforged-line"])
      expect(deliveries.status(id)).toEqual({ lastBatch: null, lastRejected: null, rejectedCount: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "Rejected a game feed delivery for an unconfigured server route: 404 unknown server.",
    );
  });
  it.each([
    ["/api/ingest/events", "primary"],
    ["/api/ingest/events?retry=1", "primary"],
    ["/API/Ingest/Events/", "primary"],
    ["/api/ingest/servers/primary/events", "primary"],
  ])("attributes refusals made before the controller for %s", (url, serverId) => {
    const deliveries = new TelemetryDeliveries(fixtureServers({}));
    expect(deliveries.rejectedRequest(url, 429, "rate limited")).toBe(true);
    expect(deliveries.status(serverId)).toMatchObject({
      lastRejected: { status: 429, reason: "rate limited" },
      rejectedCount: 1,
    });
  });
  it("ignores other routes and never attributes unknown or undecodable server routes", () => {
    const deliveries = new TelemetryDeliveries(fixtureServers({}));
    for (const url of ["/community/api/leaderboard", "/admin/api/combat", "/api/ingest/events/extra", "/api/other"])
      expect(deliveries.rejectedRequest(url, 429, "rate limited")).toBe(false);
    expect(deliveries.rejectedRequest("/api/ingest/servers/%FF/events", 400, "unreadable request")).toBe(true);
    expect(deliveries.rejectedRequest("/api/ingest/servers/other/events", 413, "too large")).toBe(true);
    expect(deliveries.status("primary")).toEqual({ lastBatch: null, lastRejected: null, rejectedCount: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("rate-limits warnings per server and reports how many were suppressed", () => {
    const deliveries = multiServer();
    for (let count = 0; count < 5; count++) deliveries.rejected("east", 401, "token mismatch");
    deliveries.rejected("event", 503, "feed disabled");
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Rejected a game feed delivery for server east: 401 token mismatch.",
      "Rejected a game feed delivery for server event: 503 feed disabled.",
    ]);
    jest.advanceTimersByTime(FEED_WARNING_INTERVAL_MS - 1);
    deliveries.rejected("east", 429, "rate limited");
    expect(warn).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    deliveries.rejected("east", 400, "too large");
    expect(warn).toHaveBeenLastCalledWith(
      "Rejected a game feed delivery for server east: 400 too large. (5 similar warnings suppressed.)",
    );
    expect(deliveries.status("east").rejectedCount).toBe(7);
  });
  it("keeps each server's latest stored batch counts and warns about invalid entries at most once a minute", () => {
    const deliveries = multiServer();
    deliveries.accepted("east", { accepted: 3, skipped: 1, invalid: 0, firstInvalid: null });
    expect(warn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    deliveries.accepted("east", { accepted: 1, skipped: 2, invalid: 2, firstInvalid: "events.0.eventId (bad format)" });
    deliveries.accepted("east", { accepted: 0, skipped: 1, invalid: 1, firstInvalid: "events.0 (not an object)" });
    deliveries.rejected("east", 401, "token mismatch");
    expect(deliveries.status("east")).toEqual({
      lastBatch: {
        at: new Date(now.getTime() + 2_000).toISOString(),
        accepted: 0,
        skipped: 1,
        invalid: 1,
        firstInvalid: "events.0 (not an object)",
      },
      lastRejected: { at: new Date(now.getTime() + 2_000).toISOString(), status: 401, reason: "token mismatch" },
      rejectedCount: 1,
    });
    expect(deliveries.status("event").lastBatch).toBeNull();
    // Partial-batch and refusal warnings are limited separately, so one never hides the other.
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Accepted a game feed batch for server east but skipped 2 invalid entries; first: events.0.eventId (bad format).",
      "Rejected a game feed delivery for server east: 401 token mismatch.",
    ]);
  });
});
