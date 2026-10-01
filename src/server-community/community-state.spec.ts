import {
  initialCommunityState,
  MAX_ROSTER,
  observeCommunity,
  plainLabel,
  statusCard,
  type CommunitySnapshot,
} from "./community-state";

const id = "76561198000000001";
function snapshot(ids = [id], status: Partial<CommunitySnapshot["status"]> = {}): CommunitySnapshot {
  return {
    observedAt: "2026-09-30T12:00:00Z",
    capabilities: { routes: [] },
    players: ids.map((steamId) => ({ steamId, name: "Player" })),
    status: {
      serverName: "The UNCs",
      map: "Kavkazi",
      players: { current: ids.length, max: 100 },
      factionScores: [{ name: "Lonestar", score: 20 }],
      ...status,
    },
  };
}

describe("community observation semantics", () => {
  it("baselines existing players and ignores a long observation gap", () => {
    const first = observeCommunity(initialCommunityState(), snapshot(), 1_000);
    expect(first).toMatchObject({ joined: [], round: false, baseline: true });
    const resumed = observeCommunity(first.state, snapshot([id, "76561198000000002"], { map: "Europe" }), 40_000);
    expect(resumed).toMatchObject({ joined: [], round: false, baseline: true });
  });

  it("recognizes a new SteamID once, independent of names", () => {
    const first = observeCommunity(initialCommunityState(), snapshot([]), 1_000);
    const joined = observeCommunity(first.state, snapshot(), 6_000);
    expect(joined.joined).toEqual([id]);
    const renamed = snapshot();
    renamed.players[0].name = "A new clan tag";
    expect(observeCommunity(joined.state, renamed, 11_000).joined).toEqual([]);
  });

  it("does not welcome everyone again after an empty map-loading roster", () => {
    let state = observeCommunity(initialCommunityState(), snapshot(), 1_000).state;
    state = observeCommunity(state, snapshot([], { map: "Europe" }), 6_000).state;
    state = observeCommunity(state, snapshot([], { map: "Europe" }), 21_000).state;
    const returned = observeCommunity(state, snapshot([id], { map: "Europe" }), 36_000);
    expect(returned.joined).toEqual([]);
    expect(returned.round).toBe(true);
  });

  it("treats a player absent for a minute as a new session", () => {
    let state = observeCommunity(initialCommunityState(), snapshot(), 1_000).state;
    for (const time of [16_000, 31_000, 46_000, 61_000]) state = observeCommunity(state, snapshot([]), time).state;
    expect(observeCommunity(state, snapshot(), 66_000).joined).toEqual([id]);
  });

  it("baselines players returning after a map load longer than the ordinary leave grace", () => {
    let state = observeCommunity(initialCommunityState(), snapshot(), 1_000).state;
    for (const time of [6_000, 21_000, 36_000, 51_000, 66_000, 81_000, 96_000])
      state = observeCommunity(state, snapshot([], { map: "Europe" }), time).state;
    const returned = observeCommunity(state, snapshot([id, "76561198000000002"], { map: "Europe" }), 101_000);
    expect(returned.joined).toEqual([]);
    expect(returned.round).toBe(true);
  });

  it("also baselines returning players when the new map is not exposed until loading finishes", () => {
    let state = observeCommunity(initialCommunityState(), snapshot(), 1_000).state;
    for (const time of [6_000, 21_000, 36_000, 51_000, 66_000, 81_000, 96_000])
      state = observeCommunity(state, snapshot([]), time).state;
    const returned = observeCommunity(state, snapshot([id], { map: "Europe" }), 101_000);
    expect(returned.joined).toEqual([]);
    expect(returned.round).toBe(true);
  });

  it("keeps the pre-travel roster when players return in waves near the hold deadline", () => {
    const other = "76561198000000002";
    let state = observeCommunity(initialCommunityState(), snapshot([id, other]), 1_000).state;
    for (let time = 6_000; time <= 171_000; time += 15_000)
      state = observeCommunity(state, snapshot([], { map: "Europe" }), time).state;
    const firstWave = observeCommunity(state, snapshot([id], { map: "Europe" }), 176_000);
    expect(firstWave.joined).toEqual([]);
    expect(observeCommunity(firstWave.state, snapshot([id, other], { map: "Europe" }), 181_000).joined).toEqual([]);
  });

  it("does not welcome players from a stale roster when status says the server is empty", () => {
    const before = observeCommunity(initialCommunityState(), snapshot([]), 1_000);
    const inconsistent = snapshot([id], { players: { current: 0, max: 100 } });
    expect(observeCommunity(before.state, inconsistent, 6_000).joined).toEqual([]);
  });

  it("does not announce an ordinary score decrease, or a reset contradicted by an increasing clock", () => {
    const first = snapshot([id], { factionScores: [{ name: "Lonestar", score: 1000 }], matchSeconds: 100 });
    const before = observeCommunity(initialCommunityState(), first, 1_000);
    for (const score of [999, 0])
      expect(
        observeCommunity(
          before.state,
          snapshot([id], {
            factionScores: [{ name: "Lonestar", score }],
            matchSeconds: 105,
          }),
          6_000,
        ).round,
      ).toBe(false);
    const noClock = observeCommunity(initialCommunityState(), snapshot(), 1_000);
    expect(
      observeCommunity(noClock.state, snapshot([id], { factionScores: [{ name: "Lonestar", score: 19 }] }), 6_000)
        .round,
    ).toBe(false);
  });

  it("deduplicates score reset followed by map travel", () => {
    const before = observeCommunity(initialCommunityState(), snapshot(), 1_000);
    const reset = observeCommunity(
      before.state,
      snapshot([id], { factionScores: [{ name: "Lonestar", score: 0 }] }),
      6_000,
    );
    expect(reset.round).toBe(true);
    const travel = observeCommunity(reset.state, snapshot([id], { map: "Europe", factionScores: [] }), 11_000);
    expect(travel.round).toBe(false);
  });

  it("holds a transition while players load and expires it without a later replay", () => {
    let state = observeCommunity(initialCommunityState(), snapshot(), 1_000).state;
    const start = observeCommunity(state, snapshot([], { map: "Europe" }), 6_000);
    expect(start.round).toBe(false);
    state = start.state;
    for (let time = 21_000; time <= 201_000; time += 15_000)
      state = observeCommunity(state, snapshot([], { map: "Europe" }), time).state;
    expect(observeCommunity(state, snapshot([id], { map: "Europe" }), 206_000).round).toBe(false);
  });

  it("does not announce empty-server map changes", () => {
    const before = observeCommunity(initialCommunityState(), snapshot([]), 1_000);
    expect(observeCommunity(before.state, snapshot([], { map: "Europe" }), 6_000).state.pendingRoundAt).toBeNull();
  });

  it("uses a supplied match clock rollback but never scoreTick as a clock", () => {
    const before = observeCommunity(initialCommunityState(), snapshot([id], { matchSeconds: 500 }), 1_000);
    expect(observeCommunity(before.state, snapshot([id], { matchSeconds: 2 }), 6_000).round).toBe(true);
    const noClock = observeCommunity(
      initialCommunityState(),
      snapshot([id], { scoreTick: { current: 30, min: 18, max: 30 } }),
      1_000,
    );
    expect(
      observeCommunity(noClock.state, snapshot([id], { scoreTick: { current: 18, min: 18, max: 30 } }), 6_000).round,
    ).toBe(false);
  });

  it("does not infer a score reset from missing or changed faction data", () => {
    const before = observeCommunity(initialCommunityState(), snapshot(), 1_000);
    for (const factionScores of [[], [{ name: "Different faction", score: 0 }]])
      expect(observeCommunity(before.state, snapshot([id], { factionScores }), 6_000).round).toBe(false);
  });

  it("bounds remembered players and deduplicates identical player rows", () => {
    const ids = Array.from({ length: 700 }, (_, index) => `765611980${String(index).padStart(8, "0")}`);
    const before = observeCommunity(initialCommunityState(), snapshot([...ids, ...ids]), 1_000);
    expect(before.state.present.size).toBe(MAX_ROSTER);
  });
});

describe("Discord status content", () => {
  it("neutralizes labels and never includes player names or identifiers", () => {
    const value = snapshot([id], {
      serverName: "@everyone **boom** <@123>\nhttps://bad.example",
      map: "[visit](https://bad.example)",
      factionScores: [{ name: "<@&123>\u202ESecret", score: 4 }],
    });
    value.players[0].name = "Private player name";
    const card = statusCard(value, true);
    expect(card.content).not.toMatch(/@|https:\/\/|bad\.example|\u202E|Private player|7656119/);
    expect(card.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
    expect(plainLabel("💥\n")).toBe("Unknown");
  });

  it("does not invent time, cap or winner and marks unavailable observations", () => {
    const card = statusCard(snapshot(), false);
    expect(card.content).toContain("may be stale");
    expect(card.content).not.toMatch(/minutes|winner|100 points|Score cap/);
    expect(statusCard(null, false).content).toContain("No successful observation");
  });
});
