import { roundStamp, sameRound } from "../common/game-round";

it("compares verified map aliases while retaining the clock and different-map guards", () => {
  const before = roundStamp({ map: "Europe", matchSeconds: 60 }, 100_000)!;
  expect(sameRound(before, roundStamp({ map: "Ozeti", matchSeconds: 65 }, 105_000)!)).toBe(true);
  expect(sameRound(before, roundStamp({ map: "Ozeti", matchSeconds: 1 }, 105_000)!)).toBe(false);
  expect(sameRound(before, { ...before, map: "Kavkazi" })).toBe(false);
  expect(sameRound(before, { ...before, map: "Ozeti Night" })).toBe(false);
  expect(sameRound({ ...before, map: "Unknown map" }, { ...before, map: "Other map" })).toBe(false);
});
