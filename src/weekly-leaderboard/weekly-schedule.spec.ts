import { Env } from "../env/env";
import {
  CATCH_UP_HOURS,
  isoWeekKey,
  latestSlot,
  newYorkToUtc,
  nextSlot,
  parseSlotTime,
  slotDateLabel,
  weekEndingAt,
  zoneOffset,
  type WeeklySchedule,
} from "./weekly-schedule";

const sunday: WeeklySchedule = { day: "sunday", time: "20:00" };
const at = (iso: string) => Date.parse(iso);
const hours = (window: { start: Date; end: Date }) => (window.end.getTime() - window.start.getTime()) / 3_600_000;

describe("weekly board schedule", () => {
  it("puts the default slot, Sunday 20:00 New York, at Monday 00:00 UTC in daylight time", () => {
    const slot = latestSlot(at("2026-10-05T00:30:00Z"), sunday);
    expect(new Date(slot).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(slotDateLabel(slot)).toBe("Sun, Oct 4");
    // The first possible post covers from 2026-09-28 00:00 UTC.
    expect(weekEndingAt(slot, sunday)).toEqual({
      weekKey: "2026-W40",
      start: new Date("2026-09-28T00:00:00.000Z"),
      end: new Date("2026-10-05T00:00:00.000Z"),
      since: new Date("2026-09-28T00:00:00.000Z"),
      until: new Date("2026-10-04T23:59:59.999Z"),
    });
    expect(new Date(nextSlot(at("2026-10-02T16:00:00Z"), sunday)).toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("uses standard time after November and the slot itself is the latest slot at that instant", () => {
    const slot = at("2026-11-09T01:00:00Z");
    expect(latestSlot(slot, sunday)).toBe(slot);
    expect(latestSlot(slot - 1, sunday)).toBe(at("2026-11-02T01:00:00Z"));
    expect(zoneOffset(slot)).toBe(-5 * 3_600_000);
    expect(zoneOffset(at("2026-10-05T00:00:00Z"))).toBe(-4 * 3_600_000);
    expect(newYorkToUtc(2026, 11, 8, 20, 0)).toBe(slot);
  });

  it("keeps wall-clock weeks across DST changes: 169 hours ending 2026-11-01 and 167 ending 2027-03-14", () => {
    const fallBack = weekEndingAt(latestSlot(at("2026-11-02T02:00:00Z"), sunday), sunday);
    expect(fallBack.end.toISOString()).toBe("2026-11-02T01:00:00.000Z");
    expect(fallBack.start.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(hours(fallBack)).toBe(169);
    const springForward = weekEndingAt(latestSlot(at("2027-03-15T01:00:00Z"), sunday), sunday);
    expect(springForward.end.toISOString()).toBe("2027-03-15T00:00:00.000Z");
    expect(springForward.start.toISOString()).toBe("2027-03-08T01:00:00.000Z");
    expect(hours(springForward)).toBe(167);
    // Inclusive store bounds end one millisecond before the slot, so totals and shout-outs agree.
    expect(springForward.until.getTime()).toBe(springForward.end.getTime() - 1);
  });

  it("keys weeks by the ISO year and week of the slot's New York date", () => {
    expect(isoWeekKey(at("2026-10-05T00:00:00Z"))).toBe("2026-W40");
    // Sunday 2027-01-03 belongs to the last ISO week of 2026.
    expect(isoWeekKey(at("2027-01-04T01:00:00Z"))).toBe("2026-W53");
    expect(isoWeekKey(at("2027-01-11T01:00:00Z"))).toBe("2027-W01");
    // ISO weeks run Monday to Sunday, so moving the post day within the week keeps the key.
    const monday = latestSlot(at("2026-09-29T12:00:00Z"), { day: "monday", time: "09:30" });
    expect(new Date(monday).toISOString()).toBe("2026-09-28T13:30:00.000Z");
    expect(isoWeekKey(monday)).toBe("2026-W40");
  });

  it("finds the latest slot for any configured weekday and time", () => {
    const schedule: WeeklySchedule = { day: "wednesday", time: "23:45" };
    expect(new Date(latestSlot(at("2026-10-02T12:00:00Z"), schedule)).toISOString()).toBe("2026-10-01T03:45:00.000Z");
    expect(new Date(nextSlot(at("2026-10-02T12:00:00Z"), schedule)).toISOString()).toBe("2026-10-08T03:45:00.000Z");
    expect(new Date(latestSlot(at("2026-10-05T03:59:00Z"), { day: "sunday", time: "00:00" })).toISOString()).toBe(
      "2026-10-04T04:00:00.000Z",
    );
  });

  it("rejects 01:00-02:59, where a DST change could skip or repeat the slot, and malformed times", () => {
    const time = Env.shape.WEEKLY_LEADERBOARD_TIME;
    for (const value of ["01:00", "01:30", "02:00", "02:59", "24:00", "8:00", "20:0", "20:00 "]) {
      expect(time.safeParse(value).success).toBe(false);
      expect(() => parseSlotTime(value)).toThrow();
    }
    for (const value of ["00:00", "00:59", "03:00", "20:00", "23:59"]) expect(time.safeParse(value).success).toBe(true);
    expect(time.parse(undefined)).toBe("20:00");
    expect(Env.shape.WEEKLY_LEADERBOARD_DAY.parse(undefined)).toBe("sunday");
    expect(Env.shape.WEEKLY_LEADERBOARD_DAY.safeParse("Sunday").success).toBe(false);
    expect(Env.shape.WEEKLY_LEADERBOARD_ENABLED.parse(undefined)).toBe(false);
    expect(Env.shape.WEEKLY_LEADERBOARD_MIN_KILLS.parse(undefined)).toBe(100);
    expect(Env.shape.WEEKLY_LEADERBOARD_MIN_PLAYERS.parse(undefined)).toBe(10);
    expect(Env.shape.WEEKLY_LEADERBOARD_MIN_PLAYERS.safeParse("4").success).toBe(false);
    expect(Env.shape.WEEKLY_LEADERBOARD_MIN_KILLS.safeParse("0").success).toBe(false);
    expect(CATCH_UP_HOURS).toBe(6);
  });
});
