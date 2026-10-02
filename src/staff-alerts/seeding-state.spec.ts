import { Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { EnvService } from "../env/env.service";
import { initialHealthState, observeHealth, type HealthAlert, type HealthReading } from "./health-state";
import { parseWindows } from "./local-time";
import { initialSeedingState, observeSeeding, SEEDING_GUIDANCE, seedingView, type SeedingAlert } from "./seeding-state";
import type { HealthOptions, SeedingOptions } from "./staff-alerts.config";
import { StaffAlerts } from "./staff-alerts.service";

const zone = "America/New_York";
const seedingDefaults: SeedingOptions = {
  enabled: true,
  below: 1,
  minutes: 30,
  afterRestartHours: 12,
  primeWindows: parseWindows("17:00-23:00")!,
  timeZone: zone,
};
const healthDefaults: HealthOptions = {
  enabled: true,
  downMinutes: 10,
  restartPlayers: 10,
  scheduledRestarts: [],
  timeZone: zone,
};
const at = (iso: string) => Date.parse(iso);
const iso = (time: number) => new Date(time).toISOString();

/** Feeds reads every `step` from `from` to `until`; `players(t)` returns a count or null when unreachable. */
function replay(
  from: string,
  until: string,
  players: (time: number) => number | null,
  options: Partial<SeedingOptions> = {},
  restart: { at: number; kind: "restart" | "back" } | null = null,
  step = 30_000,
) {
  let state = initialSeedingState();
  const alerts: (SeedingAlert & { at: string })[] = [];
  for (let time = at(from); time <= at(until); time += step) {
    const count = players(time);
    const result = observeSeeding(state, { reachable: count !== null, players: count, restart }, time, {
      ...seedingDefaults,
      ...options,
    });
    state = result.state;
    alerts.push(...result.alerts.map((alert) => ({ ...alert, at: iso(time) })));
  }
  return { alerts, state };
}

describe("seeding alerts", () => {
  it("replays October 2: one post-restart alert, no prime-time alert and one recovery", () => {
    // Bulkhead's hotfix restart at 08:00Z (04:00 EDT): RCON unreachable for three minutes, the
    // server comes back on the first rotation map with the clock reset, a few players stay until
    // 08:37Z, then it sits empty until about 19:00Z (15:00 EDT).
    let health = initialHealthState();
    let seeding = initialSeedingState();
    const posted: { kind: string; at: string; title: string; lines: string[] }[] = [];
    for (let time = at("2026-10-02T07:30:00Z"); time <= at("2026-10-02T20:00:00Z"); time += 30_000) {
      const down = time >= at("2026-10-02T08:00:00Z") && time < at("2026-10-02T08:03:00Z");
      const players =
        time < at("2026-10-02T08:00:00Z")
          ? 6
          : time < at("2026-10-02T08:37:00Z")
            ? 2
            : time < at("2026-10-02T19:00:00Z")
              ? 0
              : 12;
      const after = time >= at("2026-10-02T08:03:00Z");
      const reading: HealthReading = down
        ? { ok: false, kind: "unreachable" }
        : {
            ok: true,
            map: after ? "Europe" : "Kavkazi",
            players,
            matchSeconds: after ? (time - at("2026-10-02T08:03:00Z")) / 1000 : 1200,
            build: "CL-507060",
            roundChanged: time === at("2026-10-02T08:03:00Z"),
          };
      const result = observeHealth(health, reading, time, healthDefaults);
      health = result.state;
      const seed = observeSeeding(
        seeding,
        { reachable: !down, players: down ? null : players, restart: health.watch },
        time,
        seedingDefaults,
      );
      seeding = seed.state;
      for (const alert of [...result.alerts, ...seed.alerts] as (HealthAlert | SeedingAlert)[])
        posted.push({ kind: alert.kind, at: iso(time), title: alert.title, lines: alert.lines });
    }
    expect(posted.map((alert) => [alert.kind, alert.at])).toEqual([
      ["game-restart", "2026-10-02T08:03:00.000Z"],
      ["seeding-after-restart", "2026-10-02T09:07:00.000Z"],
      ["seeding-recovered", "2026-10-02T19:05:00.000Z"],
    ]);
    expect(posted[1].title).toBe("Still empty 30 min after the 04:00 ET restart");
    expect(posted[1].lines).toEqual([
      "0 players on; below 1 since 04:37 ET.",
      SEEDING_GUIDANCE,
      "Gramps took no action.",
    ]);
    expect(posted[2].lines[0]).toBe("12 players on after 10 h 23 min below 1.");
  });

  it("alerts once per prime-time window date while the server stays empty", () => {
    const { alerts } = replay("2026-10-02T12:00:00Z", "2026-10-04T04:00:00Z", () => 0, {}, null, 60_000);
    expect(alerts.map((alert) => [alert.kind, alert.at, alert.severity])).toEqual([
      ["seeding-prime", "2026-10-02T21:30:00.000Z", "high"],
      ["seeding-prime", "2026-10-03T21:30:00.000Z", "high"],
    ]);
    expect(alerts[0].title).toBe("Still empty 30 min into prime time");
    expect(alerts[0].lines[0]).toBe(
      "0 players on; below 1 since 08:00 ET. Prime time is 17:00-23:00 (America/New_York).",
    );
    expect(alerts[0].key).not.toBe(alerts[1].key);
  });

  it("does not reset the episode or add alerts when one player flickers on and off", () => {
    const restart = { at: at("2026-10-02T08:00:00Z"), kind: "restart" as const };
    // Low from 08:00Z; one player joins for a minute every few minutes.
    const { alerts, state } = replay(
      "2026-10-02T08:00:00Z",
      "2026-10-02T10:00:00Z",
      (time) =>
        (time - at("2026-10-02T08:00:00Z")) % (4 * 60_000) < 60_000 && time > at("2026-10-02T08:01:00Z") ? 1 : 0,
      {},
      restart,
    );
    expect(alerts.map((alert) => alert.kind)).toEqual(["seeding-after-restart"]);
    expect(seedingView(state)).toEqual({ lowSince: "2026-10-02T08:00:00.000Z", alerted: ["after-restart"] });
  });

  it("pauses the low timer while the game is unreachable", () => {
    const restart = { at: at("2026-10-02T08:00:00Z"), kind: "restart" as const };
    const { alerts } = replay(
      "2026-10-02T08:00:00Z",
      "2026-10-02T09:30:00Z",
      (time) => (time >= at("2026-10-02T08:10:00Z") && time < at("2026-10-02T08:30:00Z") ? null : 0),
      {},
      restart,
    );
    expect(alerts.map((alert) => [alert.kind, alert.at])).toEqual([
      ["seeding-after-restart", "2026-10-02T08:50:00.000Z"],
    ]);
  });

  it("sends no recovery message unless a seeding alert was raised", () => {
    const restart = { at: at("2026-10-02T08:00:00Z"), kind: "restart" as const };
    const { alerts } = replay(
      "2026-10-02T08:00:00Z",
      "2026-10-02T09:00:00Z",
      (time) => (time < at("2026-10-02T08:20:00Z") ? 0 : 15),
      {},
      restart,
    );
    expect(alerts).toEqual([]);
  });

  it("uses the configured threshold and turns the post-restart trigger off at 0 hours or after the window", () => {
    const restart = { at: at("2026-10-02T08:00:00Z"), kind: "restart" as const };
    const below20 = replay("2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z", () => 12, { below: 20 }, restart);
    expect(below20.alerts.map((alert) => alert.title)).toEqual([
      "Still below 20 players 30 min after the 04:00 ET restart",
    ]);
    expect(
      replay("2026-10-02T08:00:00Z", "2026-10-02T10:00:00Z", () => 0, { afterRestartHours: 0 }, restart).alerts,
    ).toEqual([]);
    expect(
      replay(
        "2026-10-02T08:00:00Z",
        "2026-10-02T10:00:00Z",
        () => 0,
        { afterRestartHours: 1 },
        {
          at: at("2026-10-02T06:00:00Z"),
          kind: "restart",
        },
      ).alerts,
    ).toEqual([]);
    const back = replay(
      "2026-10-02T08:00:00Z",
      "2026-10-02T09:00:00Z",
      () => 0,
      {},
      {
        at: at("2026-10-02T08:10:00Z"),
        kind: "back",
      },
    );
    expect(back.alerts.map((alert) => [alert.title, alert.at])).toEqual([
      ["Still empty 30 min after RCON came back at 04:10 ET", "2026-10-02T08:40:00.000Z"],
    ]);
  });

  it("records a snoozed seeding alert without posting it", async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const channel = { send: jest.fn() };
    const client = { isReady: () => true, channels: { fetch: jest.fn().mockResolvedValue(channel) } };
    const alerts = new StaffAlerts(client as unknown as Client, { get: () => undefined } as unknown as EnvService);
    alerts.snooze("primary", "seeding", 240, "Mod");
    const restart = { at: at("2026-10-02T08:00:00Z"), kind: "restart" as const };
    const [alert] = replay("2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z", () => 0, {}, restart).alerts;
    const recorded = await alerts.raise({ serverId: "primary", ...alert, deliver: true });
    expect(recorded?.delivery).toEqual({ state: "snoozed", reason: null });
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
