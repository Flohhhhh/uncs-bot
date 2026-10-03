import { z } from "zod";
import type {
  DiscordRoleActionState,
  DiscordRoleBasisType,
  DiscordRoleKind,
  DiscordRoleOperation,
  DiscordRoleTrigger,
} from "../database/discord-roles.schema";

export const ROLES_ACTOR_ID = "system:discord-roles";
export const ROLES_ACTOR_NAME = "Gramps Discord roles";
export const ROLE_KINDS = ["member", "founder", "supporter"] as const satisfies readonly DiscordRoleKind[];
/** Audit-log reasons shown in Discord. They name the rule, never private data. Founder has no removal. */
export const ROLE_REASONS = {
  member: { add: "Gramps: UNC member application approved", remove: "Gramps: UNC application revoked" },
  founder: { add: "Gramps: founding supporter" },
  supporter: { add: "Gramps: active supporter", remove: "Gramps: support ended" },
} as const satisfies Record<DiscordRoleKind, { add: string; remove?: string }>;
/** The kind of record each role's ledger rows name as their basis. */
export const BASIS_TYPES = {
  member: "application",
  founder: "founder",
  supporter: "supporter",
} as const satisfies Record<DiscordRoleKind, DiscordRoleBasisType>;
/** Why a role Gramps added is removed. Founder roles are never removed automatically. */
const ENDED_WHY = {
  member: "application-revoked",
  supporter: "support-lapsed",
} as const satisfies Record<Exclude<DiscordRoleKind, "founder">, string>;

export type { DiscordRoleBasisType, DiscordRoleKind, DiscordRoleTrigger };
/** The newest ledger row for a person and role that is applied, unknown or still started. */
export type LedgerEntry = {
  id: string;
  operation: DiscordRoleOperation;
  state: DiscordRoleActionState;
  changed: boolean;
  createdAt: Date;
};
export type RoleFacts = {
  kind: DiscordRoleKind;
  /** The application or supporter record that makes the role desired, or null. */
  desiredBasis: string | null;
  /**
   * The record that used to justify the role and has ended, or null: a revoked UNC application with no approved
   * one remaining (UNC), or the supporter record behind a Supporter role Gramps holds after that support lapsed.
   * Founder roles have none.
   */
  endedBasis: string | null;
  hasRole: boolean;
  /** When the person joined the server this time; null when Discord does not report it. */
  joinedAt: Date | null;
  lastEffective: LedgerEntry | null;
};
/**
 * Ledger notes. Each records a role Gramps does not hold, so it is never removed automatically: one that was already
 * present, or one Gramps added that is gone again because staff removed it in Discord.
 */
export const NOTE_MESSAGES = {
  "already-present": "The role was already present. Gramps did not add it and will not remove it.",
  "removed-in-discord":
    "The role Gramps added was removed in Discord. Gramps will not add it back during this membership, and will not remove it if staff give it back.",
  "already-absent":
    "The role was not present when its reason ended, so there was nothing to remove. Gramps will not remove it if staff give it back.",
} as const;
export type NoteWhy = keyof typeof NOTE_MESSAGES;
export type RoleDecision =
  | { op: "add"; basisId: string; why: "desired" | "retry-unknown-add" }
  | { op: "remove"; basisId: string; why: (typeof ENDED_WHY)[keyof typeof ENDED_WHY] | "retry-unknown-remove" }
  | { op: "note"; basisId: string; why: NoteWhy }
  | { op: "confirm"; entryId: string; why: "unknown-add-present" | "unknown-remove-absent" }
  | {
      op: "none";
      why: "already-recorded" | "removed-in-discord" | "not-ours" | "not-present" | "no-basis" | "founder-kept";
    };

const uncertain = (entry: LedgerEntry) => entry.state === "unknown" || entry.state === "started";

/**
 * Decides one role for one member from the ledger history of the configured role. Manual Discord changes
 * win: a role that was already present is only noted, a role staff removed is not re-added during the same
 * membership, and only a role Gramps added during the current membership can be removed: the UNC role after
 * its application is revoked, or the Supporter role after support lapsed. The Founder role is never removed.
 * When a role Gramps added is found gone, that is noted once, so a role staff give back by hand later is theirs.
 */
