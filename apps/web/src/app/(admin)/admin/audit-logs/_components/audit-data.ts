import { z } from "zod";

export const auditActionNames = [
  "kick",
  "ban",
  "unban",
  "message",
  "kill",
  "team",
  "broadcast",
  "whitelist-add",
  "whitelist-remove",
  "match-end",
  "match-restart",
  "map",
  "lighting",
  "settings-save",
  "rotation-save",
  "map-next",
] as const;

export const actionLabels: Record<(typeof auditActionNames)[number], string> = {
  kick: "Kick player",
  ban: "Ban player",
  unban: "Remove ban",
  message: "Message player",
  kill: "Force player respawn",
  team: "Change player team",
  broadcast: "Send announcement",
  "whitelist-add": "Add whitelist access",
  "whitelist-remove": "Remove whitelist access",
  "match-end": "End current match",
  "match-restart": "Restart current match",
  map: "Change map",
  lighting: "Change lighting",
  "settings-save": "Save settings",
  "rotation-save": "Save rotation",
  "map-next": "Queue next map",
};

const auditEntrySchema = z.object({
  id: z.string(),
  actorName: z.string(),
  action: z.enum(auditActionNames),
  target: z.string(),
  state: z.enum(["applied", "accepted", "pending", "failed", "unknown", "started"]),
  message: z.string(),
  createdAt: z.string(),
  details: z
    .object({
      reason: z.string().optional(),
      playerName: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

export const auditListSchema = z.array(auditEntrySchema);
export const auditReceiptSchema = z.object({ record: auditEntrySchema.nullable() });

const gameLogEntrySchema = z.object({
  timestamp: z.string().nullable(),
  event: z.enum(["HTTP", "COMMAND", "ACCEPT", "AUTH_OK", "AUTH_FAIL", "REJECT", "CLOSE", "OTHER"]),
  operation: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  changesState: z.boolean(),
});

export const gameLogSchema = z.object({
  available: z.boolean(),
  observedAt: z.string(),
  limit: z.number().int().nonnegative(),
  entries: z.array(gameLogEntrySchema),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type GameLogEntry = z.infer<typeof gameLogEntrySchema>;
export type GameLogData = z.infer<typeof gameLogSchema>;

export const actionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatAuditTime(value: string | null) {
  if (!value) return "Not supplied";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Time unavailable";
}

export function actionSearchText(entry: AuditEntry, playerName: string) {
  return [
    entry.id,
    entry.actorName,
    entry.action,
    actionLabels[entry.action],
    entry.target,
    playerName,
    entry.message,
    entry.details?.reason,
    entry.details?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function gameLogSearchText(entry: GameLogEntry) {
  return [entry.timestamp, entry.event, entry.operation, entry.statusCode]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}
