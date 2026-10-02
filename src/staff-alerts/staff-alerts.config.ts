import type { EnvService } from "../env/env.service";
import type { PerformanceMode } from "../common/staff-alerts";
import { formatClock, formatWindow, parseClockList, parseWindows, type LocalWindow } from "./local-time";

export type WatchlistEntry = {
  steamId: string;
  reason: string;
  evidenceUrl?: string;
  communities?: number;
  recordedAt?: string;
  addedBy?: string;
  source?: "wardogs-network" | "staff";
};
export type HealthOptions = {
  enabled: boolean;
  downMinutes: number;
  restartPlayers: number;
  /** Local minutes after midnight. */
  scheduledRestarts: number[];
  timeZone: string;
};
export type SeedingOptions = {
  enabled: boolean;
  below: number;
  minutes: number;
  afterRestartHours: number;
  primeWindows: LocalWindow[];
  timeZone: string;
};
export type PerformanceOptions = {
  mode: PerformanceMode;
  windowMinutes: number;
  windowKills: number;
  matchKills: number;
  matchKd: number;
  cooldownMinutes: number;
  maxPerHour: number;
  skipWhitelisted: boolean;
  knownGood: Map<string, string | null>;
};
export type WatchlistOptions = {
  enabled: boolean;
  entries: WatchlistEntry[];
  highlightCommunities: number;
  cooldownMinutes: number;
};
export type StaffAlertsOptions = {
  enabled: boolean;
  timeZone: string;
  health: HealthOptions;
  seeding: SeedingOptions;
  performance: PerformanceOptions;
  watchlist: WatchlistOptions;
  /** Enabled and at least one feature on: only then do workers start. */
  active: boolean;
};

/** Turns validated env values into typed options. Every feature is off unless STAFF_ALERTS_ENABLED is true. */
export function staffAlertsOptions(env: EnvService): StaffAlertsOptions {
  const enabled = env.get("STAFF_ALERTS_ENABLED") === true;
  const timeZone = env.get("STAFF_ALERTS_TIME_ZONE") ?? "America/New_York";
  const performance = env.get("STAFF_ALERTS_PERFORMANCE_ENABLED");
  const mode: PerformanceMode = !enabled
    ? "off"
    : performance === "true"
      ? "on"
      : performance === "observe"
        ? "observe"
        : "off";
  const knownGood = new Map<string, string | null>(
    (env.get("STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD") ?? []).map((entry) =>
      typeof entry === "string" ? [entry, null] : [entry.steamId, entry.note ?? null],
    ),
  );
  const options: Omit<StaffAlertsOptions, "active"> = {
    enabled,
    timeZone,
    health: {
      enabled: enabled && env.get("STAFF_ALERTS_HEALTH_ENABLED") === true,
      downMinutes: env.get("STAFF_ALERTS_HEALTH_DOWN_MINUTES") ?? 10,
      restartPlayers: env.get("STAFF_ALERTS_HEALTH_RESTART_PLAYERS") ?? 10,
      scheduledRestarts: parseClockList(env.get("STAFF_ALERTS_HEALTH_SCHEDULED_RESTARTS") ?? "", 6) ?? [],
      timeZone,
    },
    seeding: {
      enabled: enabled && env.get("STAFF_ALERTS_SEEDING_ENABLED") === true,
      below: env.get("STAFF_ALERTS_SEEDING_BELOW") ?? 1,
      minutes: env.get("STAFF_ALERTS_SEEDING_MINUTES") ?? 30,
      afterRestartHours: env.get("STAFF_ALERTS_SEEDING_AFTER_RESTART_HOURS") ?? 12,
      primeWindows: parseWindows(env.get("STAFF_ALERTS_SEEDING_PRIME_HOURS") ?? "17:00-23:00", 4) ?? [],
      timeZone,
    },
    performance: {
      mode,
      windowMinutes: env.get("STAFF_ALERTS_PERFORMANCE_WINDOW_MINUTES") ?? 5,
      windowKills: env.get("STAFF_ALERTS_PERFORMANCE_WINDOW_KILLS") ?? 30,
      matchKills: env.get("STAFF_ALERTS_PERFORMANCE_MATCH_KILLS") ?? 40,
      matchKd: env.get("STAFF_ALERTS_PERFORMANCE_MATCH_KD") ?? 20,
      cooldownMinutes: env.get("STAFF_ALERTS_PERFORMANCE_PLAYER_COOLDOWN_MINUTES") ?? 360,
      maxPerHour: env.get("STAFF_ALERTS_PERFORMANCE_MAX_PER_HOUR") ?? 3,
      skipWhitelisted: env.get("STAFF_ALERTS_PERFORMANCE_SKIP_WHITELISTED") === true,
      knownGood,
    },
    watchlist: {
      enabled: enabled && env.get("STAFF_ALERTS_WATCHLIST_ENABLED") === true,
      entries: env.get("STAFF_ALERTS_WATCHLIST") ?? [],
      highlightCommunities: env.get("STAFF_ALERTS_WATCHLIST_HIGHLIGHT_COMMUNITIES") ?? 3,
      cooldownMinutes: env.get("STAFF_ALERTS_WATCHLIST_COOLDOWN_MINUTES") ?? 360,
    },
  };
  return {
    ...options,
    active:
      enabled && (options.health.enabled || options.seeding.enabled || mode !== "off" || options.watchlist.enabled),
  };
}

/** Status settings: thresholds and counts, never the contents of the known-good list or watch list. */
export function settingsView(options: StaffAlertsOptions, sessionNeverCount: number) {
  return {
    timeZone: options.timeZone,
    healthDownMinutes: options.health.downMinutes,
    healthRestartPlayers: options.health.restartPlayers,
    scheduledRestarts: options.health.scheduledRestarts.map(formatClock),
    seedingBelow: options.seeding.below,
    seedingMinutes: options.seeding.minutes,
    seedingAfterRestartHours: options.seeding.afterRestartHours,
    seedingPrimeHours: options.seeding.primeWindows.map(formatWindow),
    performanceWindowMinutes: options.performance.windowMinutes,
    performanceWindowKills: options.performance.windowKills,
    performanceMatchKills: options.performance.matchKills,
    performanceMatchKd: options.performance.matchKd,
    performanceCooldownMinutes: options.performance.cooldownMinutes,
    performanceMaxPerHour: options.performance.maxPerHour,
    performanceSkipWhitelisted: options.performance.skipWhitelisted,
    knownGoodCount: options.performance.knownGood.size,
    sessionNeverCount,
    watchlistCount: options.watchlist.entries.length,
    watchlistHighlightCommunities: options.watchlist.highlightCommunities,
    watchlistCooldownMinutes: options.watchlist.cooldownMinutes,
  };
}
