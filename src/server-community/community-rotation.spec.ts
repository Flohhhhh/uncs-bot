import { CommunityRotation, MAX_REMEMBERED_PLAYERS } from "./community-rotation";

/** Small deterministic PRNG (mulberry32) so the property-style checks are repeatable. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const player = (index: number) => `765611980${String(index).padStart(8, "0")}`;

describe("community message rotation", () => {
  it("always uses a single configured entry without consulting the random source", () => {
    const random = jest.fn(() => 0.5);
    const rotation = new CommunityRotation(random);
    for (let index = 0; index < 5; index++) {
      expect(rotation.welcome(player(0), 1)).toBe(0);
      expect(rotation.round(1)).toBe(0);
    }
    expect(random).not.toHaveBeenCalled();
  });

  it("never gives a returning player the variant they got last time", () => {
    // The random source always prefers the first candidate, so only the exclusion can move the choice.
    const rotation = new CommunityRotation(() => 0);
    expect([0, 1, 2, 3].map(() => rotation.welcome(player(1), 2))).toEqual([0, 1, 0, 1]);
  });

  it("with two variants, avoids only the player's own repeat so new players still get either one", () => {
    const rotation = new CommunityRotation(() => 0);
    expect(rotation.welcome(player(1), 2)).toBe(0);
    expect(rotation.welcome(player(2), 2)).toBe(0);
  });

  it("with three or more variants, also avoids the previous joiner's variant", () => {
    const rotation = new CommunityRotation(() => 0);
    expect([1, 2, 3, 4].map((index) => rotation.welcome(player(index), 3))).toEqual([0, 1, 0, 1]);
    // Player 1 last got 0 and the previous joiner got 1, so only 2 remains.
    expect(rotation.welcome(player(1), 3)).toBe(2);
  });

  it.each([3, 8, 20])("never repeats for a player or between consecutive joins with %i variants", (count) => {
    const rotation = new CommunityRotation(seeded(count));
    const last = new Map<string, number>();
    let previous: number | null = null;
    const seen = new Set<number>();
    for (let join = 0; join < 2_000; join++) {
      const steamId = player(join % 7 === 0 ? 0 : join % 13);
      const index = rotation.welcome(steamId, count);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(count);
      expect(index).not.toBe(last.get(steamId));
      expect(index).not.toBe(previous);
      last.set(steamId, index);
      previous = index;
      seen.add(index);
    }
    expect(seen.size).toBe(count);
  });

  it("forgets the oldest remembered players beyond its bound", () => {
    const rotation = new CommunityRotation(() => 0, 2);
    expect(rotation.welcome(player(1), 2)).toBe(0);
    rotation.welcome(player(2), 2);
    rotation.welcome(player(3), 2);
    // Player 1 was evicted, so the always-first random source may choose 0 again.
    expect(rotation.welcome(player(1), 2)).toBe(0);
    expect(MAX_REMEMBERED_PLAYERS).toBeGreaterThanOrEqual(512);
  });

  it("never repeats the previous round's message", () => {
    const first = new CommunityRotation(() => 0);
    expect([0, 1, 2, 3].map(() => first.round(5))).toEqual([0, 1, 0, 1]);
    const random = seeded(42);
    const rotation = new CommunityRotation(random);
    let previous = rotation.round(5);
    for (let round = 0; round < 500; round++) {
      const next = rotation.round(5);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("keeps each welcome pool's player and previous-joiner history separate", () => {
    const rotation = new CommunityRotation(() => 0);
    expect(rotation.welcome(player(1), 3, "whitelisted")).toBe(0);
    // The standard pool has not seen player 1 or any joiner yet.
    expect(rotation.welcome(player(1), 3)).toBe(0);
    expect(rotation.welcome(player(2), 3, "standard")).toBe(1);
    // Player 1 last got 0 from the whitelisted pool, and that pool's previous choice was also 0.
    expect(rotation.welcome(player(1), 3, "whitelisted")).toBe(1);
    expect(rotation.welcome(player(3), 3, "whitelisted")).toBe(0);
  });

  it.each([3, 8])("never repeats within either pool when joins alternate between pools with %i variants", (count) => {
    const rotation = new CommunityRotation(seeded(count + 100));
    const last = { standard: new Map<string, number>(), whitelisted: new Map<string, number>() };
    const previous: Record<keyof typeof last, number | null> = { standard: null, whitelisted: null };
    for (let join = 0; join < 2_000; join++) {
      const pool = join % 3 === 0 ? "whitelisted" : "standard";
      const steamId = player(join % 11);
      const index = rotation.welcome(steamId, count, pool);
      expect(index).not.toBe(last[pool].get(steamId));
      expect(index).not.toBe(previous[pool]);
      last[pool].set(steamId, index);
      previous[pool] = index;
    }
  });

  it("bounds each pool's remembered players separately", () => {
    const rotation = new CommunityRotation(() => 0, 1);
    expect(rotation.welcome(player(1), 2, "whitelisted")).toBe(0);
    rotation.welcome(player(2), 2);
    rotation.welcome(player(3), 2);
    // Standard-pool joins do not evict player 1 from the whitelisted pool.
    expect(rotation.welcome(player(1), 2, "whitelisted")).toBe(1);
  });

  it("keeps welcome and round history separate", () => {
    const rotation = new CommunityRotation(() => 0);
    expect(rotation.round(3)).toBe(0);
    expect(rotation.welcome(player(1), 3)).toBe(0);
    expect(rotation.round(3)).toBe(1);
  });

  it.each([1, 1.5, -0.25, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps choices in range for an out-of-contract random value: %p",
    (value) => {
      const rotation = new CommunityRotation(() => value);
      for (let join = 0; join < 10; join++) {
        const index = rotation.welcome(player(join), 4);
        expect(Number.isInteger(index) && index >= 0 && index < 4).toBe(true);
      }
    },
  );
});
