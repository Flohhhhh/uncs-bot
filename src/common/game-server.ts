import { z } from "zod";
import type { StaffRole } from "./admin-policy";

export const LEGACY_SERVER_ID = "primary";
export const gameServerId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a stable lowercase server ID.");
export type GameServerSummary = { id: string; name: string; version: string };
const roleIds = z.array(z.string().regex(/^\d{17,20}$/)).max(100);
export const serverAccess = z.object({ admin: roleIds, moderator: roleIds, viewer: roleIds }).strict();
export function restrictedServerRole(
  globalRole: StaffRole,
  roles: string[],
  policy?: z.infer<typeof serverAccess>,
): StaffRole | null {
  if (!policy) return globalRole;
  const ranks: StaffRole[] = ["viewer", "moderator", "admin"];
  const granted = [...ranks].reverse().find((role) => roles.some((id) => policy[role].includes(id)));
  return granted ? ranks[Math.min(ranks.indexOf(globalRole), ranks.indexOf(granted))] : null;
}
export type RconConnection = { rconUrl: string; password: string };
export interface RconConnectionSource {
  rcon(): RconConnection;
}

export function validRconUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      !/\s/.test(value) &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const gameServerConnections = z
  .array(
    z
      .object({
        id: gameServerId,
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .refine(
            (value) =>
              [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
            "Use a single-line server name.",
          ),
        rconUrl: z
          .string()
          .max(2048)
          .refine(validRconUrl, "Use an HTTP(S) endpoint without embedded credentials, query or fragment."),
        password: z
          .string()
          .min(1)
          .max(512)
          .refine(
            (value) =>
              value.trim().length > 0 &&
              [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
            "Use a non-empty, single-line RCON password.",
          ),
        staffRoles: serverAccess.optional(),
        feedToken: z
          .string()
          .min(32)
          .max(512)
          .regex(/^[^\s]+$/)
          .optional(),
        communityStatus: z
          .object({ channelId: z.string().regex(/^\d{17,20}$/), messageId: z.string().regex(/^\d{17,20}$/) })
          .strict()
          .optional(),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .superRefine((servers, context) => {
    const ids = new Set<string>(),
      endpoints = new Set<string>(),
      cards = new Set<string>(),
      feedTokens = new Set<string>();
    servers.forEach((server, index) => {
      if (ids.has(server.id))
        context.addIssue({ code: "custom", path: [index, "id"], message: "Server IDs must be unique." });
      ids.add(server.id);
      if (server.feedToken) {
        if (feedTokens.has(server.feedToken) || servers.some((entry) => entry.password === server.feedToken))
          context.addIssue({
            code: "custom",
            path: [index, "feedToken"],
            message: "Use a unique feed token separate from game passwords.",
          });
        feedTokens.add(server.feedToken);
      }
      if (server.communityStatus) {
        const card = `${server.communityStatus.channelId}:${server.communityStatus.messageId}`;
        if (cards.has(card))
          context.addIssue({
            code: "custom",
            path: [index, "communityStatus"],
            message: "Each server needs a separate status message.",
          });
        cards.add(card);
      }
      if (!validRconUrl(server.rconUrl)) return;
      const endpoint = new URL(server.rconUrl).href.replace(/\/+$/, "");
      if (endpoints.has(endpoint))
        context.addIssue({
          code: "custom",
          path: [index, "rconUrl"],
          message: "Each server needs its own connection endpoint.",
        });
      endpoints.add(endpoint);
    });
  });

export type GameServerConnection = z.infer<typeof gameServerConnections>[number];
