import { Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { EnvService } from "../env/env.service";
import type { RoundPhase } from "./round-state";
import {
  initialPerformanceState,
  MAX_TRACKED,
  observePerformance,
  type PerformanceCandidate,
  type PerformanceRow,
  type PerformanceSettings,
} from "./performance-state";
import { StaffAlerts } from "./staff-alerts.service";

const settings: PerformanceSettings = {
  windowMinutes: 5,
  windowKills: 30,
  matchKills: 40,
  matchKd: 20,
  cooldownMinutes: 360,
};
const owner = "76561198000000001",
  regular = "76561198000000002",
  other = "76561198000000003";
type ReadOptions = { advance?: number; roundId?: string; phase?: RoundPhase; restartLike?: boolean };

function harness(knownGood: Set<string> = new Set()) {
  let state = initialPerformanceState();
  let now = Date.parse("2026-10-02T23:00:00Z");
  const candidates: (PerformanceCandidate & { at: number })[] = [];
  const read = (players: PerformanceRow[], options: ReadOptions = {}) => {
    now += options.advance ?? 10_000;
    const result = observePerformance(
      state,
      {
        roundId: options.roundId ?? "clock:1",
        phase: options.phase ?? "live",
        map: "Kavkazi",
        restartLike: options.restartLike ?? false,
        players,
      },
      now,
      settings,
      knownGood,
    );
    state = result.state;
    candidates.push(...result.candidates.map((candidate) => ({ ...candidate, at: now })));
    return result;
  };
  return {
    read,
    candidates,
    get state() {
      return state;
    },
    get now() {
      return now;
    },
  };
}
const row = (steamId: string, kills?: number, deaths?: number, name = "Player"): PerformanceRow => ({
  steamId,
  name,
  ...(kills === undefined ? {} : { kills }),
  ...(deaths === undefined ? {} : { deaths }),
});
/** Reads every 10 s; `kills(step)` gives the counter at each step. */
function ramp(h: ReturnType<typeof harness>, steps: number, kills: (step: number) => number, deaths = () => 0) {
  for (let step = 1; step <= steps; step++) h.read([row(owner, kills(step), deaths())]);
}

describe("performance flags from game counters", () => {
  it("reports counters unavailable and raises nothing when no row has kills", () => {
    const h = harness();
    for (let index = 0; index < 40; index++) h.read([row(owner), row(regular, undefined, 3)]);
    expect(h.state.counters).toBe("unavailable");
    expect(h.candidates).toEqual([]);
    expect(h.state.players.size).toBe(0);
  });

  it("never alerts on a first observation, even mid-round at 60 kills and 1 death", () => {
    const h = harness();
    h.read([row(owner, 60, 1)]);
    for (let index = 0; index < 60; index++) h.read([row(owner, 60, 1)]);
    expect(h.candidates).toEqual([]);
    expect(h.state.counters).toBe("available");
  });

  it("fires the window rule at 30 kills in 5 minutes sampled every 10 seconds, not at 29", () => {
    const fires = harness();
    fires.read([row(owner, 5, 2)]);
    ramp(
      fires,
      30,
      (step) => 5 + step,
      () => 2,
    );
    expect(fires.candidates).toEqual([
      expect.objectContaining({
        kind: "performance-window",
        rules: ["window"],
        steamId: owner,
        windowKills: 30,
        windowMinutes: 5,
        rate: 6,
        roundKills: 30,
        roundDeaths: 0,
        amend: false,
      }),
    ]);
    const quiet = harness();
    quiet.read([row(owner, 5, 2)]);
    ramp(
      quiet,
      30,
      (step) => 5 + Math.min(step, 29),
      () => 2,
    );
    expect(quiet.candidates).toEqual([]);
  });

  it("does not evaluate a span under 60 seconds", () => {
    const h = harness();
    h.read([row(owner, 0, 2)]);
    for (let step = 1; step <= 5; step++) h.read([row(owner, step * 7, 2)]);
    expect(h.candidates).toEqual([]);
    h.read([row(owner, 36, 2)]);
    expect(h.candidates).toEqual([expect.objectContaining({ rules: ["window"], windowKills: 36, windowMinutes: 1 })]);
  });

  it("starts the window again after a read gap over 60 seconds but keeps the round totals", () => {
    const h = harness();
    h.read([row(owner, 0, 0)]);
    ramp(h, 12, (step) => step * 2);
    h.read([row(owner, 26, 0)], { advance: 90_000 });
    for (let step = 1; step <= 12; step++) h.read([row(owner, 26 + step, 0)]);
    expect(h.candidates).toEqual([]);
    const player = h.state.players.get(owner)!;
    expect(player.carried.kills + player.last.kills - player.base.kills).toBe(38);
  });

  it("fires the match rule at 40 kills and 2 deaths, not 39 and 0 or 60 and 4, flooring deaths at 1", () => {
    const slow = (finalKills: number, deaths: number) => {
      const h = harness();
      h.read([row(owner, 0, 0)]);
      // One kill every 30 seconds stays well under the window rule.
      for (let step = 1; step <= finalKills; step++) {
        h.read([row(owner, step, Math.min(deaths, Math.floor(step / 10)))], { advance: 30_000 });
      }
      h.read([row(owner, finalKills, deaths)], { advance: 30_000 });
      return h.candidates;
    };
    expect(slow(40, 2)).toEqual([
      expect.objectContaining({ kind: "performance-match", rules: ["match"], roundKills: 40, roundDeaths: 2, kd: 20 }),
    ]);
    expect(slow(39, 0)).toEqual([]);
    expect(slow(60, 4)).toEqual([]);
    expect(slow(40, 0)).toEqual([expect.objectContaining({ rules: ["match"], kd: 40 })]);
  });

  it("stays quiet for the owner's observed regular profile: K/D 16 twice and 15 kills in 5 minutes", () => {
    const h = harness();
    for (const round of ["clock:1", "clock:2"]) {
      h.read([row(owner, 0, 0)], { roundId: round });
      for (let step = 1; step <= 48; step++)
        h.read([row(owner, step, Math.ceil(step / 16))], { advance: 20_000, roundId: round });
    }
    const burst = harness();
    burst.read([row(owner, 0, 0)]);
    ramp(burst, 30, (step) => Math.floor(step / 2));
    expect(h.candidates).toEqual([]);
    expect(burst.candidates).toEqual([]);
    expect(h.state.peaks.map((peak) => peak.kd)).toEqual([
      expect.objectContaining({ kills: 48, deaths: 3, kd: 16 }),
      expect.objectContaining({ kills: 48, deaths: 3, kd: 16 }),
    ]);
  });

  it("raises one alert per player per round; a later rule only amends it", () => {
    const h = harness();
    h.read([row(owner, 0, 0)]);
    ramp(h, 30, (step) => step);
    expect(h.candidates.map((candidate) => [candidate.rules, candidate.amend])).toEqual([[["window"], false]]);
    for (let step = 31; step <= 45; step++) h.read([row(owner, step, 1)], { advance: 30_000 });
    expect(h.candidates.map((candidate) => [candidate.rules, candidate.amend])).toEqual([
      [["window"], false],
      [["window", "match"], true],
    ]);
    for (let step = 46; step <= 80; step++) h.read([row(owner, step, 1)]);
    expect(h.candidates).toHaveLength(2);
  });

  it("applies the player cooldown across rounds and the hourly limit records the alert as suppressed", async () => {
    const h = harness();
    for (const round of ["clock:1", "clock:2"]) {
      h.read([row(owner, 0, 0), row(regular, 0, 0)], { roundId: round });
      for (let step = 1; step <= 30; step++) h.read([row(owner, step, 0), row(regular, step, 0)], { roundId: round });
    }
    expect(h.candidates.map((candidate) => [candidate.steamId, candidate.roundKey, candidate.suppressed])).toEqual([
      [owner, "clock:1#0", undefined],
      [regular, "clock:1#0", undefined],
      [owner, "clock:2#0", "player cooldown"],
      [regular, "clock:2#0", "player cooldown"],
    ]);

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const alerts = new StaffAlerts(
      { isReady: () => false } as unknown as Client,
      { get: (key: string) => (key === "STAFF_ALERTS_PERFORMANCE_MAX_PER_HOUR" ? 1 : undefined) } as EnvService,
    );
    const raise = (candidate: PerformanceCandidate) =>
      alerts.raise({
        serverId: "primary",
        kind: candidate.kind,
        severity: "warning",
        key: `perf:${candidate.steamId}:${candidate.roundKey}`,
        title: "Review: unusual kill rate",
        lines: [],
        deliver: true,
        ...(candidate.suppressed ? { suppressed: candidate.suppressed } : {}),
      });
    const results: unknown[] = [];
    for (const candidate of h.candidates) results.push((await raise(candidate))?.delivery);
    expect(results).toEqual([
      { state: "failed", reason: "no staff channel" },
      { state: "suppressed", reason: "hourly limit" },
      { state: "suppressed", reason: "player cooldown" },
      { state: "suppressed", reason: "player cooldown" },
    ]);
    jest.restoreAllMocks();
  });

  it("carries round totals over a rejoin counter drop", () => {
    const h = harness();
    h.read([row(owner, 10, 0)]);
    for (let step = 1; step <= 20; step++) h.read([row(owner, 10 + step, 1)], { advance: 30_000 });
    h.read([row(owner, 0, 0)], { advance: 30_000 });
    for (let step = 1; step <= 20; step++) h.read([row(owner, step, 0)], { advance: 30_000 });
    expect(h.candidates).toEqual([
      expect.objectContaining({ kind: "performance-match", roundKills: 40, roundDeaths: 1, kd: 40 }),
    ]);
  });

  it("moves to a new local round when most tracked counters fall at once", () => {
    const h = harness();
    const ids = [owner, regular, other, "76561198000000004", "76561198000000005"];
    h.read(ids.map((id) => row(id, 20, 5)));
    h.read(ids.map((id) => row(id, 25, 6)));
    expect(h.state.roundKey).toBe("clock:1#0");
    h.read([...ids.slice(0, 4).map((id) => row(id, 0, 0)), row(ids[4], 26, 6)]);
    expect(h.state.roundKey).toBe("clock:1#1");
    expect(h.state.players.get(owner)!.base).toEqual({ kills: 0, deaths: 0 });
    expect(h.state.peaks.map((peak) => peak.roundKey)).toEqual(["clock:1#0", "clock:1#1"]);
    // Three of five is not enough on its own (and fewer than four never is).
    const few = harness();
    few.read(ids.map((id) => row(id, 20, 5)));
    few.read([...ids.slice(0, 3).map((id) => row(id, 0, 0)), ...ids.slice(3).map((id) => row(id, 21, 5))]);
    expect(few.state.roundKey).toBe("clock:1#0");
    // A restart-like boundary from the health reducer also starts a new local round.
    few.read(
      ids.map((id) => row(id, 0, 0)),
      { restartLike: true },
    );
    expect(few.state.roundKey).toBe("clock:1#1");
  });

  it("skips known-good and session never-flag players", () => {
    const h = harness(new Set([owner]));
    h.read([row(owner, 0, 0), row(regular, 0, 0)]);
    for (let step = 1; step <= 45; step++) h.read([row(owner, step, 1), row(regular, step, 1)]);
    expect(h.candidates.map((candidate) => [candidate.steamId, candidate.amend])).toEqual([
      [regular, false],
      [regular, true],
    ]);
  });

  it("does not evaluate while the round phase is unknown", () => {
    const h = harness();
    h.read([row(owner, 0, 0)]);
    for (let step = 1; step <= 40; step++) h.read([row(owner, step, 0)], { phase: "unknown" });
    expect(h.candidates).toEqual([]);
    h.read([row(owner, 41, 0)]);
    expect(h.candidates).toHaveLength(1);
  });

  it("tracks at most 512 players and forgets players unseen for 15 minutes", () => {
    const h = harness();
    const many = Array.from({ length: MAX_TRACKED + 20 }, (_, index) =>
      row(`7656119800${String(index).padStart(7, "0")}`, 0, 0),
    );
    h.read(many);
    expect(h.state.players.size).toBe(MAX_TRACKED);
    h.read(many.slice(0, 10));
    // Newcomers replace players who are no longer present.
    h.read([row(owner, 0, 0)]);
    expect(h.state.players.has(owner)).toBe(true);
    expect(h.state.players.size).toBe(MAX_TRACKED);
    h.read([row(owner, 0, 0)], { advance: 15 * 60_000 + 1 });
    expect([...h.state.players.keys()]).toEqual([owner]);
  });

  it("keeps per-round peaks for the last 20 rounds", () => {
    const h = harness();
    for (let round = 1; round <= 22; round++) {
      h.read([row(owner, 0, 0), row(regular, 0, 0)], { roundId: `clock:${round}` });
      for (let step = 1; step <= 12; step++)
        h.read([row(owner, step, 0), row(regular, Math.floor(step / 2), 1)], { roundId: `clock:${round}` });
    }
    expect(h.state.peaks).toHaveLength(20);
    expect(h.state.peaks[0].roundKey).toBe("clock:3#0");
    expect(h.state.peaks[19]).toMatchObject({
      roundKey: "clock:22#0",
      map: "Kavkazi",
      window: { steamId: owner, kills: 12, minutes: 2 },
      kd: { steamId: owner, kills: 12, deaths: 0, kd: 12 },
    });
  });
});
