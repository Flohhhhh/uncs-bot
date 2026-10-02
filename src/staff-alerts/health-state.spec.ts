import type { RconErrorKind } from "../admin/rcon-protocol";
import { cleanBuild, initialHealthState, observeHealth, type HealthAlert, type HealthReading } from "./health-state";
import type { HealthOptions } from "./staff-alerts.config";

const defaults: HealthOptions = {
  enabled: true,
  downMinutes: 10,
  restartPlayers: 10,
  scheduledRestarts: [],
  timeZone: "America/New_York",
};
function harness(options: Partial<HealthOptions> = {}, start = "2026-10-02T07:50:00Z") {
  let state = initialHealthState();
  let now = Date.parse(start);
  const alerts: HealthAlert[] = [];
  const good = (overrides: Partial<Extract<HealthReading, { ok: true }>> = {}): HealthReading => ({
    ok: true,
    map: "Kavkazi",
    players: 34,
    matchSeconds: 600,
    build: "CL-507060",
    roundChanged: false,
    ...overrides,
  });
  const fail = (kind: RconErrorKind = "unreachable"): HealthReading => ({ ok: false, kind });
  const read = (reading: HealthReading, advance = 15_000) => {
    now += advance;
    const result = observeHealth(state, reading, now, { ...defaults, ...options });
    state = result.state;
    alerts.push(...result.alerts);
    return result;
  };
  return {
    read,
    good,
    fail,
    alerts,
    kinds: () => alerts.map((alert) => alert.kind),
    get state() {
      return state;
    },
    get now() {
      return now;
    },
  };
}

