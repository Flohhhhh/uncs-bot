import type { z } from "zod";
import { mapSelection } from "@uncs/contracts";
import type { VoteAutomation } from "../common/voting-policy";
export type MapVoteChoice = z.infer<typeof mapSelection>;
export type MapVoteState =
  | "publishing"
  | "open"
  | "closing"
  | "queued"
  | "no_votes"
  | "tied"
  | "cancelled"
  | "needs_review";
export type MapVoteCancellation = {
  id: string;
  actorId: string;
  actorName: string;
  reason: string;
  previousState: MapVoteState;
  previousMessage: string;
  at: string;
};
export type MapVoteRecord = {
  id: string;
  serverId: string;
  serverName: string;
  connectionHash: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  actorId: string;
  actorName: string;
  reason: string;
  requestHash: string;
  choices: MapVoteChoice[];
  revision: string;
  currentMap: string;
  currentIndex: number;
  roundStartedAt: Date | null;
  createdAt: Date;
  closesAt: Date;
  updatedAt: Date;
  state: MapVoteState;
  winner: number | null;
  counts: number[];
  message: string;
  cancellation: MapVoteCancellation | null;
  automation?: VoteAutomation | null;
};

export function hasVoteCounts(vote: MapVoteRecord) {
  return vote.winner !== null || ["closing", "queued", "no_votes", "tied"].includes(vote.state);
}
