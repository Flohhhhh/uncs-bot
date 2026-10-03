import {
  changedRound,
  observedElapsed,
  roundElapsed,
  roundObservation,
  roundSettled,
  trackRound,
  type RoundObservation,
  type RoundTrack,
  type RoundUpdate,
} from "./round-tracker";

const t0 = Date.parse("2026-10-02T12:00:00Z");
const scores = (lonestar: number, manticore: number, valkyra: number) => [
  { name: "Lonestar", score: lonestar },
  { name: "Manticore", score: manticore },
  { name: "Valkyra", score: valkyra },
];
function observation(at: number, patch: Partial<RoundObservation> = {}): RoundObservation {
  return {
    at,
    map: "Kavkazi",
    nowIndex: 0,
    scores: scores(10, 5, 2),
    players: { current: 60, max: 100 },
    threshold: 20,
    ...patch,
  };
}
/** Feeds observations in order and returns every update. */
function run(observations: RoundObservation[], seed?: Parameters<typeof trackRound>[2]) {
  let track: RoundTrack | null = null;
  const updates: RoundUpdate[] = [];
  for (const item of observations) {
    const update = trackRound(track, item, seed);
    track = update.track;
    updates.push(update);
  }
  return updates;
}
const boundaries = (updates: RoundUpdate[]) => updates.filter((update) => update.boundary).map((u) => u.reason);

