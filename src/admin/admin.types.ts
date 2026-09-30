import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";

export type StaffRole = "viewer" | "moderator" | "admin";
export type Staff = { id: string; name: string; role: StaffRole; csrf: string };
export type ActionResult = { state: "applied" | "accepted" | "pending" | "failed" | "unknown"; message: string };
export const steamId = z
  .string()
  .refine(isPublicIndividualSteamId, "Enter a 17-digit SteamID64 for a personal Steam account.");
const reason = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32), "Use a single line.");
const message = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32), "Use a single line.");
const selection = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[\w./-]+$/);
const base = { id: z.uuid(), reason };
const player = { ...base, steamId };
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ ...player, action: z.literal("kick") }).strict(),
  z.object({ ...player, action: z.literal("ban"), confirm: steamId }).strict(),
  z.object({ ...player, action: z.literal("unban"), confirm: steamId }).strict(),
  z.object({ ...player, action: z.literal("whitelist-add") }).strict(),
  z.object({ ...player, action: z.literal("whitelist-remove"), confirm: steamId }).strict(),
  z.object({ ...player, action: z.literal("kill"), confirm: steamId }).strict(),
  z.object({ ...player, action: z.literal("message"), message }).strict(),
  z.object({ ...player, action: z.literal("team"), faction: selection, confirm: steamId }).strict(),
  z.object({ ...base, action: z.literal("broadcast"), message }).strict(),
  z.object({ ...base, action: z.literal("match-end"), confirm: z.literal("END MATCH") }).strict(),
  z.object({ ...base, action: z.literal("match-restart"), confirm: z.literal("RESTART MATCH") }).strict(),
  z
    .object({
      ...base,
      action: z.literal("map"),
      map: selection,
      experiences: z.array(selection).max(10).optional(),
      lighting: selection.optional(),
      zoneAlternator: selection.optional(),
      confirm: z.literal("CHANGE MAP"),
    })
    .strict(),
  z.object({ ...base, action: z.literal("lighting"), lighting: selection }).strict(),
]);
export type AdminAction = z.infer<typeof actionSchema>;
export type ActionName = AdminAction["action"];
export const moderatorActions: ActionName[] = ["kick", "ban", "unban", "message", "kill", "team", "broadcast"];
export function canAct(role: StaffRole, action: ActionName) {
  return role === "admin" || (role === "moderator" && moderatorActions.includes(action));
}

export const statusSchema = z.object({
  serverName: z.string(),
  map: z.string(),
  lighting: z.string().optional(),
  experiences: z.array(z.string()).optional(),
  alternator: z.string().optional(),
  scoreTick: z.object({ current: z.number(), min: z.number(), max: z.number() }).optional(),
  rotation: z
    .object({ nowIndex: z.number().nullable().optional(), nextIndex: z.number().nullable().optional() })
    .optional(),
  players: z.object({ current: z.number(), max: z.number() }),
  factionScores: z
    .array(z.object({ name: z.string(), colorHex: z.string().optional(), score: z.number() }))
    .default([]),
  matchSeconds: z.number().optional(),
  scoreCap: z.number().optional(),
});
export const playersSchema = z.object({
  players: z.array(
    z.object({
      name: z.string(),
      steamId,
      faction: z.string().nullable().optional(),
      kills: z.number().optional(),
      deaths: z.number().optional(),
      cash: z.number().optional(),
      pingMs: z.number().optional(),
    }),
  ),
});
export const bansSchema = z.object({
  bans: z.array(
    z.object({
      steamId,
      bannedAtUtc: z.string().nullable().optional(),
      bannedBy: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    }),
  ),
});
export const reservedSchema = z.object({ reservedSlots: z.array(steamId) });
export const capabilitiesSchema = z.object({
  build: z.string().optional(),
  routes: z.array(z.string()),
  config: z.object({ writable: z.boolean() }).optional(),
  limits: z
    .object({
      maxBodyBytes: z.number().int().positive().optional(),
      maxRequestsPerMinutePerIp: z.number().int().positive().optional(),
    })
    .optional(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const configDocumentSchema = z.object({
  revision: z
    .string()
    .min(1)
    .regex(/^[^\r\n"]+$/),
  writable: z.boolean(),
  text: z.string(),
  redacted: z.boolean().optional(),
  sections: z
    .array(
      z.object({
        section: z.string(),
        writable: z.boolean().optional(),
        allowedKeys: z.array(z.string()).optional(),
        keyOverrides: z
          .array(
            z.object({ key: z.string(), writable: z.boolean().optional(), lockedBy: z.string().nullable().optional() }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type ConfigDocument = z.infer<typeof configDocumentSchema>;