describe("health inference from RCON reads", () => {
  it("treats the first good read after boot as a silent baseline", () => {
    const h = harness();
    expect(h.read(h.good({ map: "Europe", players: 0, build: "CL-1" }))).toMatchObject({
      alerts: [],
      restartLike: false,
    });
    expect(h.state.build).toBe("CL-1");
  });

  it("sends nothing for one failure, one game-down after ten minutes and one game-back after two good reads", () => {
    const h = harness();
    h.read(h.good());
    h.read(h.fail(), 15_000);
    expect(h.alerts).toEqual([]);
    for (let index = 0; index < 20; index++) h.read(h.fail(), 30_000);
    expect(h.kinds()).toEqual(["game-down"]);
    const down = h.alerts[0];
    expect(down).toMatchObject({ severity: "high", title: "Game unreachable for 10 min" });
    expect(down.lines).toEqual([
      "Could not reach RCON since 03:50 ET.",
      "Inferred from RCON reads.",
      "Gramps took no action.",
    ]);
    for (let index = 0; index < 20; index++) h.read(h.fail(), 30_000);
    expect(h.kinds()).toEqual(["game-down"]);
    h.read(h.good(), 30_000);
    expect(h.kinds()).toEqual(["game-down"]);
    h.read(h.good(), 15_000);
    expect(h.kinds()).toEqual(["game-down", "game-back"]);
    expect(h.alerts[1]).toMatchObject({
      severity: "info",
      title: "Game reachable again",
      key: down.key.replace("down", "back"),
    });
    expect(h.alerts[1].lines[0]).toBe("RCON answered again at 04:11 ET after 20 min (failing since 03:50 ET).");
    expect(h.state.watch).toMatchObject({ kind: "back" });
    expect(h.state.outage).toBeNull();
  });

  it("sends nothing when the game recovers before the threshold", () => {
    const h = harness();
    h.read(h.good());
    for (let index = 0; index < 10; index++) h.read(h.fail(), 30_000);
    h.read(h.good(), 30_000);
    h.read(h.good(), 15_000);
    expect(h.alerts).toEqual([]);
    expect(h.state.outage).toBeNull();
  });

  it("needs at least two failures spanning the threshold", () => {
    const h = harness();
    h.read(h.good());
    h.read(h.fail(), 11 * 60_000);
    expect(h.alerts).toEqual([]);
    h.read(h.fail(), 9 * 60_000);
    expect(h.alerts).toEqual([]);
    h.read(h.fail(), 60_000);
    expect(h.kinds()).toEqual(["game-down"]);
  });

  it("ignores paused reads, which neither start nor extend an outage", () => {
    const h = harness();
    h.read(h.good());
    const before = h.state;
    for (let index = 0; index < 40; index++) expect(h.read(h.fail("paused"), 30_000).state).toBe(before);
    expect(h.alerts).toEqual([]);
    expect(h.state.outage).toBeNull();
  });

  it.each([
    ["rejected", "RCON credentials rejected for 10 min", "RCON rejected Gramps' credentials since 03:50 ET."],
    ["unreadable", "Game answers unreadable for 10 min", "RCON gave an unreadable answer since 03:50 ET."],
    ["error", "Game reads failing for 10 min", "RCON returned errors since 03:50 ET."],
  ] as const)("uses its own wording when reads are %s", (kind, title, line) => {
    const h = harness();
    h.read(h.good());
    h.read(h.fail(kind), 15_000);
    h.read(h.fail(kind), 10 * 60_000);
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: "game-down",
        title,
        lines: [line, expect.any(String), "Gramps took no action."],
      }),
    ]);
  });

  it.each([
    ["a map change", { map: "Europe" }, "Map Bakurani to Ozeti"],
    ["a clock rollback", { matchSeconds: 20 }, "Match clock reset"],
    ["players going from 34 to 0", { players: 0 }, "Players 34 to 0"],
  ])("infers a likely restart after an interruption with %s", (_, change, text) => {
    const h = harness();
    h.read(h.good());
    h.read(h.fail(), 15_000);
    h.read(h.fail(), 60_000);
    const result = h.read(h.good(change), 60_000);
    expect(result.restartLike).toBe(true);
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: "game-restart",
        severity: "warning",
        title: "Likely restart with players on",
      }),
    ]);
    expect(h.alerts[0].suppressed).toBeUndefined();
    expect(h.alerts[0].lines[0]).toBe(`${text}, connection lost 2 min (unscheduled).`);
    expect(h.alerts[0].lines[1]).toContain("inferred from RCON reads");
    expect(h.state.watch).toEqual({ at: Date.parse("2026-10-02T07:50:30Z"), kind: "restart" });
  });

  it("infers a restart after a read gap without a failed read", () => {
    const h = harness();
    h.read(h.good({ players: 3 }));
    const result = h.read(h.good({ players: 0, map: "Europe" }), 5 * 60_000);
    expect(result.restartLike).toBe(true);
    expect(h.alerts[0]).toMatchObject({ severity: "info", title: "Likely restart" });
    expect(h.alerts[0].lines[0]).toBe("Map Bakurani to Ozeti, no reads for 5 min (unscheduled).");
  });

  it("catches a fast crash: a full server empties at a round boundary and stays empty past a map load", () => {
    const h = harness();
    h.read(h.good({ players: 12 }));
    expect(h.read(h.good({ players: 0, roundChanged: true }), 10_000).restartLike).toBe(false);
    const emptiedAt = h.now;
    // Three minutes is the community map-load hold; nothing is raised or remembered inside it.
    for (let read = 0; read < 12; read++) expect(h.read(h.good({ players: 0 }), 15_000).restartLike).toBe(false);
    expect(h.alerts).toEqual([]);
    expect(h.state).toMatchObject({ lastRestartAt: null, watch: null });
    expect(h.read(h.good({ players: 1 }), 15_000).restartLike).toBe(true);
    expect(h.alerts).toEqual([expect.objectContaining({ kind: "game-restart", severity: "warning" })]);
    expect(h.alerts[0].lines[0]).toBe(
      "Players 12 to 0, new round, no failed read, still empty 3 min later (unscheduled).",
    );
    expect(h.state).toMatchObject({
      lastRestartAt: emptiedAt,
      watch: { at: emptiedAt, kind: "restart" },
      pending: null,
    });
    const quiet = harness();
    quiet.read(quiet.good({ players: 12 }));
    expect(quiet.read(quiet.good({ players: 0 }), 10_000).restartLike).toBe(false);
    expect(quiet.read(quiet.good({ players: 0, roundChanged: true }), 10_000).restartLike).toBe(false);
    expect(quiet.state.pending).toBeNull();
  });

  it("treats an ordinary map load that empties the roster as nothing once players come back", () => {
    const h = harness();
    h.read(h.good({ players: 30 }));
    h.read(h.good({ players: 0, map: "Europe", matchSeconds: 5, roundChanged: true }), 15_000);
    h.read(h.good({ players: 0, map: "Europe", matchSeconds: 20 }), 15_000);
    h.read(h.good({ players: 14, map: "Europe", matchSeconds: 35 }), 15_000);
    // Hours later the server empties naturally; no restart is remembered, so seeding has nothing to follow.
    for (let read = 0; read < 40; read++) h.read(h.good({ players: 0, map: "Europe" }), 15_000);
    expect(h.alerts).toEqual([]);
    expect(h.state).toMatchObject({ lastRestartAt: null, watch: null, pending: null });
  });

  it("treats one failed read across a rotation as a hitch unless the server stays empty or the build changes", () => {
    const next = { map: "Europe", matchSeconds: 5, roundChanged: true };
    const intact = harness();
    intact.read(intact.good({ players: 30 }));
    intact.read(intact.fail(), 15_000);
    expect(intact.read(intact.good({ players: 30, ...next }), 30_000).restartLike).toBe(false);
    intact.read(intact.good({ players: 30, map: "Europe", matchSeconds: 20 }), 15_000);
    expect(intact.alerts).toEqual([]);
    expect(intact.state).toMatchObject({ lastRestartAt: null, watch: null, pending: null, outage: null });

    const loading = harness();
    loading.read(loading.good({ players: 30 }));
    loading.read(loading.fail(), 15_000);
    expect(loading.read(loading.good({ players: 0, ...next }), 30_000).restartLike).toBe(false);
    loading.read(loading.good({ players: 18, map: "Europe", matchSeconds: 50 }), 15_000);
    expect(loading.alerts).toEqual([]);
    expect(loading.state).toMatchObject({ lastRestartAt: null, watch: null, pending: null });

    const restart = harness();
    restart.read(restart.good({ players: 30 }));
    restart.read(restart.fail(), 15_000);
    const failedAt = restart.now;
    restart.read(restart.good({ players: 0, ...next }), 30_000);
    for (let read = 0; read < 12; read++) restart.read(restart.good({ players: 0, map: "Europe" }), 15_000);
    expect(restart.kinds()).toEqual(["game-restart"]);
    expect(restart.alerts[0].lines[0]).toBe(
      "Map Bakurani to Ozeti, match clock reset, players 30 to 0, connection lost under 1 min, still empty 3 min later (unscheduled).",
    );
    expect(restart.state.lastRestartAt).toBe(failedAt);

    const update = harness();
    update.read(update.good({ players: 30 }));
    update.read(update.fail(), 15_000);
    expect(update.read(update.good({ players: 30, build: "CL-2" }), 30_000).restartLike).toBe(true);
    expect(update.kinds()).toEqual(["game-restart", "game-build"]);
  });

  it("keeps one failed read a hitch when timeouts and a cached read push the good reads over a minute apart", () => {
    // A cached read 3 s old, the next read 15 s later timing out after 8 s, a 30 s retry and a 4.5 s recovery.
    const next = { map: "Europe", matchSeconds: 5, roundChanged: true };
    const slow = harness();
    slow.read(slow.good({ players: 30 }));
    slow.read(slow.fail(), 3_000 + 15_000 + 8_000);
    expect(slow.read(slow.good({ players: 30, ...next }), 30_000 + 4_500).restartLike).toBe(false);
    slow.read(slow.good({ players: 30, map: "Europe", matchSeconds: 20 }), 15_000);
    expect(slow.alerts).toEqual([]);
    expect(slow.state).toMatchObject({ lastRestartAt: null, watch: null, pending: null, outage: null });

    // A failed read after more than a minute without one is a read gap, not a hitch.
    const quiet = harness();
    quiet.read(quiet.good({ players: 30 }));
    quiet.read(quiet.fail(), 5 * 60_000);
    expect(quiet.read(quiet.good({ players: 30, ...next }), 30_000).restartLike).toBe(true);
    expect(quiet.kinds()).toEqual(["game-restart"]);

    // So is a failed read followed by more than a minute without a good one.
    const late = harness();
    late.read(late.good({ players: 30 }));
    late.read(late.fail(), 15_000);
    expect(late.read(late.good({ players: 30, ...next }), 5 * 60_000).restartLike).toBe(true);
    expect(late.kinds()).toEqual(["game-restart"]);
  });

  it("sends no restart alert after an interruption with no restart signal", () => {
    const h = harness();
    h.read(h.good());
    h.read(h.fail(), 15_000);
    expect(h.read(h.good({ matchSeconds: 640 }), 30_000).restartLike).toBe(false);
    h.read(h.good({ matchSeconds: 655 }), 15_000);
    // A later read gap with the same map, clock and players is not a restart either.
    expect(h.read(h.good({ matchSeconds: 955 }), 5 * 60_000).restartLike).toBe(false);
    expect(h.alerts).toEqual([]);
  });

  it("records a scheduled restart below the player threshold only, and warns at or above it", () => {
    const below = harness({ scheduledRestarts: [240] });
    below.read(below.good({ players: 3 }));
    below.read(below.fail(), 9 * 60_000);
    below.read(below.good({ players: 0, map: "Europe" }), 60_000);
    expect(below.alerts).toEqual([
      expect.objectContaining({ severity: "info", suppressed: "scheduled restart, recorded only" }),
    ]);
    expect(below.alerts[0].lines[0]).toContain("(scheduled)");
    const full = harness({ scheduledRestarts: [240] });
    full.read(full.good({ players: 10 }));
    full.read(full.fail(), 9 * 60_000);
    full.read(full.good({ players: 0 }), 60_000);
    expect(full.alerts).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(full.alerts[0].suppressed).toBeUndefined();
  });

  it("lets a recorded-only scheduled restart use up no restart limit, and records a restart the limit holds back", () => {
    const h = harness({ scheduledRestarts: [240] }, "2026-10-02T07:59:30Z");
    h.read(h.good({ players: 3 }));
    h.read(h.fail(), 15_000);
    h.read(h.fail(), 30_000);
    h.read(h.good({ players: 0, map: "Europe" }), 30_000);
    expect(h.alerts).toEqual([expect.objectContaining({ suppressed: "scheduled restart, recorded only" })]);
    for (let read = 0; read < 68; read++) h.read(h.good({ players: 14, map: "Europe" }), 15_000);
    // A crash 19 minutes later, with 14 players on, still posts.
    h.read(h.fail(), 60_000);
    h.read(h.fail(), 30_000);
    h.read(h.good({ players: 0 }), 30_000);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]).toMatchObject({ severity: "warning", title: "Likely restart with players on" });
    expect(h.alerts[1].suppressed).toBeUndefined();
    // Another restart inside 30 minutes of that post is held back, and still recorded.
    for (let read = 0; read < 8; read++) h.read(h.good({ players: 12 }), 15_000);
    h.read(h.fail(), 15_000);
    h.read(h.fail(), 30_000);
    h.read(h.good({ players: 0, map: "Europe" }), 30_000);
    expect(h.alerts.map((alert) => alert.suppressed ?? null)).toEqual([
      "scheduled restart, recorded only",
      null,
      "restart limit",
    ]);
    // Distinct keys, so the alert service records each one instead of treating it as a repeat.
    expect(new Set(h.alerts.map((alert) => alert.key)).size).toBe(3);
  });

  it("posts at most one restart alert per 30 minutes, recording the rest, and keeps the latest restart time", () => {
    const h = harness();
    h.read(h.good());
    h.read(h.fail(), 15_000);
    h.read(h.fail(), 30_000);
    h.read(h.good({ map: "Europe" }), 30_000);
    h.read(h.good({ map: "Europe" }), 15_000);
    h.read(h.fail(), 10 * 60_000);
    h.read(h.good({ map: "Kavkazi" }), 30_000);
    expect(h.alerts.map((alert) => [alert.kind, alert.suppressed ?? null])).toEqual([
      ["game-restart", null],
      ["game-restart", "restart limit"],
    ]);
    expect(h.state.lastRestartAt).toBe(h.now - 30_000);
    h.read(h.good({ map: "Kavkazi" }), 15_000);
    h.read(h.fail(), 30 * 60_000);
    h.read(h.good({ map: "Europe" }), 30_000);
    expect(h.alerts.map((alert) => alert.suppressed ?? null)).toEqual([null, "restart limit", null]);
  });

  it("records a second posted restart that starts in the same half hour as the first", () => {
    const h = harness({}, "2026-10-02T08:00:00Z");
    h.read(h.good());
    h.read(h.fail(), 15_000);
    h.read(h.fail(), 30_000);
    h.read(h.good({ map: "Europe" }), 30_000);
    // The game fails again at 08:19:45 and is back on another map at 08:33, past the 30-minute limit.
    for (let read = 0; read < 71; read++) h.read(h.good({ map: "Europe" }), 15_000);
    h.read(h.fail(), 30_000);
    h.read(h.fail(), 8 * 60_000);
    h.read(h.good({ map: "Kavkazi" }), 5 * 60_000 + 15_000);
    expect(new Date(h.now).toISOString()).toBe("2026-10-02T08:33:00.000Z");
    expect(h.alerts.map((alert) => [alert.kind, alert.suppressed ?? null])).toEqual([
      ["game-restart", null],
      ["game-restart", null],
    ]);
    // Distinct keys, so the alert service records the second restart instead of treating it as a repeat.
    expect(h.alerts[0].key).not.toBe(h.alerts[1].key);
  });

  it("alerts once per build change after a silent baseline, and once more on a change back", () => {
    const h = harness();
    h.read(h.good({ build: null }));
    h.read(h.good({ build: "  " }));
    h.read(h.good({ build: "CL-1" }));
    expect(h.alerts).toEqual([]);
    h.read(h.good({ build: "CL-2" }));
    h.read(h.good({ build: "CL-2" }));
    h.read(h.good({ build: "" }));
    h.read(h.good({ build: "CL-1" }));
    expect(h.alerts.map((alert) => [alert.kind, alert.key, alert.lines[0]])).toEqual([
      ["game-build", "build:CL-2", "Build CL-1 to CL-2."],
      ["game-build", "build:CL-1", "Build CL-2 to CL-1."],
    ]);
  });

  it("labels a build change near a restart as a likely game update", () => {
    const h = harness();
    h.read(h.good({ build: "CL-1" }));
    h.read(h.fail(), 15_000);
    h.read(h.good({ build: "CL-2", players: 0 }), 60_000);
    expect(h.kinds()).toEqual(["game-restart", "game-build"]);
    expect(h.alerts[1].lines[0]).toBe("Build CL-1 to CL-2, after a restart (likely game update).");
  });

  it("cleans build labels of control characters and caps them", () => {
    expect(cleanBuild(" CL\u0000-5\n07 ")).toBe("CL-507");
    expect(cleanBuild("x".repeat(100))).toHaveLength(64);
    expect(cleanBuild(undefined)).toBeNull();
    expect(cleanBuild("\u0007")).toBeNull();
  });
});
