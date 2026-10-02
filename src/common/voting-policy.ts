import { isModeModifier, lightingLabel, mapLabel, modeLabel, zoneLabel } from "./map-labels";
import type { MapSelection } from "./server-settings";

// Shared with the dashboard: no Node imports belong in this file.
export type VotingPolicy = {
  enabled: boolean;
  mapChoices: boolean;
  modeChoices: boolean;
  midpointReminder: boolean;
  finalReminder: boolean;
};
export const defaultVotingPolicy: VotingPolicy = {
  enabled: false,
  mapChoices: true,
  modeChoices: false,
  midpointReminder: false,
  finalReminder: false,
};
export type VoteReminder = "midpoint" | "final";
export type ReminderSettings = { score: number; discord: boolean; inGame: boolean };
export type FiftyFiftySettings = {
  offered: boolean;
  minPlayers: number;
  minVotes: number;
  /** `null` closes the smallest team when sorting starts. */
  closedFaction: string | null;
  warningSeconds: number;
  balanceWindowSeconds: number;
  forceRespawn: boolean;
  rounds: number;
  autoEnd: boolean;
  cooldownRounds: number;
  maxRoundMinutes: number;
};
export type VoteTieRule = "keep_rotation" | "first_option";
export type VotingSettings = {
  /** Total buttons on a ballot, including a 50v50 option. */
  optionCount: number;
  source: "rotation" | "pool";
  pool: MapSelection[];
  excludeCurrentMap: boolean;
  excludeRecent: number;
  minPlayers: number;
  openDelaySeconds: number;
  /** Points out of 100: no ballot opens once the leading team has this many. */
  openScoreCeiling: number;
  closeAtScore: number;
  reminders: Record<VoteReminder, ReminderSettings>;
  announce: { openInGame: boolean; resultInGame: boolean };
  tieRule: VoteTieRule;
  fiftyFifty: FiftyFiftySettings;
};
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
/** Rows saved before customizable settings have no `settings` key and read as the defaults. */
export type StoredVotingPolicy = VotingPolicy & { settings?: DeepPartial<VotingSettings> };

// BULKHEAD's TOP QUESTIONS announcement specifies first to 100. These are score milestones, not time estimates.
export const votingMilestones = { midpoint: 50, final: 85, close: 95, target: 100 } as const;
export const defaultVotingSettings: VotingSettings = {
  optionCount: 3,
  source: "rotation",
  pool: [],
  excludeCurrentMap: true,
  excludeRecent: 0,
  minPlayers: 40,
  openDelaySeconds: 180,
  openScoreCeiling: 70,
  closeAtScore: votingMilestones.close,
  reminders: {
    midpoint: { score: votingMilestones.midpoint, discord: true, inGame: true },
    final: { score: votingMilestones.final, discord: true, inGame: true },
  },
  announce: { openInGame: true, resultInGame: true },
  tieRule: "keep_rotation",
  fiftyFifty: {
    offered: false,
    minPlayers: 80,
    minVotes: 5,
    closedFaction: null,
    warningSeconds: 30,
    balanceWindowSeconds: 300,
    forceRespawn: false,
    rounds: 1,
    autoEnd: true,
    cooldownRounds: 1,
    maxRoundMinutes: 60,
  },
};
const range = (min: number, max: number) => ({ min, max });
/** Ranges for dashboard inputs. Cross-field rules are enforced when saving. */
export const votingSettingLimits = {
  optionCount: range(2, 5),
  poolSize: range(0, 20),
  excludeRecent: range(0, 10),
  minPlayers: range(0, 100),
  openDelaySeconds: range(0, 1800),
  openScoreCeiling: range(1, 94),
  closeAtScore: range(50, 99),
  reminderScore: range(1, 98),
  fiftyFifty: {
    minPlayers: range(20, 100),
    minVotes: range(1, 100),
    warningSeconds: range(15, 120),
    balanceWindowSeconds: range(60, 600),
    rounds: range(1, 5),
    cooldownRounds: range(0, 10),
    maxRoundMinutes: range(30, 120),
  },
} as const;
export type VotingSettingLimits = typeof votingSettingLimits;
export type VotingContext = {
  /** The game's "Players to start a match", or 20 when unreadable. */
  startThreshold: number;
  factions: string[];
  eventsEnabled: boolean;
  routes: { kill: boolean; message: boolean };
  fifty: { available: boolean; message: string };
};
export type VotingControls = {
  serverId: string;
  version: number;
  policy: VotingPolicy;
  available: boolean;
  ready: boolean;
  message: string;
  settings?: VotingSettings;
  limits?: VotingSettingLimits;
  context?: VotingContext | null;
};
export type VoteRoundSource = "clock" | "observed" | "baseline";
export type VoteRoundSnapshot = {
  id: string;
  map: string;
  index: number | null;
  startedAt: number;
  source: VoteRoundSource;
  exact: boolean;
};
export type VoteRotationSnapshot = {
  fingerprint: string;
  length: number;
  currentIndex: number;
  nextSlot: number;
  nextKey: string | null;
  /** What plays next if the vote ties, has no votes or is cancelled. */
  nextLabel?: string;
};
export type MapNextPlacement = "already-next" | "move" | "swap" | "insert" | "append";
/** Only "refused" (the game cleanly refused the queued winner) counts towards pausing automatic voting. */
export type VoteOutcome =
  | "refused"
  | "expired"
  | "match_ended"
  | "rotation_changed"
  | "stopped"
  | "unposted"
  /** A winning 50v50 failed its checks at the close; normal teams continue. */
  | "fifty_unready";