describe("round tracking without requiring the match clock", () => {
  it("treats the live pre-round sample from 2 October as waiting, with no boundary or progress", () => {
    // GET /v1/status on 2026-10-02 while waiting for 20 players: no matchSeconds and no scoreCap.
    const status = {
      serverName: "The UNCs | Primary",
      map: "Bakurani",
      lighting: "DayClear",
      experiences: ["Bakurani_KOTH_01"],
      alternator: "ZoneAlternator.Bakurani.Default.Circle",
      scoreTick: { current: 24, min: 18, max: 30 },
      rotation: { nowIndex: 0, nextIndex: 1 },
      players: { current: 1, max: 100 },
      factionScores: [
        { name: "Valkyra", colorHex: "#4f7dd9", score: 0 },
        { name: "Lonestar", colorHex: "#d9a54f", score: 0 },
        { name: "Manticore", colorHex: "#c04848", score: 0 },
      ],
    };
    const updates = run([roundObservation(status, t0, 20), roundObservation(status, t0 + 15_000, 20)]);
    expect(updates.map((update) => update.track.phase)).toEqual(["waiting", "waiting"]);
    expect(boundaries(updates)).toEqual([]);
    expect(updates[1].track.round).toMatchObject({ source: "baseline", exact: false, index: 0 });
    expect(updates[1].track.waitingSince).toBe(t0);
    expect(updates[1].track.highest).toBe(0);
    expect(roundElapsed(updates[1].track, t0 + 15_000)).toBeNull();
  });
  it("prefers a reported clock and dates the round exactly", () => {
    const [update] = run([observation(t0, { matchSeconds: 300 })]);
    expect(update.track.round).toMatchObject({ source: "clock", exact: true, startedAt: t0 - 300_000 });
    expect(update.track.round.id).toBe(`clock:${t0 - 300_000}`);
    expect(roundElapsed(update.track, t0 + 10_000)).toBe(310);
  });
  it("keeps the round when the clock disappears mid-round, and dates a baseline round when one appears", () => {
    const updates = run([
      observation(t0, { matchSeconds: 300 }),
      observation(t0 + 15_000, { matchSeconds: null, scores: scores(12, 5, 2) }),
    ]);
    expect(updates[1].track.round).toEqual(updates[0].track.round);
    expect(boundaries(updates)).toEqual([]);
    const dated = run([observation(t0), observation(t0 + 15_000, { matchSeconds: 400 })]);
    expect(dated[1].track.round).toMatchObject({
      id: dated[0].track.round.id,
      source: "clock",
      exact: true,
      startedAt: t0 + 15_000 - 400_000,
    });
  });
  it.each([
    ["map", { map: "Europe", scores: scores(0, 0, 0) }],
    ["index", { nowIndex: 1 }],
    ["missed-reset", { scores: scores(4, 2, 1) }],
  ] as const)("detects a %s boundary from observable signals", (reason, patch) => {
    const updates = run([observation(t0, { scores: scores(90, 50, 30) }), observation(t0 + 15_000, patch)]);
    expect(boundaries(updates)).toEqual([reason]);
    expect(updates[1].track.round).toMatchObject({ source: "observed", exact: true, startedAt: t0 + 15_000 });
    expect(updates[1].track.round.id).not.toBe(updates[0].track.round.id);
  });
  it("detects a full reset and a clock rollback over 30 seconds", () => {
    expect(
      boundaries(
        run([observation(t0, { scores: scores(40, 20, 10) }), observation(t0 + 15_000, { scores: scores(0, 0, 0) })]),
      ),
    ).toEqual(["reset"]);
    const rollback = run([observation(t0, { matchSeconds: 600 }), observation(t0 + 15_000, { matchSeconds: 20 })]);
    expect(boundaries(rollback)).toEqual(["clock"]);
    expect(rollback[1].track.round).toMatchObject({ source: "clock", startedAt: t0 + 15_000 - 20_000 });
  });
  it("ignores clock jitter of 30 seconds or less and a partial score drop", () => {
    expect(
      boundaries(run([observation(t0, { matchSeconds: 600 }), observation(t0 + 15_000, { matchSeconds: 586 })])),
    ).toEqual([]);
    const partial = run([
      observation(t0, { scores: scores(50, 40, 30) }),
      observation(t0 + 15_000, { scores: scores(45, 40, 30) }),
    ]);
    expect(boundaries(partial)).toEqual([]);
    expect(partial[1].track.highest).toBe(50);
  });
  it("does not call a drop a missed reset while another team is still scoring", () => {
    expect(
      boundaries(
        run([observation(t0, { scores: scores(90, 50, 30) }), observation(t0 + 15_000, { scores: scores(4, 60, 1) })]),
      ),
    ).toEqual([]);
  });
  it("merges a score reset and the following map travel into one round while nobody has scored", () => {
    const updates = run([
      observation(t0, { scores: scores(100, 60, 40) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0) }),
      observation(t0 + 45_000, { map: "Europe", nowIndex: 1, scores: scores(0, 0, 0) }),
      observation(t0 + 200_000, { map: "Europe", nowIndex: 1, scores: scores(5, 0, 0) }),
    ]);
    expect(boundaries(updates)).toEqual(["reset"]);
    expect(updates[2].track.round).toMatchObject({ id: updates[1].track.round.id, map: "Europe", index: 1 });
    expect(updates[2].track.lastSignalAt).toBe(t0 + 45_000);
    expect(updates[0].track.ended).toBe(true);
    expect(updates[3].track.ended).toBe(false);
  });
  it.each([
    ["map travel", { map: "Europe", nowIndex: 1 }, "map"],
    ["a rotation index change", { nowIndex: 1 }, "index"],
    ["a clock restart", { matchSeconds: 5 }, "clock"],
  ] as const)(
    "starts a round without points when %s shows the old final scoreboard, then merges the reset",
    (_, patch, reason) => {
      const clock = "matchSeconds" in patch ? { matchSeconds: 900 } : {};
      const updates = run([
        observation(t0, { ...clock, scores: scores(100, 40, 20) }),
        // The boundary arrives while the final scores are still shown, for 45 seconds.
        ...[15_000, 30_000, 45_000, 60_000].map((at) =>
          observation(t0 + at, {
            ...patch,
            ...("matchSeconds" in patch ? { matchSeconds: 5 + (at - 15_000) / 1000 } : {}),
            scores: scores(100, 40, 20),
          }),
        ),
        observation(t0 + 75_000, {
          ...patch,
          ...("matchSeconds" in patch ? { matchSeconds: 65 } : {}),
          scores: scores(0, 0, 0),
        }),
        observation(t0 + 120_000, {
          ...patch,
          ...("matchSeconds" in patch ? { matchSeconds: 110 } : {}),
          scores: scores(3, 0, 0),
        }),
      ]);
      expect(boundaries(updates)).toEqual([reason]);
      const shown = updates[4].track;
      expect(shown).toMatchObject({ highest: 0, ended: false });
      expect(shown.round.id).not.toBe(updates[0].track.round.id);
      // The reset is the same transition: one round, which starts its count again from the reset.
      expect(updates[5].track.round.id).toBe(shown.round.id);
      if (reason !== "clock") expect(updates[5].track.round.startedAt).toBe(t0 + 75_000);
      expect(updates[5].track.lastSignalAt).toBe(t0 + 75_000);
      expect(updates[6].track).toMatchObject({ highest: 3, ended: false });
    },
  );
  it("counts the first new points after an old final scoreboard without a separate reset", () => {
    const updates = run([
      observation(t0, { scores: scores(100, 40, 20) }),
      observation(t0 + 15_000, { map: "Europe", nowIndex: 1, scores: scores(100, 40, 20) }),
      // A poll missed the reset: the new match already has points.
      observation(t0 + 60_000, { map: "Europe", nowIndex: 1, scores: scores(4, 2, 0) }),
    ]);
    expect(boundaries(updates)).toEqual(["map"]);
    expect(updates[2].track).toMatchObject({ highest: 4, ended: false });
    expect(updates[2].track.round.id).toBe(updates[1].track.round.id);
  });
  it("starts a new round for a signal more than 180 seconds after the start or once someone has scored", () => {
    const late = run([
      observation(t0, { scores: scores(90, 0, 0) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0) }),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) =>
        observation(t0 + 15_000 + n * 15_000, { scores: scores(0, 0, 0) }),
      ),
      observation(t0 + 225_000, { map: "Europe", nowIndex: 1, scores: scores(0, 0, 0) }),
    ]);
    expect(boundaries(late)).toEqual(["reset", "map"]);
    const scored = run([
      observation(t0, { scores: scores(90, 0, 0) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0) }),
      observation(t0 + 30_000, { scores: scores(3, 0, 0) }),
      observation(t0 + 45_000, { map: "Europe", nowIndex: 1, scores: scores(0, 0, 0) }),
    ]);
    expect(boundaries(scored)).toEqual(["reset", "map"]);
  });
  it("keeps one round while players flap around the start threshold", () => {
    const scoring = run(
      [19, 20, 19, 20].map((current, n) =>
        observation(t0 + n * 15_000, { players: { current, max: 100 }, scores: scores(30 + n, 10, 5) }),
      ),
    );
    expect(scoring.map((update) => update.track.phase)).toEqual(["live", "live", "live", "live"]);
    expect(new Set(scoring.map((update) => update.track.round.id)).size).toBe(1);
    const idle = run(
      [19, 20, 19, 20].map((current, n) =>
        observation(t0 + n * 40_000, { players: { current, max: 100 }, scores: scores(0, 0, 0) }),
      ),
    );
    expect(idle.map((update) => update.track.phase)).toEqual(["waiting", "live", "waiting", "live"]);
    expect(boundaries(idle)).toEqual([]);
    expect(new Set(idle.map((update) => update.track.round.id)).size).toBe(1);
    expect(idle[1].track.playingSince).toBe(t0 + 40_000);
    expect(idle[3].track.playingSince).toBe(t0 + 120_000);
    // Play starting after a short wait does not move the start.
    const brief = run([
      observation(t0, { players: { current: 19, max: 100 }, scores: scores(0, 0, 0) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0) }),
    ]);
    expect(brief[1].track.playingSince).toBeNull();
  });
  it("counts an exact round from the later of its start and the end of pre-round waiting", () => {
    const updates = run([
      observation(t0, { scores: scores(10, 0, 0) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0), players: { current: 3, max: 100 } }),
      observation(t0 + 60_000, { scores: scores(0, 0, 0), players: { current: 3, max: 100 } }),
      observation(t0 + 90_000, { scores: scores(0, 0, 0), players: { current: 25, max: 100 } }),
    ]);
    const track = updates[3].track;
    expect(track.round).toMatchObject({ source: "observed", startedAt: t0 + 15_000, exact: true });
    expect(track.playingSince).toBe(t0 + 90_000);
    expect(roundElapsed(track, t0 + 150_000)).toBe(60);
    expect(observedElapsed(track, t0 + 150_000)).toBe(60);
  });
  it("continues a round after a read gap when the map, index and score agree, without claiming an exact start", () => {
    const updates = run([
      observation(t0, { scores: scores(40, 20, 10) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0) }),
      observation(t0 + 30_000, { scores: scores(10, 0, 0) }),
      observation(t0 + 120_000, { scores: scores(30, 0, 0) }),
    ]);
    expect(updates[3].track.round).toMatchObject({ id: updates[2].track.round.id, exact: false });
    expect(updates[3].boundary).toBe(false);
    expect(updates[3].track.firstSeenAt).toBe(t0 + 120_000);
    expect(roundElapsed(updates[3].track, t0 + 130_000)).toBeNull();
    expect(observedElapsed(updates[3].track, t0 + 130_000)).toBe(10);
    const moved = run([observation(t0), observation(t0 + 120_000, { nowIndex: 1, map: "Europe" })]);
    expect(moved[1]).toMatchObject({ boundary: true, reason: "gap" });
    expect(moved[1].track.round).toMatchObject({ source: "baseline", exact: false, index: 1 });
    const dropped = run([
      observation(t0, { scores: scores(60, 0, 0) }),
      observation(t0 + 120_000, { scores: scores(5, 0, 0) }),
    ]);
    expect(dropped[1].boundary).toBe(true);
  });
  it("compares the first valid read after a gap with the known round, even after an unreadable read", () => {
    const updates = run([
      observation(t0, { scores: scores(100, 40, 20) }),
      // No valid read for 70 seconds, then the new map loads with no scores yet.
      observation(t0 + 70_000, { map: "Europe", nowIndex: 1, scores: [] }),
      observation(t0 + 85_000, { map: "Europe", nowIndex: 1, scores: scores(5, 0, 0) }),
    ]);
    expect(updates[1].track.last).toEqual(updates[0].track.last);
    expect(updates[2]).toMatchObject({ boundary: true, reason: "gap" });
    expect(updates[2].track.round).toMatchObject({ map: "Europe", index: 1, exact: false });
    expect(updates[2].track.round.id).not.toBe(updates[0].track.round.id);
    // A round that ended low is not mistaken for the new match either.
    const low = run([
      observation(t0, { scores: scores(30, 10, 5) }),
      observation(t0 + 70_000, { map: "Europe", nowIndex: 1, scores: [] }),
      observation(t0 + 85_000, { map: "Europe", nowIndex: 1, scores: scores(25, 0, 0) }),
    ]);
    expect(boundaries(low)).toEqual(["gap"]);
    expect(low[2].track.round.map).toBe("Europe");
  });
  it("continues a stored round after a restart and starts a new one when the match moved on", () => {
    const seed = {
      round: {
        id: "observed:1",
        map: "Kavkazi",
        index: 0,
        startedAt: t0 - 600_000,
        source: "observed" as const,
        exact: true,
      },
      highest: 60,
    };
    const [same] = run([observation(t0, { scores: scores(62, 10, 0) })], seed);
    expect(same.track.round).toMatchObject({ id: "observed:1", exact: false });
    expect(same.track.highest).toBe(62);
    const [restarted] = run([observation(t0, { scores: scores(3, 0, 0) })], seed);
    expect(restarted.boundary).toBe(true);
    expect(restarted.track.round.id).not.toBe("observed:1");
    const [clocked] = run([observation(t0, { scores: scores(62, 10, 0), matchSeconds: 620 })], seed);
    expect(clocked.track.round).toMatchObject({ id: "observed:1", source: "clock", exact: true });
    // A seed is ignored once a track exists and observations continue.
    const updates = run([observation(t0), observation(t0 + 15_000)], seed);
    expect(updates[0].track.round.id).not.toBe("observed:1");
  });
  it("ends at 100, scales a reported cap and refuses scores above it", () => {
    expect(run([observation(t0, { scores: scores(100, 40, 20) })])[0].track.ended).toBe(true);
    const scaled = run([observation(t0, { scores: scores(100, 40, 20), scoreCap: 200 })])[0].track;
    expect(scaled).toMatchObject({ highest: 50, ended: false });
    const updates = run([observation(t0), observation(t0 + 15_000, { scores: scores(101, 0, 0) })]);
    expect(updates[1].track.phase).toBe("unknown");
    expect(updates[1].track.round).toEqual(updates[0].track.round);
    expect(updates[1].track.last).toEqual(updates[0].track.last);
  });
  it("settles a live round 30 seconds after its last boundary signal", () => {
    const updates = run([
      observation(t0, { scores: scores(40, 0, 0) }),
      observation(t0 + 15_000, { scores: scores(0, 0, 0) }),
    ]);
    expect(roundSettled(updates[1].track, t0 + 30_000)).toBe(false);
    expect(roundSettled(updates[1].track, t0 + 45_000)).toBe(true);
    const waiting = run([observation(t0, { players: { current: 1, max: 100 }, scores: scores(0, 0, 0) })]);
    expect(roundSettled(waiting[0].track, t0 + 600_000)).toBe(false);
  });
  it("keeps the community round rule unchanged", () => {
    const status = { map: "Kavkazi", factionScores: scores(10, 5, 0) };
    expect(changedRound(status, { ...status, factionScores: scores(0, 0, 0) })).toBe(true);
    expect(changedRound(status, { ...status, factionScores: scores(4, 5, 0) })).toBe(false);
    expect(changedRound({ ...status, matchSeconds: 600 }, { ...status, matchSeconds: 10 })).toBe(true);
  });
});
