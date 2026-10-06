import { z } from "zod";

export const roleKinds = ["member", "founder", "supporter"] as const;
export type RoleKind = (typeof roleKinds)[number];

const count = z.number().int().nonnegative().max(1_000_000_000);
const nullableText = z.string().nullable();
const roleCheckSchema = z.object({
  id: nullableText,
  name: nullableText,
  exists: z.boolean(),
  position: z.number().finite().nullable(),
  managed: z.boolean(),
  privileged: z.boolean(),
  staffRole: z.boolean(),
  assignable: z.boolean(),
  problem: nullableText,
  candidates: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(250)
    .optional(),
});

export const attentionItemSchema = z.object({
  kind: z.string(),
  discordUserId: z.string().optional(),
  supporterId: z.string().optional(),
  displayName: z.string().nullable().optional(),
  provider: z.string().optional(),
  roleKind: z.enum(roleKinds).optional(),
  basisId: z.string().optional(),
  at: z.string().optional(),
});

export const planEntrySchema = z.object({
  discordUserId: z.string(),
  roleKind: z.enum(roleKinds).nullable(),
  op: z.string(),
  why: z.string(),
});

export const passSummarySchema = z.object({
  trigger: z.string(),
  requestedBy: nullableText,
  reason: z.string().optional(),
  dryRun: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  users: count,
  added: count,
  removed: count,
  noted: count,
  confirmed: count,
  failed: count,
  blocked: count,
  deferred: count,
  error: nullableText,
  attention: z.array(attentionItemSchema).max(500),
  plan: z.array(planEntrySchema).max(102).optional(),
});

const ledgerRowSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  requestedBy: nullableText,
  trigger: z.string(),
  guildId: z.string(),
  discordUserId: z.string(),
  roleKind: z.enum(roleKinds),
  roleId: z.string(),
  operation: z.string(),
  basisType: z.string(),
  basisId: z.string(),
  changed: z.boolean(),
  state: z.string(),
  message: z.string(),
  createdAt: z.string(),
  completedAt: nullableText,
});

export const discordRolesStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.object({
    guild: z.boolean(),
    memberRole: z.boolean(),
    founderRole: z.boolean(),
    supporterRole: z.boolean(),
  }),
  discordReady: z.boolean(),
  bot: z.object({ manageRoles: z.boolean().nullable(), highestRolePosition: count.nullable() }),
  roles: z.object({ member: roleCheckSchema, founder: roleCheckSchema, supporter: roleCheckSchema }),
  ready: z.boolean(),
  running: z.boolean(),
  lastPass: passSummarySchema.nullable(),
  lastFullPass: passSummarySchema.nullable(),
  queued: count,
  fullPassQueued: z.boolean(),
  nextRetryAt: z.string().nullable(),
  summary: z.object({
    memberEligible: count,
    founders: count,
    foundersWithoutDiscord: count,
    supporterEligible: count.nullable(),
  }),
  attention: z.array(attentionItemSchema).max(500),
  recent: z.array(ledgerRowSchema).max(100),
  note: z.string().optional(),
});

export const reconcileResponseSchema = z.object({
  ok: z.boolean(),
  replayed: z.boolean(),
  summary: passSummarySchema,
});

export type DiscordRolesStatus = z.infer<typeof discordRolesStatusSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type PlanEntry = z.infer<typeof planEntrySchema>;
export type PassSummary = z.infer<typeof passSummarySchema>;
export type ReconcileResponse = z.infer<typeof reconcileResponseSchema>;
export type RolePreview = { at: number; summary: PassSummary };

export const roleLabels: Record<RoleKind, string> = { member: "UNC", founder: "Founder", supporter: "Supporter" };
export const roleSettings: Record<RoleKind, string> = {
  member: "DISCORD_MEMBER_ROLE_ID",
  founder: "DISCORD_FOUNDER_ROLE_ID",
  supporter: "DISCORD_SUPPORTER_ROLE_ID",
};
export const configuredKey = {
  member: "memberRole",
  founder: "founderRole",
  supporter: "supporterRole",
} as const satisfies Record<RoleKind, keyof DiscordRolesStatus["configured"]>;

const triggers: Record<string, string> = {
  startup: "Startup check",
  event: "After a change",
  "member-join": "Member joined",
  admin: "Staff run",
  schedule: "Six-hour safety pass",
};
const operations: Record<string, string> = { add: "Added", remove: "Removed", note: "Noted only" };
const providers: Record<string, string> = { patreon: "Patreon", paypal: "PayPal" };
const addReasons: Record<RoleKind, string> = {
  member: "Approved UNC member application",
  founder: "Founder record with a linked Discord account",
  supporter: "Supports The UNCs right now",
};
const reasons: Record<string, string> = {
  "retry-unknown-add": "Trying again: Discord never confirmed an earlier add",
  "application-revoked": "Their UNC application was revoked and no other approved one remains",
  "support-lapsed": "Their support has ended",
  "retry-unknown-remove": "Trying again: Discord never confirmed an earlier removal",
  "already-present": "Already has the role. Gramps only notes it and will never remove it",
  "removed-in-discord": "Staff removed this role in Discord, so Gramps won’t add it back",
  "already-absent": "The role was already gone when its reason ended",
  "unknown-add-present": "Confirms an earlier add that Discord didn’t confirm at the time",
  "unknown-remove-absent": "Confirms an earlier removal that Discord didn’t confirm at the time",
  "not-ours": "Has the role, but Gramps didn’t add it, so it stays",
  "not-in-server": "Not in the Discord server, so there’s nothing to change yet",
  "no-basis": "No application or supporter record gives them a role",
};

export const plural = (value: number, one: string, many = `${one}s`) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;
export const triggerLabel = (trigger: string) => triggers[trigger] ?? "Role check";
export const operationLabel = (operation: string) => operations[operation] ?? "Recorded";
export const providerLabel = (provider?: string) => (provider ? (providers[provider] ?? provider) : "");

export function planReason(entry: PlanEntry) {
  if (entry.why === "desired" && entry.roleKind) return addReasons[entry.roleKind];
  return reasons[entry.why] ?? entry.why;
}

export function attentionText(item: AttentionItem) {
  const role = item.roleKind ? roleLabels[item.roleKind] : "";
  switch (item.kind) {
    case "founder_without_discord":
      return "Founder without a linked Discord account. Link their Discord account on the Supporters page so the Founder role can be added.";
    case "not_in_server":
      return "Not in the Discord server. Gramps checks them again when they join.";
    case "removed_in_discord":
      return `Staff removed the ${role || "community"} role in Discord. Gramps won’t add it back during this membership.`;
    case "failed":
      return role
        ? `A ${role} role change failed. Check the setup above; Gramps checks this person again later.`
        : "Gramps could not read this member from Discord, so it changed none of their roles. It checks them again later.";
    default:
      return "Needs a look.";
  }
}

export function timeAgo(value: string) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "time unavailable";
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return "less than a minute ago";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} hr ago`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))} days ago`;
}

export function timeAhead(value: string) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "time unavailable";
  const remaining = Math.max(0, at - Date.now());
  if (remaining < 60_000) return "in less than a minute";
  if (remaining < 60 * 60_000) return `in ${Math.ceil(remaining / 60_000)} min`;
  return `in ${Math.ceil(remaining / (60 * 60_000))} hr`;
}

export function displayDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not recorded";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const maxPreviewAgeMs = 10 * 60_000;
export const previewReason = "Preview from the dashboard";
