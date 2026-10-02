// Pure local-time helpers for staff alerts. Intl with hourCycle h23 keeps midnight at 00 and
// follows daylight-saving changes without a time-zone library.

export type LocalWindow = { start: number; end: number };
export const MINUTES_PER_DAY = 1440;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validTimeZone(value: string) {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight for "HH:MM", or null. */
export function parseClock(value: string) {
  const match = CLOCK.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
export function formatClock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A comma-separated list of "HH:MM" (at most `max`), or null when any entry is invalid. */
export function parseClockList(value: string, max = 6) {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length > max) return null;
  const minutes = items.map(parseClock);
  if (minutes.some((item) => item === null) || new Set(minutes).size !== minutes.length) return null;
  return minutes as number[];
}

/** "HH:MM-HH:MM" windows (at most `max`); a window may cross midnight. "" means none; null when invalid. */
export function parseWindows(value: string, max = 4): LocalWindow[] | null {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length > max) return null;
  const windows: LocalWindow[] = [];
  for (const item of items) {
    const [from, to, extra] = item.split("-");
    const start = parseClock(from ?? ""),
      end = parseClock(to ?? "");
    if (extra !== undefined || start === null || end === null || start === end) return null;
    windows.push({ start, end });
  }
  return windows;
}
export function formatWindow(window: LocalWindow) {
  return `${formatClock(window.start)}-${formatClock(window.end)}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

/** The local calendar date ("YYYY-MM-DD") and minutes after local midnight at an instant. */
export function localParts(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
    wall: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute)),
    seconds: Number(parts.second),
  };
}
function offset(at: number, timeZone: string) {
  const parts = localParts(at, timeZone);
  return parts.wall + parts.seconds * 1000 - Math.floor(at / 1000) * 1000;
}
function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The instant of a local wall-clock time on a local date. A time skipped by DST lands just after the jump. */
export function localInstant(date: string, minutes: number, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let at = wall - offset(wall, timeZone);
  at = wall - offset(at, timeZone);
  return at;
}

/** The window occurrence that contains `at`: its start instant and the local date it started on. */
export function windowAt(at: number, windows: LocalWindow[], timeZone: string) {
  const local = localParts(at, timeZone);
  for (const window of windows) {
    const crosses = window.end < window.start;
    const inside = crosses
      ? local.minutes >= window.start || local.minutes < window.end
      : local.minutes >= window.start && local.minutes < window.end;
    if (!inside) continue;
    const date = crosses && local.minutes < window.end ? shiftDate(local.date, -1) : local.date;
    return { date, start: Math.min(at, localInstant(date, window.start, timeZone)), window };
  }
  return null;
}

/** The scheduled local restart time within `tolerance` minutes of `at`, or null. */
export function scheduledMatch(at: number, scheduled: number[], timeZone: string, tolerance = 20) {
  const { minutes } = localParts(at, timeZone);
  return (
    scheduled.find((entry) => {
      const difference = Math.abs(minutes - entry);
      return Math.min(difference, MINUTES_PER_DAY - difference) <= tolerance;
    }) ?? null
  );
}

/** "04:00 ET": local time with a short zone label (US zones as ET, CT, MT or PT). */
export function formatLocal(at: number, timeZone: string) {
  const { minutes } = localParts(at, timeZone);
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  const label = /^([ECMP])[SD]T$/.test(name) ? `${name[0]}T` : name;
  return `${formatClock(minutes)} ${label}`;
}

/** "10 h 23 min", "42 min" or "under 1 min". */
export function formatDuration(milliseconds: number) {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "under 1 min";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
