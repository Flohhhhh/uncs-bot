import { z } from "zod";

export const staffSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  role: z.enum(["admin", "moderator", "viewer"]),
  csrf: z.string().min(1),
  demo: z.boolean().optional(),
  gameMode: z.enum(["live", "sample"]).optional(),
});

export type Staff = z.infer<typeof staffSchema>;
