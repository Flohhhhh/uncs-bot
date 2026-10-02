import { describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../../../../../src/common/server-settings";
import { nextRoundSummary, roundLabel, type RotationSnapshot } from "./next-round";

const entries = [
  { map: "Kavkazi", experiences: ["Bakurani_KOTH_01"], lighting: "DayLateGray" },
  {
    map: "Europe",
    experiences: ["KOTH"],
    zoneAlternator: "ZoneAlternator.Ozeti.Farmland.Circle",
    lighting: "DayClear",
  },
  { map: "NorthAmerica", experiences: [], zoneAlternator: "None" },
];
function rotation(overrides: Partial<RotationSnapshot> = {}): RotationSnapshot {
  return {
    entries,
    editable: true,
    note: "",
    currentIndex: 0,
    nextIndex: 1,
    positionNote: "",
    currentMap: "Kavkazi",
    enabled: true,
    mode: "Ordered",
    ...overrides,
  };
}

describe("roundLabel", () => {
  it("reads map, mode, zone layout and lighting with one separator per part", () => {
    expect(roundLabel(entries[1])).toBe("Ozeti · King of the Hill · Farmland · Day clear");
    expect(roundLabel(entries[0])).toBe("Bakurani · King of the Hill · Late day overcast");
  });
  it("leaves out the map's default zone layout and missing details", () => {
    expect(roundLabel(entries[2])).toBe("Zestafona");
  });
});

describe("nextRoundSummary", () => {
  it("is unavailable without a rotation", () => {
    for (const source of [null, undefined])
      expect(nextRoundSummary(source)).toEqual({
        state: "unavailable",
        entry: null,
        index: null,
        label: "Unavailable",
        note: "",
      });
  });

  it("names the entry after the running one in an ordered rotation", () => {
    expect(nextRoundSummary(rotation())).toEqual({
      state: "saved",
      entry: entries[1],
      index: 1,
      label: "Ozeti · King of the Hill · Farmland · Day clear",
      note: "",
    });
  });

  it("wraps from the last entry to the first", () => {
    const summary = nextRoundSummary(rotation({ currentIndex: 2, nextIndex: 3, currentMap: "Zestafona" }));
    expect(summary).toMatchObject({ state: "saved", index: 0, entry: entries[0] });
  });

  it("accepts the whole settings snapshot", () => {
    const snapshot = { revision: "r1", rotation: rotation() } as SettingsSnapshot;
    expect(nextRoundSummary(snapshot)).toMatchObject({ state: "saved", index: 1 });
  });

  it("uses the game's own next entry when no running entry is known", () => {
    const positionNote = "This match was not started from the rotation, so the game will play entry 3 next.";
    expect(nextRoundSummary(rotation({ currentIndex: null, nextIndex: 2, positionNote }))).toEqual({
      state: "game-next",
      entry: entries[2],
      index: 2,
      label: "Zestafona",
      note: positionNote,
    });
  });

  it("does not trust a running entry whose map is not the one being played", () => {
    expect(nextRoundSummary(rotation({ currentMap: "Europe" }))).toMatchObject({
      state: "unconfirmed",
      entry: null,
      label: "Not confirmed",
    });
  });

  it("stays unconfirmed when the game names no usable entry", () => {
    const positionNote = "The game has not identified one current or next rotation entry.";
    expect(nextRoundSummary(rotation({ currentIndex: null, nextIndex: null, positionNote }))).toEqual({
      state: "unconfirmed",
      entry: null,
      index: null,
      label: "Not confirmed",
      note: positionNote,
    });
    expect(nextRoundSummary(rotation({ currentIndex: null, nextIndex: 7 }))).toMatchObject({ state: "unconfirmed" });
    expect(nextRoundSummary(rotation({ currentIndex: 7, nextIndex: 8 }))).toMatchObject({ state: "unconfirmed" });
  });

  it("has no fixed next round when the rotation is off, random or empty", () => {
    for (const changes of [
      { enabled: false },
      { mode: "Random" },
      { entries: [], currentIndex: null, nextIndex: null },
    ])
      expect(nextRoundSummary(rotation(changes))).toMatchObject({
        state: "unconfirmed",
        entry: null,
        index: null,
        label: "No fixed next round",
      });
  });
});
