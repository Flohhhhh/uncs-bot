import { z } from "zod";
import { gameServerId } from "./game-server";

export const automaticMapVotes = z
  .array(
    z
      .object({
        serverId: gameServerId,
        actorId: z.string().regex(/^\d{17,20}$/),
        delaySeconds: z.number().int().min(60).max(3600).default(120),
        minutes: z.number().int().min(2).max(30).default(5),
        choices: z.number().int().min(2).max(5).default(3),
      })
      .strict(),
  )
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.serverId)).size === items.length,
    "Configure each voting server only once.",
  );
export type AutomaticMapVote = z.infer<typeof automaticMapVotes>[number];
export type AutomaticVoteStatus = {
  enabled: boolean;
  delaySeconds: number;
  minutes: number;
  choices: number;
  message: string;
  checkedAt: string | null;
};

export type MapVoteSetup = {
  serverId: string;
  checkedAt: string;
  checks: { label: string; status: "ok" | "blocked" | "review"; message: string }[];
};
