import type { z } from "zod";
import { weeklyMessage, weeklyRenderRequest } from "@uncs/contracts";
export const MIN_RANKED_PLAYERS = 5;
export type WeeklyBoardMessage = z.infer<typeof weeklyMessage>;
export type WeeklyBoardInput = z.infer<typeof weeklyRenderRequest>;
