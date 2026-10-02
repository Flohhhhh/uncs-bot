import { initialRoundState, observeRound, ROUND_GAP_MS, type RoundState, type RoundStatus } from "./round-state";

const start = Date.parse("2026-10-02T23:00:00Z");
const status = (overrides: Partial<RoundStatus> = {}): RoundStatus => ({
  map: "Kavkazi",
  factionScores: [
    { name: "Lonestar", score: 20 },
    { name: "Valkyra", score: 25 },
  ],
  ...overrides,
});
const scores = (lonestar: number, valkyra: number) => ({
  factionScores: [
    { name: "Lonestar", score: lonestar },
    { name: "Valkyra", score: valkyra },
  ],
});

function harness() {
  let state: RoundState = initialRoundState();
  let now = start;
  const read = (next: RoundStatus, advance = 10_000) => {
    now += advance;
    const update = observeRound(state, next, now);
    state = update.state;
    return update;
  };
  return {
    read,
    get state() {
      return state;
    },
    get now() {
      return now;
    },
  };
}

describe("staff alert round identity", () => {
  it("starts a round on the first read without reporting a change, dated by the clock when present", () => {
    const clocked = harness();
    expect(clocked.read(status({ matchSeconds: 300 }), 0)).toMatchObject({ changed: false });
    expect(clocked.state.round).toEqual({
      id: `clock:${start - 300_000}`,
      map: "Kavkazi",
      startedAt: start - 300_000,
      source: "clock",
    });
    expect(clocked.state.phase).toBe("live");
    const unclocked = harness();
    unclocked.read(status(), 0);
    expect(unclocked.state.round).toMatchObject({ id: `first-seen:${start}`, source: "first-seen" });
  });

  it("keeps one round while scores rise and the clock runs", () => {
    const h = harness();
    h.read(status({ matchSeconds: 300 }), 0);
    const id = h.state.round!.id;
    for (let step = 1; step <= 20; step++)
      expect(h.read(status({ matchSeconds: 300 + step * 10, ...scores(20 + step, 25) })).changed).toBe(false);
    expect(h.state.round!.id).toBe(id);
  });

  it.each([
    ["a map change", status({ map: "Europe" })],
    ["a rotation change", status({ rotation: { nowIndex: 3 } })],
    ["a complete score reset", status(scores(0, 0))],
    ["a large score drop with no team scoring", status(scores(5, 12))],
  ])("starts a new round on %s", (_, next) => {
    const h = harness();
    h.read(status({ rotation: { nowIndex: 2 }, ...scores(40, 45) }), 0);
    const first = h.state.round!.id;
    expect(h.read({ rotation: { nowIndex: 2 }, ...next }).changed).toBe(true);
    expect(h.state.round).toMatchObject({ id: `observed:${h.now}`, source: "observed" });
    expect(h.state.round!.id).not.toBe(first);
  });

  it("starts a new round when the match clock runs backwards", () => {
    const h = harness();
    h.read(status({ matchSeconds: 900 }), 0);
    expect(h.read(status({ matchSeconds: 905 })).changed).toBe(false);
    expect(h.read(status({ matchSeconds: 5 })).changed).toBe(true);
    expect(h.state.round).toMatchObject({ id: `clock:${h.now - 5_000}`, source: "clock" });
  });

  it("gives a new ID when the clock keeps running through map travel", () => {
    const h = harness();
    h.read(status({ matchSeconds: 900 }), 0);
    const first = h.state.round!.id;
    expect(h.read(status({ map: "Europe", matchSeconds: 910 })).changed).toBe(true);
    expect(h.state.round!.id).not.toBe(first);
  });

  it("treats a score reset followed by map travel as one round while nobody has scored", () => {
    const h = harness();
    h.read(status(scores(40, 45)), 0);
    expect(h.read(status(scores(0, 0))).changed).toBe(true);
    const id = h.state.round!.id;
    expect(h.read(status({ map: "Europe", ...scores(0, 0) }), 60_000).changed).toBe(false);
    expect(h.state.round).toMatchObject({ id, map: "Europe" });
  });

  it("never merges into a round that was already running when first seen", () => {
    const h = harness();
    h.read(status(scores(0, 0)), 0);
    expect(h.read(status({ map: "Europe", ...scores(0, 0) })).changed).toBe(true);
  });

  it("decides nothing on a read without usable scores and reports the phase unknown", () => {
    const h = harness();
    h.read(status(), 0);
    const before = h.state;
    for (const factionScores of [
      [],
      [{ name: "Lonestar", score: 1 }],
      [{ name: "", score: 1 }, ...scores(1, 1).factionScores],
    ])
      expect(h.read(status({ map: "Europe", factionScores }))).toEqual({
        state: { ...before, phase: "unknown" },
        changed: false,
      });
    expect(h.read(status({ ...scores(20, 25), scoreCap: 10 })).state.phase).toBe("unknown");
    expect(h.read(status()).state.phase).toBe("live");
  });

  it("ignores repeated or out-of-order reads", () => {
    const h = harness();
    h.read(status(), 0);
    const before = h.state;
    expect(h.read(status({ map: "Europe" }), 0)).toEqual({ state: before, changed: false });
    expect(h.read(status({ map: "Europe" }), -5_000)).toEqual({ state: before, changed: false });
  });

  it("dates a running round when a clock appears, keeping its ID", () => {
    const h = harness();
    h.read(status(), 0);
    const id = h.state.round!.id;
    expect(h.read(status({ matchSeconds: 600 })).changed).toBe(false);
    expect(h.state.round).toMatchObject({ id, source: "clock", startedAt: h.now - 600_000 });
  });

  it("keeps the round across a read gap only when place, clock and score agree", () => {
    const same = harness();
    same.read(status({ matchSeconds: 300 }), 0);
    const id = same.state.round!.id;
    expect(same.read(status({ matchSeconds: 420, ...scores(25, 30) }), 120_000).changed).toBe(false);
    expect(same.state.round!.id).toBe(id);

    const newClock = harness();
    newClock.read(status({ matchSeconds: 300 }), 0);
    // Ten minutes later the clock says the round began well after the one Gramps knew.
    expect(newClock.read(status({ matchSeconds: 400 }), 10 * 60_000).changed).toBe(true);

    const dropped = harness();
    dropped.read(status(scores(60, 70)), 0);
    expect(dropped.read(status(scores(10, 15)), ROUND_GAP_MS + 1).changed).toBe(true);

    const moved = harness();
    moved.read(status(), 0);
    expect(moved.read(status({ map: "Europe" }), ROUND_GAP_MS + 1).changed).toBe(true);
  });

  it("measures score drops against the reported score cap", () => {
    const h = harness();
    h.read(status({ scoreCap: 500, ...scores(200, 240) }), 0);
    // The lead falls from 48 to 40 points out of 100: an ordinary correction.
    expect(h.read(status({ scoreCap: 500, ...scores(200, 200) })).changed).toBe(false);
    // 28 points is 20 below the round's best: a missed reset.
    expect(h.read(status({ scoreCap: 500, ...scores(140, 140) })).changed).toBe(true);
  });
});
