import { GameRounds, DEFAULT_START_THRESHOLD } from "./game-rounds";
import { fixtureServers } from "./game-server-fixture";
import type { Overview } from "./wardogs.client";

const t0 = Date.parse("2026-10-02T12:00:00Z");
function overview(at: number, patch: Partial<Overview["status"]> = {}) {
  return {
    observedAt: new Date(at).toISOString(),
    status: {
      serverName: "The UNCs",
      map: "Kavkazi",
      rotation: { nowIndex: 0, nextIndex: 1 },
      players: { current: 60, max: 100 },
      factionScores: [
        { name: "Lonestar", score: 40 },
        { name: "Manticore", score: 20 },
      ],
      ...patch,
    },
  } as Pick<Overview, "status" | "observedAt">;
}
const fields = (value: number | null) => [
  { id: "minRequiredPlayers", value, editable: true, note: "", state: "applied" },
];
function fixture() {
  let endpoint = "https://game.example.test";
  const rounds = new GameRounds(fixtureServers({}, () => endpoint));
  return { rounds, move: (url: string) => (endpoint = url) };
}

describe("shared game round state", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(t0));
  afterEach(() => jest.useRealTimers());
  it("decides each shared status read once", () => {
    const { rounds } = fixture();
    rounds.observe(
      "primary",
      overview(t0, {
        factionScores: [
          { name: "Lonestar", score: 40 },
          { name: "Manticore", score: 20 },
        ],
      }),
    );
    const reset = overview(t0 + 15_000, {
      factionScores: [
        { name: "Lonestar", score: 0 },
        { name: "Manticore", score: 0 },
      ],
    });
    expect(rounds.observe("primary", reset)).toMatchObject({ boundary: true, reason: "reset" });
    const again = rounds.observe("primary", reset);
    expect(again).toMatchObject({ boundary: false, reason: null });
    expect(again.track).toEqual(rounds.current("primary"));
    // An older read never rewinds the shared state.
    expect(rounds.observe("primary", overview(t0 + 5_000)).track).toEqual(rounds.current("primary"));
  });
  it("applies a stored seed only when empty or after a gap", () => {
    const { rounds } = fixture();
    const seed = {
      round: {
        id: "observed:42",
        map: "Kavkazi",
        index: 0,
        startedAt: t0 - 300_000,
        source: "observed" as const,
        exact: true,
      },
      highest: 35,
    };
    expect(rounds.observe("primary", overview(t0), { seed }).track.round.id).toBe("observed:42");
    const other = { ...seed, round: { ...seed.round, id: "observed:99" } };
    expect(rounds.observe("primary", overview(t0 + 15_000), { seed: other }).track.round.id).toBe("observed:42");
    expect(rounds.observe("primary", overview(t0 + 120_000), { seed: other }).track.round.id).toBe("observed:99");
  });
  it("adopts the other worker's matching stored round after a restart, even from a repeated read", () => {
    const { rounds } = fixture();
    const stale = {
      round: {
        id: "observed:7",
        map: "Europe",
        index: 2,
        startedAt: t0 - 3600_000,
        source: "observed" as const,
        exact: true,
      },
      highest: 90,
    };
    // The voting worker's older ballot does not match the running round: a baseline round, start unknown.
    const first = rounds.observe("primary", overview(t0), { seed: stale }).track;
    expect(first).toMatchObject({ unseeded: true, round: { source: "baseline" } });
    const event = {
      round: {
        id: "observed:42",
        map: "Kavkazi",
        index: 0,
        startedAt: t0 - 300_000,
        source: "observed" as const,
        exact: true,
      },
      highest: 35,
    };
    // The event worker reads the same cached status with its own stored round.
    const adopted = rounds.observe("primary", overview(t0), { seed: event }).track;
    expect(adopted.round).toMatchObject({ id: "observed:42", startedAt: t0 - 300_000, exact: false });
    expect(adopted.unseeded).toBeUndefined();
    expect(rounds.current("primary")?.round.id).toBe("observed:42");
    expect(rounds.observe("primary", overview(t0 + 15_000), { seed: stale }).track.round.id).toBe("observed:42");
  });
  it.each([
    ["another map", { map: "Europe" }, 35],
    ["another rotation entry", { index: 3 }, 35],
    ["a later start", { startedAt: t0 + 120_000 }, 35],
    ["a score reset since", {}, 60],
  ])("does not adopt a stored round from %s", (_, patch, highest) => {
    const { rounds } = fixture();
    rounds.observe("primary", overview(t0));
    const seed = {
      round: {
        id: "observed:42",
        map: "Kavkazi",
        index: 0,
        startedAt: t0 - 300_000,
        source: "observed" as const,
        exact: true,
        ...patch,
      },
      highest,
    };
    expect(rounds.observe("primary", overview(t0 + 15_000), { seed }).track.round.source).toBe("baseline");
  });
  it("adopts a stored round only for a clock round first seen already running, with a matching start", () => {
    const { rounds } = fixture();
    const clocked = (at: number) => overview(at, { matchSeconds: (at - (t0 - 300_000)) / 1000 });
    expect(rounds.observe("primary", clocked(t0)).track).toMatchObject({ unseeded: true, round: { source: "clock" } });
    const seed = {
      round: {
        id: "observed:42",
        map: "Kavkazi",
        index: 0,
        startedAt: t0 - 290_000,
        source: "observed" as const,
        exact: true,
      },
      highest: 35,
    };
    const adopted = rounds.observe("primary", clocked(t0 + 5_000), { seed }).track;
    expect(adopted.round).toMatchObject({ id: "observed:42", source: "clock", exact: true, startedAt: t0 - 300_000 });
  });
  it("previews without recording", () => {
    const { rounds } = fixture();
    expect(rounds.peek("primary", overview(t0)).track.round.source).toBe("baseline");
    expect(rounds.current("primary")).toBeNull();
  });
  it("reads the game's start threshold, caches it for five minutes and falls back to 20", () => {
    const { rounds } = fixture();
    expect(rounds.threshold("primary")).toBe(DEFAULT_START_THRESHOLD);
    expect(rounds.threshold("primary", fields(null))).toBe(20);
    expect(rounds.threshold("primary", fields(30))).toBe(30);
    expect(rounds.threshold("primary")).toBe(30);
    expect(
      rounds.observe(
        "primary",
        overview(t0, {
          players: { current: 25, max: 100 },
          factionScores: [
            { name: "A", score: 0 },
            { name: "B", score: 0 },
          ],
        }),
      ).track.phase,
    ).toBe("waiting");
    jest.setSystemTime(t0 + 301_000);
    expect(rounds.threshold("primary")).toBe(20);
  });
  it("starts over when the server connection changes", () => {
    const { rounds, move } = fixture();
    const first = rounds.observe("primary", overview(t0)).track;
    move("https://other.example.test");
    const next = rounds.observe("primary", overview(t0 + 15_000)).track;
    expect(next.firstSeenAt).toBe(t0 + 15_000);
    expect(next.round.id).not.toBe(first.round.id);
    rounds.clear("primary");
    expect(rounds.current("primary")).toBeNull();
  });
});
