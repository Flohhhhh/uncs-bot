/**
 * Pure schedule arithmetic for the weekly Discord board. A slot is the configured weekday and time as
 * New York wall-clock time; a week is the span from the previous slot up to (not including) the next.
 * No dependency beyond Intl: the offset is read from formatToParts and applied twice, which is exact
 * for any wall time outside 01:00–02:59, the only hours a New York DST change can skip or repeat.
 */
export const TIME_ZONE = "America/New_York";
/** A slot is acted on only within this many hours after it; older slots are a missed posting window. */
export const CATCH_UP_HOURS = 6;
export const CATCH_UP_MS = CATCH_UP_HOURS * 3_600_000;
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const SLOT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 01:00–02:59 can fall in a DST gap or overlap, so a slot there could be skipped or doubled. */
export const DST_HOURS = /^0[12]:/;

export type WeeklySchedule = { day: Weekday; time: string };
export type WeekWindow = {
  weekKey: string;
  /** Previous slot, inclusive. */
  start: Date;
  /** This week's slot, exclusive. */
  end: Date;
  /** Inclusive store bounds: since = start, until = end − 1 ms. */
  since: Date;
  until: Date;
};

const DAY_MS = 86_400_000;
const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** New York wall-clock fields for an instant. */
export function wallTime(instant: number): WallTime {
  const values: Record<string, number> = {};
  for (const part of parts.formatToParts(new Date(instant)))
    if (part.type !== "literal") values[part.type] = Number(part.value);
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Wall time minus UTC at an instant, in milliseconds (−4 h in EDT, −5 h in EST). */
export function zoneOffset(instant: number) {
  const wall = wallTime(instant);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const whole = instant - (((instant % 1000) + 1000) % 1000);
  return asUtc - whole;
}

/** UTC instant of a New York wall time. Day overflow (for example day 0 or 32) is normalised. */
export function newYorkToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - zoneOffset(asUtc);
  return asUtc - zoneOffset(first);
}

export function parseSlotTime(time: string) {
  if (!SLOT_TIME.test(time) || DST_HOURS.test(time))
    throw new Error("Choose a weekly board time HH:MM outside 01:00–02:59.");
  const [hour, minute] = time.split(":").map(Number);
  return { hour, minute };
}

/** The same wall-clock time a whole number of calendar days away, so DST weeks are 167 or 169 hours. */
function shiftDays(slot: number, days: number, schedule: WeeklySchedule) {
  const wall = wallTime(slot);
  const { hour, minute } = parseSlotTime(schedule.time);
  return newYorkToUtc(wall.year, wall.month, wall.day + days, hour, minute);
}

/** The latest slot at or before now. */
export function latestSlot(now: number, schedule: WeeklySchedule) {
  const { hour, minute } = parseSlotTime(schedule.time);
  const today = wallTime(now);
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const back = (weekday - WEEKDAYS.indexOf(schedule.day) + 7) % 7;
  const slot = newYorkToUtc(today.year, today.month, today.day - back, hour, minute);
  return slot <= now ? slot : shiftDays(slot, -7, schedule);
}

export const previousSlot = (slot: number, schedule: WeeklySchedule) => shiftDays(slot, -7, schedule);
export const followingSlot = (slot: number, schedule: WeeklySchedule) => shiftDays(slot, 7, schedule);
/** The first slot strictly after now. */
export const nextSlot = (now: number, schedule: WeeklySchedule) => followingSlot(latestSlot(now, schedule), schedule);

/** ISO 8601 year and week of the slot's New York date, for example 2026-W40. */
export function isoWeekKey(slot: number) {
  const wall = wallTime(slot);
  const date = Date.UTC(wall.year, wall.month - 1, wall.day);
  const isoWeekday = new Date(date).getUTCDay() || 7;
  const thursday = new Date(date + (4 - isoWeekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The completed week that ends at this slot. */
export function weekEndingAt(slot: number, schedule: WeeklySchedule): WeekWindow {
  const start = previousSlot(slot, schedule);
  return {
    weekKey: isoWeekKey(slot),
    start: new Date(start),
    end: new Date(slot),
    since: new Date(start),
    until: new Date(slot - 1),
  };
}

/** "Sun, Oct 4" for the slot's New York date. */
export function slotDateLabel(slot: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(slot));
}
