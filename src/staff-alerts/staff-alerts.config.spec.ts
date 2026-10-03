import { z } from "zod";
import { Env } from "../env/env";
import type { EnvService } from "../env/env.service";
import { settingsView, staffAlertsOptions } from "./staff-alerts.config";

const required = { DISCORD_BOT_TOKEN: "bot-secret", DATABASE_URL: "postgres://user:password@db.example.test/uncs" };
const owner = "76561198000000001",
  regular = "76561198000000002";
function parse(values: Record<string, string> = {}) {
  return Env.safeParse({ ...required, ...values });
}
function options(values: Record<string, string> = {}) {
  const parsed = parse(values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return staffAlertsOptions({ get: (key: string) => parsed.data[key as keyof Env] } as EnvService);
}

describe("staff alert settings", () => {
  it("defaults every feature off with the specified thresholds", () => {
    const parsed = parse();
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      STAFF_ALERTS_ENABLED: false,
      STAFF_ALERTS_TIME_ZONE: "America/New_York",
      STAFF_ALERTS_HEALTH_ENABLED: false,
      STAFF_ALERTS_HEALTH_DOWN_MINUTES: 10,
      STAFF_ALERTS_HEALTH_RESTART_PLAYERS: 10,
      STAFF_ALERTS_HEALTH_SCHEDULED_RESTARTS: "",
      STAFF_ALERTS_SEEDING_ENABLED: false,
      STAFF_ALERTS_SEEDING_BELOW: 1,
      STAFF_ALERTS_SEEDING_MINUTES: 30,
      STAFF_ALERTS_SEEDING_AFTER_RESTART_HOURS: 12,
      STAFF_ALERTS_SEEDING_PRIME_HOURS: "17:00-23:00",
      STAFF_ALERTS_PERFORMANCE_ENABLED: "false",
      STAFF_ALERTS_PERFORMANCE_WINDOW_MINUTES: 5,
      STAFF_ALERTS_PERFORMANCE_WINDOW_KILLS: 30,
      STAFF_ALERTS_PERFORMANCE_MATCH_KILLS: 40,
      STAFF_ALERTS_PERFORMANCE_MATCH_KD: 20,
      STAFF_ALERTS_PERFORMANCE_PLAYER_COOLDOWN_MINUTES: 360,
      STAFF_ALERTS_PERFORMANCE_MAX_PER_HOUR: 3,
      STAFF_ALERTS_PERFORMANCE_SKIP_WHITELISTED: false,
      STAFF_ALERTS_WATCHLIST_ENABLED: false,
      STAFF_ALERTS_WATCHLIST_HIGHLIGHT_COMMUNITIES: 3,
      STAFF_ALERTS_WATCHLIST_COOLDOWN_MINUTES: 360,
    });
    expect(parsed.data?.STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD).toBeUndefined();
    expect(parsed.data?.STAFF_ALERTS_WATCHLIST).toBeUndefined();
    const defaults = options();
    expect(defaults).toMatchObject({
      enabled: false,
      active: false,
      health: { enabled: false },
      seeding: { enabled: false, primeWindows: [{ start: 1020, end: 1380 }] },
      performance: { mode: "off" },
      watchlist: { enabled: false },
    });
  });

  it("keeps features off unless the master switch is on, and starts only with a feature", () => {
    expect(options({ STAFF_ALERTS_HEALTH_ENABLED: "true", STAFF_ALERTS_PERFORMANCE_ENABLED: "true" })).toMatchObject({
      active: false,
      health: { enabled: false },
      performance: { mode: "off" },
    });
    expect(options({ STAFF_ALERTS_ENABLED: "true" }).active).toBe(false);
    expect(options({ STAFF_ALERTS_ENABLED: "true", STAFF_ALERTS_PERFORMANCE_ENABLED: "observe" })).toMatchObject({
      active: true,
      performance: { mode: "observe" },
    });
    expect(
      options({
        STAFF_ALERTS_ENABLED: "true",
        STAFF_ALERTS_SEEDING_ENABLED: "true",
        STAFF_ALERTS_SEEDING_PRIME_HOURS: "",
        STAFF_ALERTS_HEALTH_SCHEDULED_RESTARTS: "04:00, 16:00",
      }),
    ).toMatchObject({ active: true, seeding: { primeWindows: [] }, health: { scheduledRestarts: [240, 960] } });
  });

  it.each([
    ["STAFF_ALERTS_TIME_ZONE", "Mars/Olympus_Mons"],
    ["STAFF_ALERTS_HEALTH_DOWN_MINUTES", "1"],
    ["STAFF_ALERTS_HEALTH_SCHEDULED_RESTARTS", "4am"],
    ["STAFF_ALERTS_SEEDING_PRIME_HOURS", "17:00"],
    ["STAFF_ALERTS_SEEDING_MINUTES", "4"],
    ["STAFF_ALERTS_PERFORMANCE_ENABLED", "yes"],
    ["STAFF_ALERTS_PERFORMANCE_MATCH_KD", "1"],
    ["STAFF_ALERTS_PERFORMANCE_WINDOW_KILLS", "9"],
    ["STAFF_ALERTS_PING_ROLE_ID", "everyone"],
  ])("rejects %s=%s", (key, value) => {
    expect(parse({ [key]: value }).success).toBe(false);
  });

  it("reports bad JSON without echoing the value", () => {
    const secret = "not-json-but-a-pasted-secret";
    for (const key of ["STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD", "STAFF_ALERTS_WATCHLIST"]) {
      const parsed = parse({ [key]: secret });
      expect(parsed.success).toBe(false);
      const message = z.prettifyError(parsed.error!);
      expect(message).toContain("Use valid JSON for this setting.");
      expect(message).not.toContain(secret);
    }
  });

  it("accepts known-good IDs and notes, but rejects duplicates and non-personal IDs", () => {
    const parsed = parse({
      STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: JSON.stringify([owner, { steamId: regular, note: "UNCs regular" }]),
    });
    expect(parsed.data?.STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD).toEqual([
      owner,
      { steamId: regular, note: "UNCs regular" },
    ]);
    expect(
      parse({ STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: JSON.stringify([owner, { steamId: owner, note: "twice" }]) })
        .success,
    ).toBe(false);
    expect(parse({ STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: JSON.stringify(["12345"]) }).success).toBe(false);
    expect(
      parse({ STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: JSON.stringify([{ steamId: owner, note: "x", role: "admin" }]) })
        .success,
    ).toBe(false);
  });

  it("starts with the documented 500 known-good entries pasted from Never flag, up to 65,536 characters", () => {
    const steamId = (index: number) => `765611980${String(index).padStart(8, "0")}`;
    const full = Array.from({ length: 500 }, (_, index) => ({
      steamId: steamId(index + 1),
      note: `never flag: ${"Grandpa Moderator Joe".padEnd(56, ".")}, 2026-10-02`,
    }));
    const value = JSON.stringify(full);
    expect(full[0].note).toHaveLength(80);
    expect(value.length).toBeGreaterThan(32_768);
    expect(
      parse({ STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: value }).data?.STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD,
    ).toHaveLength(500);
    const tooLong = `${value.slice(0, -1)}${" ".repeat(65_537 - value.length)}]`;
    expect(tooLong).toHaveLength(65_537);
    expect(parse({ STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: tooLong }).success).toBe(false);
    expect(parse({ STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: tooLong.replace(" ", "") }).success).toBe(true);
  });

  it("validates watch-list entries strictly", () => {
    const entry = {
      steamId: owner,
      reason: "Aimbot",
      evidenceUrl: "https://example.com/clip",
      communities: 4,
      recordedAt: "2026-10-02",
      addedBy: "Dennis",
    };
    expect(parse({ STAFF_ALERTS_WATCHLIST: JSON.stringify([entry]) }).data?.STAFF_ALERTS_WATCHLIST).toEqual([entry]);
    for (const bad of [
      [entry, { ...entry, reason: "Again" }],
      [{ ...entry, evidenceUrl: "http://example.com/clip" }],
      [{ ...entry, evidenceUrl: "javascript:alert(1)" }],
      [{ ...entry, evidenceUrl: "https://user:pass@example.com/clip" }],
      [{ ...entry, reason: "Two\nlines" }],
      [{ ...entry, communities: 0 }],
      [{ ...entry, recordedAt: "Oct 2" }],
      [{ ...entry, autoBan: true }],
    ])
      expect(parse({ STAFF_ALERTS_WATCHLIST: JSON.stringify(bad) }).success).toBe(false);
  });

  it("shows counts of the known-good list and watch list, never their contents", () => {
    const view = settingsView(
      options({
        STAFF_ALERTS_ENABLED: "true",
        STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: JSON.stringify([{ steamId: owner, note: "owner" }]),
        STAFF_ALERTS_WATCHLIST: JSON.stringify([{ steamId: regular, reason: "Aimbot" }]),
      }),
      2,
    );
    expect(view).toMatchObject({
      knownGoodCount: 1,
      sessionNeverCount: 2,
      watchlistCount: 1,
      seedingPrimeHours: ["17:00-23:00"],
    });
    expect(JSON.stringify(view)).not.toContain(owner);
    expect(JSON.stringify(view)).not.toContain(regular);
    expect(JSON.stringify(view)).not.toContain("Aimbot");
  });
});