export type VoteAutomation = {
  policy: VotingPolicy;
  highestScore: number;
  reminders: Partial<Record<VoteReminder, { id: string; state: string; message: string; at: string }>>;
  // Ballots opened before customizable settings omit every field below.
  policyVersion?: number;
  settings?: VotingSettings;
  openedAtScore?: number;
  maxStep?: number;
  lastScoreAt?: string;
  round?: VoteRoundSnapshot;
  rotation?: VoteRotationSnapshot;
  /** Recorded before map-next is sent, so an unconfirmed result can be rechecked. */
  queue?: { receiptId: string; before: string; after: string; kind: MapNextPlacement };
  outcome?: VoteOutcome;
  event?: { id: string };
  alert?: { firstAt: string; lastAt: string; count: number };
  resolution?: { at: string; to: string; by: "system:reconcile"; message: string };
};
/** A ballot option. Only automatic ballots may carry the 50v50 marker. */
export type VoteChoice = MapSelection & { event?: "50v50" };

/** The exact server IDs still travel to the game. Identity normalizes only known map aliases and set order. */
export function voteChoiceKey(entry: VoteChoice) {
  return JSON.stringify([
    mapLabel(entry.map),
    [...entry.experiences].sort(),
    entry.lighting ?? "",
    entry.zoneAlternator === "None" ? "" : (entry.zoneAlternator ?? ""),
    ...(entry.event ? [entry.event] : []),
  ]);
}
export function voteModeKey(entry: MapSelection) {
  return [...entry.experiences]
    .map((id) => modeLabel(id))
    .sort()
    .join("|");
}
export function voteChoiceTitle(entry: VoteChoice) {
  const modifiers = entry.experiences.filter(isModeModifier).map((id) => modeLabel(id));
  return [
    mapLabel(entry.map),
    modifiers.join(" + ") || entry.experiences.map((id) => modeLabel(id)).join(" + ") || "Normal",
    entry.zoneAlternator ? zoneLabel(entry.zoneAlternator) : "",
    entry.lighting ? lightingLabel(entry.lighting) : "",
    entry.event ? "50v50" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

type ScoredStatus = { factionScores?: { name: string; score: number }[]; scoreCap?: number | null };
function leadingScore(status: ScoredStatus, cap: number) {
  const scores = status.factionScores;
  if (
    !scores ||
    scores.length < 2 ||
    new Set(scores.map((item) => item.name)).size !== scores.length ||
    scores.some((item) => !item.name || !Number.isFinite(item.score) || item.score < 0 || item.score > cap)
  )
    return null;
  return Math.max(...scores.map((item) => item.score));
}
/** Raw leading score on a 100-point match; null for any other reported cap. */
export function votingScore(status: ScoredStatus) {
  if (status.scoreCap !== undefined && status.scoreCap !== null && status.scoreCap !== votingMilestones.target)
    return null;
  return leadingScore(status, votingMilestones.target);
}
/** Leading score as points out of 100, scaled when the game reports another cap. An absent cap means 100. */
export function votingProgress(status: ScoredStatus) {
  const cap = status.scoreCap ?? votingMilestones.target;
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const leading = leadingScore(status, cap);
  return leading === null ? null : Math.floor((leading * 100) / cap);
}
/** The settings an open ballot was created with; older ballots use the original fixed milestones. */
export function automationSettings(automation: Pick<VoteAutomation, "settings">): VotingSettings {
  return automation.settings ?? defaultVotingSettings;
}
export function closeThreshold(automation: Pick<VoteAutomation, "settings" | "maxStep">) {
  const score = automationSettings(automation).closeAtScore;
  return { score, early: score - 10, maxStep: Math.max(0, automation.maxStep ?? 0) };
}
/** Close at the configured score, or one observed scoring step early when the next step could end the match. */
export function closeReached(automation: Pick<VoteAutomation, "settings" | "maxStep">, progress: number) {
  const threshold = closeThreshold(automation);
  return (
    progress >= threshold.score ||
    (progress >= threshold.early && progress + threshold.maxStep >= votingMilestones.target)
  );
}
