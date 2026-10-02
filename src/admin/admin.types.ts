import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";
import type { StaffRole } from "../common/admin-policy";
import { gameServerId } from "../common/game-server";
export { canAct, moderatorActions } from "../common/admin-policy";
export type { StaffRole } from "../common/admin-policy";

export type Staff = {
  id: string;
  name: string;
  role: StaffRole;
  csrf: string;
  serverId?: string;
  serverVersion?: string;
};
export type ActionResult = {
  state: "applied" | "accepted" | "pending" | "failed" | "unknown";
  message: string;
  /** A confirmed no-op or a team precondition refusal never needs a follow-up respawn. */
  changed?: boolean;
  /** Present only when the saved configuration exactly matches the intended document. */
  revision?: string;
};
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
const base = {
  id: z.uuid(),
  reason,
  serverId: gameServerId.optional(),
  serverVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
const player = { ...base, steamId };
const expectedRound = z.object({ map: selection, startedAt: z.number().finite().nonnegative() }).strict().optional();
const reviewedRound = z
  .object(
    { map: selection, startedAt: z.number().finite().nonnegative().nullable() },
    { error: "The reviewed round is missing. Refresh the dashboard and open a new review." },
  )
  .strict();
const revision = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n"]+$/);
export const mapSelectionSchema = z
  .object({
    map: selection,
    experiences: z.array(selection).max(10),
    lighting: selection.optional(),
    zoneAlternator: selection.optional(),
  })
  .strict();
export const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("settings-save"),
      revision,
      changes: z
        .record(z.string(), z.union([z.string().max(2048), z.number().finite(), z.boolean()]))
        .refine(
          (changes) => Object.keys(changes).length > 0 && Object.keys(changes).length <= 15,
          "Choose settings to change.",
        ),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("rotation-save"),
      revision,
      entries: z.array(mapSelectionSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("map-next"),
      revision,
      currentIndex: z.number().int().min(0),
      currentMap: selection,
      entry: mapSelectionSchema,
    })
    .strict(),
  z.object({ ...player, action: z.literal("kick") }).strict(),
  z.object({ ...player, action: z.literal("ban"), confirm: steamId }).strict(),
  z.object({ ...player, action: z.literal("unban"), confirm: steamId }).strict(),
  z.object({ ...player, action: z.literal("whitelist-add") }).strict(),
  z.object({ ...player, action: z.literal("whitelist-remove"), confirm: steamId }).strict(),
  z
    .object({
      ...player,
      action: z.literal("kill"),
      confirm: steamId,
      expectedFaction: selection.optional(),
      expectedRound,
    })
    .strict(),
  z.object({ ...player, action: z.literal("message"), message }).strict(),
  z
    .object({
      ...player,
      action: z.literal("team"),
      faction: selection,
      expectedFaction: selection.optional(),
      expectedRound,
      maximumTargetPlayers: z.number().int().min(1).max(50).optional(),
      confirm: steamId,
    })
    .strict(),
  z.object({ ...base, action: z.literal("broadcast"), message }).strict(),
  z
    .object({ ...base, action: z.literal("match-end"), confirm: z.literal("END MATCH"), expectedRound: reviewedRound })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("match-restart"),
      confirm: z.literal("RESTART MATCH"),
      expectedRound: reviewedRound,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("map"),
      map: selection,
      experiences: z.array(selection).max(10).optional(),
      lighting: selection.optional(),
      zoneAlternator: selection.optional(),
      confirm: z.literal("CHANGE MAP"),
      expectedRound: reviewedRound,
    })
    .strict(),
  z.object({ ...base, action: z.literal("lighting"), lighting: selection }).strict(),
]);
export type AdminAction = z.infer<typeof actionSchema>;
export type ActionName = AdminAction["action"];

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
export const playersSchema = z
  .object({
    players: z.array(
      z.object({
        name: z.string(),
        // An unavailable or malformed identity must not hide the rest of the
        // roster. It remains unlinked and cannot become an action target.
        steamId: steamId.nullable().catch(null),
        faction: z.string().nullable().optional(),
        kills: z.number().optional(),
        deaths: z.number().optional(),
        cash: z.number().optional(),
        pingMs: z.number().optional(),
      }),
    ),
  })
  .transform(({ players }) => ({
    // The official demo includes an unlinked player. Never invent an actionable
    // identity for that row, or hide that player controls show only part of a roster.
    players: players.flatMap((player) => (player.steamId === null ? [] : [{ ...player, steamId: player.steamId }])),
    unlinkedPlayerCount: players.filter((player) => player.steamId === null).length,
  }));
export const bansSchema = z.object({
  bans: z.array(
    z.object({
      // The game can load malformed IDs from its configuration. Keep those
      // records visible; actionSchema still requires a valid personal SteamID.
      steamId: z.string(),
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
        appliesWhen: z.string().optional(),
        state: z.string().optional(),
        keyOverrides: z
          .array(
            z.object({
              key: z.string(),
              writable: z.boolean().optional(),
              lockedBy: z.string().nullable().optional(),
              appliesWhen: z.string().optional(),
              state: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type ConfigDocument = z.infer<typeof configDocumentSchema>;
