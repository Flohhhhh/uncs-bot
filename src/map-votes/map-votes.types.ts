import { z } from "zod";
import { gameServerId } from "../common/game-server";
import { mapSelectionSchema } from "../admin/admin.types";

export const startMapVoteSchema = z
  .object({
    id: z.uuid(),
    serverId: gameServerId,
    revision: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n"]+$/),
    choices: z.array(mapSelectionSchema).min(2).max(5),
    minutes: z.number().int().min(2).max(30),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32), "Use a single line."),
  })
  .strict()
  .superRefine(({ choices }, context) => {
    if (new Set(choices.map((choice) => choice.map)).size !== choices.length)
      context.addIssue({ code: "custom", message: "Choose different maps for each option." });
  });
export const cancelMapVoteSchema = z
  .object({
    id: z.uuid(),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32), "Use a single line."),
  })
  .strict();
export type StartMapVote = z.infer<typeof startMapVoteSchema>;
export type MapVoteChoice = z.infer<typeof mapSelectionSchema>;
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
};

/** A tie or no votes keeps the saved rotation. */
export function ballotWinner(counts: number[]) {
  const maximum = Math.max(0, ...counts);
  return maximum > 0 && counts.filter((count) => count === maximum).length === 1 ? counts.indexOf(maximum) : null;
}
export function hasVoteCounts(vote: MapVoteRecord) {
  return vote.winner !== null || ["closing", "queued", "no_votes", "tied"].includes(vote.state);
}

export function mapVoteView(vote: MapVoteRecord) {
  return {
    id: vote.id,
    serverId: vote.serverId,
    serverName: vote.serverName,
    actorName: vote.actorName,
    reason: vote.reason,
    choices: vote.choices,
    state: vote.state,
    winner: vote.winner,
    counts: vote.counts,
    counted: hasVoteCounts(vote),
    createdAt: vote.createdAt.toISOString(),
    closesAt: vote.closesAt.toISOString(),
    message: vote.message,
    cancellation: vote.cancellation,
    messageUrl: vote.messageId
      ? `https://discord.com/channels/${vote.guildId}/${vote.channelId}/${vote.messageId}`
      : null,
  };
}
