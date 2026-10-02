import {
  formatDuration,
  formatLocal,
  localInstant,
  localParts,
  parseClock,
  parseClockList,
  parseWindows,
  scheduledMatch,
  validTimeZone,
  windowAt,
} from "./local-time";

const zone = "America/New_York";
const at = (iso: string) => Date.parse(iso);

describe("staff alert local time", () => {
  it("parses clocks and windows, rejecting invalid ones", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    for (const bad of ["24:00", "7:00", "12:60", "noon", ""]) expect(parseClock(bad)).toBeNull();
    expect(parseWindows("17:00-23:00")).toEqual([{ start: 1020, end: 1380 }]);
    expect(parseWindows(" 17:00-23:00 , 06:00-08:00 ")).toEqual([
      { start: 1020, end: 1380 },
      { start: 360, end: 480 },
    ]);
    expect(parseWindows("")).toEqual([]);
    for (const bad of ["17:00", "17:00-17:00", "17:00-25:00", "1-2-3", "a-b"]) expect(parseWindows(bad)).toBeNull();
    expect(parseWindows("01:00-02:00,03:00-04:00,05:00-06:00,07:00-08:00,09:00-10:00")).toBeNull();
    expect(parseClockList("04:00,16:00")).toEqual([240, 960]);
    expect(parseClockList("")).toEqual([]);
    expect(parseClockList("04:00,04:00")).toBeNull();
    expect(parseClockList("01:00,02:00,03:00,04:00,05:00,06:00,07:00")).toBeNull();
  });

  it("rejects an invalid time zone", () => {
    expect(validTimeZone("America/New_York")).toBe(true);
    expect(validTimeZone("UTC")).toBe(true);
    expect(validTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(validTimeZone("")).toBe(false);
  });

  it("finds prime-time windows, including ones that cross midnight", () => {
    const prime = parseWindows("17:00-23:00")!;
    // 2026-10-02 is EDT (UTC-4): 17:00 local is 21:00Z.
    expect(windowAt(at("2026-10-02T20:59:00Z"), prime, zone)).toBeNull();
    expect(windowAt(at("2026-10-02T21:30:00Z"), prime, zone)).toMatchObject({
      date: "2026-10-02",
      start: at("2026-10-02T21:00:00Z"),
    });
    expect(windowAt(at("2026-10-03T03:00:00Z"), prime, zone)).toBeNull();
    const late = parseWindows("22:00-02:00")!;
    expect(windowAt(at("2026-10-03T03:00:00Z"), late, zone)).toMatchObject({
      date: "2026-10-02",
      start: at("2026-10-03T02:00:00Z"),
    });
    // 01:30 local on Oct 3 still belongs to the window that started on Oct 2.
    expect(windowAt(at("2026-10-03T05:30:00Z"), late, zone)).toMatchObject({ date: "2026-10-02" });
    expect(windowAt(at("2026-10-03T06:30:00Z"), late, zone)).toBeNull();
  });

  it("follows the 2026 daylight-saving changes in America/New_York", () => {
    const prime = parseWindows("17:00-23:00")!;
    // March 7 is EST (17:00 = 22:00Z); March 8 is EDT (17:00 = 21:00Z).
    expect(windowAt(at("2026-03-07T21:30:00Z"), prime, zone)).toBeNull();
    expect(windowAt(at("2026-03-08T21:30:00Z"), prime, zone)).toMatchObject({ start: at("2026-03-08T21:00:00Z") });
    // October 31 is EDT; November 1 is EST again (17:00 = 22:00Z).
    expect(windowAt(at("2026-10-31T21:30:00Z"), prime, zone)).toMatchObject({ start: at("2026-10-31T21:00:00Z") });
    expect(windowAt(at("2026-11-01T21:30:00Z"), prime, zone)).toBeNull();
    expect(windowAt(at("2026-11-01T22:30:00Z"), prime, zone)).toMatchObject({ start: at("2026-11-01T22:00:00Z") });
    expect(localInstant("2026-03-08", 1020, zone)).toBe(at("2026-03-08T21:00:00Z"));
    expect(localInstant("2026-11-01", 1020, zone)).toBe(at("2026-11-01T22:00:00Z"));
    // Midnight uses hour 00, never 24.
    expect(localParts(at("2026-11-01T04:30:00Z"), zone)).toMatchObject({ date: "2026-11-01", minutes: 30 });
    expect(formatLocal(at("2026-03-08T09:00:00Z"), zone)).toBe("05:00 ET");
    expect(formatLocal(at("2026-03-08T06:59:00Z"), zone)).toBe("01:59 ET");
    expect(formatLocal(at("2026-10-02T08:00:00Z"), zone)).toBe("04:00 ET");
  });

  it("matches scheduled restarts within 20 minutes, across midnight", () => {
    const scheduled = parseClockList("04:00,23:50")!;
    expect(scheduledMatch(at("2026-10-02T08:00:00Z"), scheduled, zone)).toBe(240);
    expect(scheduledMatch(at("2026-10-02T08:19:00Z"), scheduled, zone)).toBe(240);
    expect(scheduledMatch(at("2026-10-02T07:41:00Z"), scheduled, zone)).toBe(240);
    expect(scheduledMatch(at("2026-10-02T08:21:00Z"), scheduled, zone)).toBeNull();
    // 00:05 local is 15 minutes after 23:50.
    expect(scheduledMatch(at("2026-10-03T04:05:00Z"), scheduled, zone)).toBe(1430);
    expect(scheduledMatch(at("2026-10-02T08:00:00Z"), [], zone)).toBeNull();
  });

  it("formats durations for alert text", () => {
    expect(formatDuration(30_000)).toBe("under 1 min");
    expect(formatDuration(42 * 60_000)).toBe("42 min");
    expect(formatDuration((10 * 60 + 23) * 60_000)).toBe("10 h 23 min");
  });
});
