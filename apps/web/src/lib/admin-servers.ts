import { z } from "zod";

const serverChoiceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["admin", "moderator", "viewer"]),
});

export const adminServerListSchema = z
  .object({
    legacy: z.boolean(),
    servers: z.array(serverChoiceSchema).max(20),
  })
  .superRefine(({ servers }, context) => {
    if (new Set(servers.map((server) => server.id)).size !== servers.length) {
      context.addIssue({ code: "custom", path: ["servers"], message: "Server IDs must be unique." });
    }
  });

export type AdminServer = z.infer<typeof serverChoiceSchema>;
export type AdminServerList = z.infer<typeof adminServerListSchema>;
