import type { VoteRoundSource } from "./voting-policy";

export type AutomaticVotePhase =
  | "off"
  | "waiting_rotation"
  | "pre_round"
  | "waiting_players"
  | "waiting_delay"
  | "too_late"
  | "open"
  | "closing"
  | "paused_review"
  | "paused"
  | "done_this_round";
export type AutomaticVoteStatus = {
  enabled: boolean;
  delaySeconds: number;
  closesAtScore: number;
  choices: number;
  message: string;
  checkedAt: string | null;
  // Optional detail; older dashboards read only the fields above.
  phase?: AutomaticVotePhase;
  players?: { current: number; required: number };
  round?: { source: VoteRoundSource; elapsedSeconds: number | null; exact: boolean };
  leadingProgress?: number | null;
  next?: { label: string } | null;
  fifty?: { offered: boolean; reason: string };
  alert?: { at: string; message: string } | null;
};
export type MapVotePreview = {
  checkedAt: string;
  phase: AutomaticVotePhase;
  players: { current: number; required: number } | null;
  round: { source: VoteRoundSource; elapsedSeconds: number | null; exact: boolean } | null;
  leadingProgress: number | null;
  next: { label: string } | null;
  options: { label: string; kind: "map" | "variant" | "fifty"; placement: string }[];
  fifty: { offered: boolean; reason: string };
  /** The first reason a ballot would not open now, or null when it would. */
  blocked: string | null;
};

export type MapVoteSetup = {
  serverId: string;
  checkedAt: string;
  checks: { label: string; status: "ok" | "blocked" | "review"; message: string }[];
};