export function decide(facts: RoleFacts): RoleDecision {
  // Ledger history from an earlier membership no longer applies after the person left and rejoined.
  const current =
    facts.lastEffective && (!facts.joinedAt || facts.lastEffective.createdAt.getTime() >= facts.joinedAt.getTime())
      ? facts.lastEffective
      : null;
  if (facts.desiredBasis) {
    if (facts.hasRole) {
      if (current?.operation === "add" && uncertain(current))
        return { op: "confirm", entryId: current.id, why: "unknown-add-present" };
      // An unconfirmed removal of Gramps' own role that has not taken effect stays the newest row, so the role is
      // still Gramps' own and the removal is retried or confirmed if the reason ends again.
      if (current && (current.operation !== "remove" || uncertain(current)))
        return { op: "none", why: "already-recorded" };
      return { op: "note", basisId: facts.desiredBasis, why: "already-present" };
    }
    if (current?.operation === "add" && !uncertain(current))
      return { op: "note", basisId: facts.desiredBasis, why: "removed-in-discord" };
    if (current?.operation === "note") return { op: "none", why: "removed-in-discord" };
    return {
      op: "add",
      basisId: facts.desiredBasis,
      why: current?.operation === "add" ? "retry-unknown-add" : "desired",
    };
  }
  if (facts.kind === "founder") return { op: "none", why: "founder-kept" };
  if (!facts.endedBasis) return { op: "none", why: "no-basis" };
  // A removal is only ever started for a role Gramps added, so an unconfirmed one is still Gramps' own:
  // confirm it once the role is gone, and remove again while it is present.
  if (current?.operation === "remove" && uncertain(current))
    return facts.hasRole
      ? { op: "remove", basisId: facts.endedBasis, why: "retry-unknown-remove" }
      : { op: "confirm", entryId: current.id, why: "unknown-remove-absent" };
  const added = current?.operation === "add" && (current.changed || uncertain(current));
  if (!facts.hasRole)
    return added
      ? { op: "note", basisId: facts.endedBasis, why: "already-absent" }
      : { op: "none", why: "not-present" };
  if (added) return { op: "remove", basisId: facts.endedBasis, why: ENDED_WHY[facts.kind] };
  return { op: "none", why: "not-ours" };
}

export type DiscordFailure = "permission" | "unknown-role" | "left" | "rejected" | "transient";
/**
 * 50013/50001 and other 403s mean the bot cannot manage the role; 10011 means the role no longer exists;
 * 10007/10013 mean the member is gone. Other 4xx responses are refusals. Anything else (5xx after
 * discord.js retries, timeouts, network errors) leaves the result unknown.
 */
export function classifyDiscordError(error: unknown): DiscordFailure {
  const value = (error && typeof error === "object" ? error : {}) as { code?: unknown; status?: unknown };
  const status = typeof value.status === "number" ? value.status : null;
  if (value.code === 50013 || value.code === 50001 || status === 403) return "permission";
  if (value.code === 10011) return "unknown-role";
  if (value.code === 10007 || value.code === 10013) return "left";
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "rejected";
  return "transient";
}
/** Per-user backoff after an unknown result: 1 minute, 5 minutes, 30 minutes, 2 hours, then 6 hours. */
export const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;
export const WRITE_SPACING_MS = 1_100;
export const MAX_WRITES_PER_PASS = 50;
export const FOLLOW_UP_MS = 60_000;
export const EVENT_DEBOUNCE_MS = 2_000;
export const READY_POLL_MS = 5_000;
export const SAFETY_PASS_MS = 6 * 3_600_000;
/** Spacing between staff-requested real role checks. Previews do not count toward it. */
export const ADMIN_COOLDOWN_MS = 30_000;
/** Spacing between staff previews (dry runs), which only read, so one preview cannot be repeated back to back. */
export const PREVIEW_COOLDOWN_MS = 5_000;
export const MAX_PLAN_ENTRIES = 100;

const line = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    "Use a single-line reason.",
  );
export const reconcileSchema = z
  .object({
    id: z.uuid(),
    reason: line,
    discordUserId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type ReconcileInput = z.infer<typeof reconcileSchema>;

export type RoleCheckView = {
  id: string | null;
  name: string | null;
  exists: boolean;
  position: number | null;
  managed: boolean;
  privileged: boolean;
  staffRole: boolean;
  assignable: boolean;
  /** A plain-English fix, or null when the role can be assigned. */
  problem: string | null;
  /** Roles named exactly "UNC", "Founder" or "Supporter", listed only while the role ID is not set or wrong. */
  candidates?: { id: string; name: string }[];
};
export type RolesCheck = {
  manageRoles: boolean;
  highestRolePosition: number;
  roles: Record<DiscordRoleKind, RoleCheckView>;
};
export type AttentionItem = {
  kind: "founder_without_discord" | "not_in_server" | "removed_in_discord" | "failed";
  discordUserId?: string;
  supporterId?: string;
  displayName?: string | null;
  provider?: string;
  roleKind?: DiscordRoleKind;
  basisId?: string;
  at?: string;
};
export type PlanEntry = { discordUserId: string; roleKind: DiscordRoleKind | null; op: string; why: string };
export type PassSummary = {
  trigger: DiscordRoleTrigger;
  requestedBy: string | null;
  /** The staff reason for an admin-triggered pass. Kept with the in-memory result only. */
  reason?: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  users: number;
  added: number;
  removed: number;
  noted: number;
  confirmed: number;
  failed: number;
  /** Role kinds that could not be processed because a setup check or Discord refused them. */
  blocked: number;
  /** People left for a follow-up pass because this pass reached its write budget. */
  deferred: number;
  error: string | null;
  /** What this pass found. The status attention list also keeps items from earlier passes. */
  attention: AttentionItem[];
  plan?: PlanEntry[];
};
