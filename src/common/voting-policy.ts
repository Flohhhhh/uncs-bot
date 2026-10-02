import { isModeModifier, mapLabel, modeLabel } from "./map-labels";
import type { MapSelection } from "./server-settings";

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
export type VotingControls = {
  serverId: string;
  version: number;
  policy: VotingPolicy;
  available: boolean;
  ready: boolean;
  message: string;
};
export type VoteReminder = "midpoint" | "final";
export type VoteAutomation = {
  policy: VotingPolicy;
  highestScore: number;
  reminders: Partial<Record<VoteReminder, { id: string; state: string; message: string; at: string }>>;
};

/** The exact server IDs still travel to the game. Identity normalizes only known map aliases and set order. */
export function voteChoiceKey(entry: MapSelection) {
  return JSON.stringify([
    mapLabel(entry.map),
    [...entry.experiences].sort(),
    entry.lighting ?? "",
    entry.zoneAlternator === "None" ? "" : (entry.zoneAlternator ?? ""),
  ]);
}
export function voteModeKey(entry: MapSelection) {
  return [...entry.experiences]
    .map((id) => modeLabel(id))
    .sort()
    .join("|");
}
export function voteChoiceTitle(entry: MapSelection) {
  const modifiers = entry.experiences.filter(isModeModifier).map((id) => modeLabel(id));
  return `${mapLabel(entry.map)} · ${modifiers.join(" + ") || entry.experiences.map((id) => modeLabel(id)).join(" + ") || "Normal"}`;
}

// BULKHEAD's TOP QUESTIONS announcement specifies first to 100. These are score milestones, not time estimates.
export const votingMilestones = { midpoint: 50, final: 85, close: 95, target: 100 } as const;
export function votingScore(status: { factionScores?: { name: string; score: number }[]; scoreCap?: number }) {
  const scores = status.factionScores;
  if (
    !scores ||
    scores.length < 2 ||
    new Set(scores.map((item) => item.name)).size !== scores.length ||
    scores.some((item) => !item.name || !Number.isFinite(item.score) || item.score < 0 || item.score > 100) ||
    (status.scoreCap !== undefined && status.scoreCap !== votingMilestones.target)
  )
    return null;
  return Math.max(...scores.map((item) => item.score));
}
