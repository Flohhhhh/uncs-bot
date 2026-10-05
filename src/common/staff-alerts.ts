// Shared with the dashboard: types and pure policy only, no Node imports.
import type { StaffRole } from "./admin-policy";

/**
 * An https link an alert can show as an autolink (<url>): no spaces, angle brackets or backticks to break out.
 * Startup applies it to watch-list evidence links, so a link the alert would drop is refused instead.
 */
export const SAFE_LINK = /^https:\/\/[^\s<>`]{1,500}$/;

/**
 * Staff alerts are alert-only: Gramps never kicks, bans or changes the whitelist because of one.
 * SteamIDs and player names in these views are for the authenticated staff API and the private
 * staff channel only.
 */
export const STAFF_ALERT_KINDS = [
  "game-down",
  "game-back",
  "game-restart",
  "game-build",
  "seeding-after-restart",
  "seeding-prime",
  "seeding-recovered",
  "performance-window",
  "performance-match",
  "watchlist-join",
  /** A joining player kicked often through the dashboard recently. Grouped with the watch list. */
  "repeat-offender-join",
  /** Map-vote and 50v50 automation that needs a person (StaffAlerts.send). */
  "automation",
] as const;
export type StaffAlertKind = (typeof STAFF_ALERT_KINDS)[number];
export type StaffAlertSeverity = "info" | "warning" | "high";
/**
 * Dashboard filter and snooze group. Health and seeding share one hourly limit. Repeat-offender joins
 * are watch-list alerts. Automation alerts cannot be snoozed: a ballot or 50v50 that needs a person is
 * never held back by a snooze.
 */
export type StaffAlertCategory = "health" | "seeding" | "performance" | "watchlist" | "automation";
export const SNOOZE_CATEGORIES = ["health", "seeding", "performance", "watchlist", "all"] as const;
export type StaffAlertSnoozeCategory = (typeof SNOOZE_CATEGORIES)[number];
export const REVIEW_DECISIONS = ["ack", "legit", "never"] as const;
export type StaffAlertDecision = (typeof REVIEW_DECISIONS)[number];

export function alertCategory(kind: StaffAlertKind): StaffAlertCategory {
  if (kind.startsWith("game-")) return "health";
  if (kind.startsWith("seeding-")) return "seeding";
  if (kind.startsWith("performance-")) return "performance";
  if (kind.startsWith("watchlist-") || kind === "repeat-offender-join") return "watchlist";
  return "automation";
}
/** Only performance alerts take "legit" or "never"; any alert can be acknowledged. */
export function reviewDecisions(kind: StaffAlertKind): StaffAlertDecision[] {
  return alertCategory(kind) === "performance" ? ["ack", "legit", "never"] : ["ack"];
}
/** Moderators and administrators review and snooze alerts; viewers read them. */
export function canReviewAlerts(role: StaffRole) {
  return role !== "viewer";
}
/** Performance and watch-list alerts wait for a person until someone reviews them. */
export function needsReview(alert: Pick<StaffAlertView, "kind" | "review">) {
  const category = alertCategory(alert.kind);
  return (category === "performance" || category === "watchlist") && !alert.review;
}

/**
 * posted: in the staff channel. observe: recorded only (performance observe mode). suppressed: a
 * limit or cooldown held it back, or it is recorded only by design (a scheduled restart below the
 * player threshold, a watch-list player already online when Gramps started). snoozed: staff
 * snoozed the category. failed: the channel check or Discord refused it.
 */
export type StaffAlertDeliveryState = "posted" | "observe" | "suppressed" | "snoozed" | "failed";
export type StaffAlertDelivery = { state: StaffAlertDeliveryState; reason: string | null };

export type StaffAlertReview = { decision: StaffAlertDecision; by: string; at: string };
/**
 * Supporting combat-feed events, attached only while the feed is delivering. Never used by the
 * rules and never proof: staff can dismiss the alert.
 */
export type FeedContextView = {
  /** Feed kills by this player since the round start (at most 500 rows read). */
  kills: number;
  /** Feed kills by this player within the alert's window. */
  windowKills: number;
  headshotShare: number | null;
  topCauses: string[];
  maxDistanceMeters: number | null;
  since: string;
};
export type NetworkBanView = {
  source: "wardogs-network" | "staff";
  sourceName: string;
  communities: number | null;
  reasons: string[];
  evidenceUrls: string[];
  recordedAt: string | null;
  addedBy: string | null;
  /** The player is also on the performance known-good list; the match is still shown. */
  knownGood: boolean;
  /** Online when Gramps started rather than an observed join. */
  presentAtStart: boolean;
};
export type StaffAlertView = {
  id: string;
  serverId: string;
  kind: StaffAlertKind;
  category: StaffAlertCategory;
  severity: StaffAlertSeverity;
  title: string;
  lines: string[];
  player: { steamId: string; name: string } | null;
  facts: Record<string, string | number>;
  createdAt: string;
  updatedAt: string;
  delivery: StaffAlertDelivery;
  pinged: boolean;
  review: StaffAlertReview | null;
  feed: FeedContextView | null;
  network: NetworkBanView | null;
};

export type StaffAlertsChannelState =
  | "ok"
  | "missing"
  | "wrong-guild"
  | "not-text"
  | "public"
  | "missing-permissions"
  | "community-channel"
  | "discord-offline";
/** `not-mentionable`: Discord would deliver the mention to nobody (see pingReady in the service). */
export type StaffAlertsPingState = "off" | "ok" | "invalid" | "not-mentionable";
export type PerformanceMode = "off" | "observe" | "on";
export type RoundPeakView = {
  roundKey: string;
  map: string;
  startedAt: string;
  window: { steamId: string; name: string; kills: number; minutes: number } | null;
  kd: { steamId: string; name: string; kills: number; deaths: number; kd: number } | null;
};
export type StaffAlertsWorkerView = {
  state: "running" | "off" | "not-configured";
  lastReadAt: string | null;
  reachable: boolean | null;
  failingSince: string | null;
  failureKind: string | null;
  players: number | null;
  round: { id: string; map: string; phase: string } | null;
  build: string | null;
  lastRestartAt: string | null;
  seeding: { lowSince: string | null; alerted: string[] };
  counters: "unknown" | "available" | "unavailable";
  trackedPlayers: number;
  unlinkedPlayers: number;
  sources: { name: string; error: string | null; at: string | null }[];
};
export type StaffAlertsSnoozeView = { category: StaffAlertSnoozeCategory; until: string; by: string };
export type StaffAlertsStatus = {
  serverId: string;
  enabled: boolean;
  features: { health: boolean; seeding: boolean; performance: PerformanceMode; watchlist: boolean };
  channel: { configured: boolean; state: StaffAlertsChannelState; ping: StaffAlertsPingState };
  /** Thresholds and counts only. Known-good and watch-list contents never leave the server. */
  settings: {
    timeZone: string;
    healthDownMinutes: number;
    healthRestartPlayers: number;
    scheduledRestarts: string[];
    seedingBelow: number;
    seedingMinutes: number;
    seedingAfterRestartHours: number;
    seedingPrimeHours: string[];
    performanceWindowMinutes: number;
    performanceWindowKills: number;
    performanceMatchKills: number;
    performanceMatchKd: number;
    performanceCooldownMinutes: number;
    performanceMaxPerHour: number;
    performanceSkipWhitelisted: boolean;
    knownGoodCount: number;
    sessionNeverCount: number;
    watchlistCount: number;
    watchlistHighlightCommunities: number;
    watchlistCooldownMinutes: number;
    /** 0 when repeat-offender alerts are off. */
    repeatOffenderKicks: number;
    repeatOffenderDays: number;
  };
  worker: StaffAlertsWorkerView;
  snoozes: StaffAlertsSnoozeView[];
  /** Newest first, at most 100. */
  alerts: StaffAlertView[];
  /** The last 20 rounds, newest first. */
  peaks: RoundPeakView[];
};
export type StaffAlertReviewResult = {
  alert: StaffAlertView;
  /** Present for "never": paste into STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD to keep it after a restart. */
  knownGoodEntry?: string;
};
