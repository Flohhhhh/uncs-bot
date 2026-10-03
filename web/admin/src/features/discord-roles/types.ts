/**
 * Mirrors GET /admin/api/discord-roles and POST /admin/api/discord-roles/reconcile from
 * src/discord-roles/discord-roles.service.ts and discord-roles.types.ts (draft #117).
 */
export const ROLE_KINDS = ["member", "founder", "supporter"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** One configured role as Discord reports it. `problem` is a plain-English fix, or null when it can be assigned. */
export interface RoleCheck {
  id: string | null;
  name: string | null;
  exists: boolean;
  position: number | null;
  managed: boolean;
  privileged: boolean;
  staffRole: boolean;
  assignable: boolean;
  problem: string | null;
  /** Roles named exactly "UNC", "Founder" or "Supporter", listed only while the role ID is not set or wrong. */
  candidates?: { id: string; name: string }[];
}
export interface AttentionItem {
  /** "founder_without_discord", "not_in_server", "removed_in_discord" or "failed"; others are shown generically. */
  kind: string;
  discordUserId?: string;
  supporterId?: string;
  displayName?: string | null;
  provider?: string;
  roleKind?: RoleKind;
  basisId?: string;
  at?: string;
}
/** A dry-run entry. `op` is add, remove, note, confirm or none; `roleKind` is null for a person-level entry. */
export interface PlanEntry {
  discordUserId: string;
  roleKind: RoleKind | null;
  op: string;
  why: string;
}
export interface PassSummary {
  /** startup, event, member-join, admin or schedule. */
  trigger: string;
  requestedBy: string | null;
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
  blocked: number;
  deferred: number;
  error: string | null;
  attention: AttentionItem[];
  /** Only on a dry run: at most 100 entries. */
  plan?: PlanEntry[];
}
/** A discord_role_actions row. */
export interface RoleLedgerRow {
  id: string;
  actorId: string;
  actorName: string;
  requestedBy: string | null;
  trigger: string;
  guildId: string;
  discordUserId: string;
  roleKind: RoleKind;
  roleId: string;
  /** add, remove or note. */
  operation: string;
  basisType: string;
  basisId: string;
  changed: boolean;
  /** started, applied, failed or unknown. */
  state: string;
  message: string;
  createdAt: string;
  completedAt: string | null;
}
export interface DiscordRolesStatus {
  enabled: boolean;
  configured: { guild: boolean; memberRole: boolean; founderRole: boolean; supporterRole: boolean };
  discordReady: boolean;
  /** Null while Discord is not connected or the server could not be read. */
  bot: { manageRoles: boolean | null; highestRolePosition: number | null };
  roles: Record<RoleKind, RoleCheck>;
  /** Every configured role passes its checks. */
  ready: boolean;
  running: boolean;
  lastPass: PassSummary | null;
  /** The last check of everyone: startup, the six-hour safety pass or an untargeted staff run. */
  lastFullPass: PassSummary | null;
  queued: number;
  fullPassQueued: boolean;
  nextRetryAt: string | null;
  /** `supporterEligible` is null while DISCORD_SUPPORTER_ROLE_ID is unset. */
  summary: {
    memberEligible: number;
    founders: number;
    foundersWithoutDiscord: number;
    supporterEligible: number | null;
  };
  attention: AttentionItem[];
  /** The latest 25 role ledger rows. */
  recent: RoleLedgerRow[];
  note?: string;
}
export interface ReconcileResponse {
  ok: boolean;
  replayed: boolean;
  summary: PassSummary;
}
export const MAX_PLAN_ENTRIES = 100;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const optionalText = (value: unknown) => value === undefined || text(value);
const bool = (value: unknown): value is boolean => typeof value === "boolean";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
const time = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const nullableTime = (value: unknown) => value === null || time(value);
const snowflake = (value: unknown): value is string => text(value) && /^\d{17,20}$/.test(value);
const roleKind = (value: unknown): value is RoleKind => (ROLE_KINDS as readonly unknown[]).includes(value);
const list = (value: unknown, limit: number, item: (entry: unknown) => boolean) =>
  Array.isArray(value) && value.length <= limit && value.every(item);

function roleCheck(value: unknown) {
  return (
    record(value) &&
    nullableText(value.id) &&
    nullableText(value.name) &&
    bool(value.exists) &&
    (value.position === null || (typeof value.position === "number" && Number.isFinite(value.position))) &&
    bool(value.managed) &&
    bool(value.privileged) &&
    bool(value.staffRole) &&
    bool(value.assignable) &&
    nullableText(value.problem) &&
    (value.candidates === undefined ||
      list(value.candidates, 50, (entry) => record(entry) && text(entry.id) && text(entry.name)))
  );
}
function attentionItem(value: unknown) {
  return (
    record(value) &&
    text(value.kind) &&
    (value.discordUserId === undefined || snowflake(value.discordUserId)) &&
    optionalText(value.supporterId) &&
    (value.displayName === undefined || nullableText(value.displayName)) &&
    optionalText(value.provider) &&
    (value.roleKind === undefined || roleKind(value.roleKind)) &&
    optionalText(value.basisId) &&
    (value.at === undefined || time(value.at))
  );
}
function planEntry(value: unknown) {
  return (
    record(value) &&
    snowflake(value.discordUserId) &&
    (value.roleKind === null || roleKind(value.roleKind)) &&
    text(value.op) &&
    text(value.why)
  );
}
function passSummary(value: unknown) {
  return (
    record(value) &&
    text(value.trigger) &&
    nullableText(value.requestedBy) &&
    optionalText(value.reason) &&
    bool(value.dryRun) &&
    time(value.startedAt) &&
    // An unfinished summary has an empty finish time.
    text(value.finishedAt) &&
    [
      value.users,
      value.added,
      value.removed,
      value.noted,
      value.confirmed,
      value.failed,
      value.blocked,
      value.deferred,
    ].every(count) &&
    nullableText(value.error) &&
    list(value.attention, 500, attentionItem) &&
    (value.plan === undefined || list(value.plan, MAX_PLAN_ENTRIES, planEntry))
  );
}
function ledgerRow(value: unknown) {
  return (
    record(value) &&
    [
      value.id,
      value.actorId,
      value.actorName,
      value.trigger,
      value.guildId,
      value.roleId,
      value.operation,
      value.basisType,
      value.basisId,
      value.state,
      value.message,
    ].every(text) &&
    nullableText(value.requestedBy) &&
    snowflake(value.discordUserId) &&
    roleKind(value.roleKind) &&
    bool(value.changed) &&
    time(value.createdAt) &&
    nullableTime(value.completedAt)
  );
}

// These guards check the browser contract, not authority: the server checks the administrator role on every request.
export function validateRolesStatus(value: unknown): DiscordRolesStatus {
  const configured = record(value) ? value.configured : null;
  const bot = record(value) ? value.bot : null;
  const roles = record(value) ? value.roles : null;
  const summary = record(value) ? value.summary : null;
  if (
    !record(value) ||
    !bool(value.enabled) ||
    !record(configured) ||
    ![configured.guild, configured.memberRole, configured.founderRole, configured.supporterRole].every(bool) ||
    !bool(value.discordReady) ||
    !record(bot) ||
    !(bot.manageRoles === null || bool(bot.manageRoles)) ||
    !(bot.highestRolePosition === null || count(bot.highestRolePosition)) ||
    !record(roles) ||
    !ROLE_KINDS.every((kind) => roleCheck(roles[kind])) ||
    !bool(value.ready) ||
    !bool(value.running) ||
    !(value.lastPass === null || passSummary(value.lastPass)) ||
    !(value.lastFullPass === null || passSummary(value.lastFullPass)) ||
    !count(value.queued) ||
    !bool(value.fullPassQueued) ||
    !nullableTime(value.nextRetryAt) ||
    !record(summary) ||
    ![summary.memberEligible, summary.founders, summary.foundersWithoutDiscord].every(count) ||
    !(summary.supporterEligible === null || count(summary.supporterEligible)) ||
    !list(value.attention, 500, attentionItem) ||
    !list(value.recent, 100, ledgerRow) ||
    !optionalText(value.note)
  )
    throw new Error("The Discord roles status could not be verified. Refresh before running a role check.");
  return value as unknown as DiscordRolesStatus;
}

/** A preview must come back as a dry run with its plan; a real run must not. */
export function validateReconcile(value: unknown, dryRun: boolean): ReconcileResponse {
  if (
    !record(value) ||
    value.ok !== true ||
    !bool(value.replayed) ||
    !passSummary(value.summary) ||
    !record(value.summary) ||
    value.summary.dryRun !== dryRun ||
    (dryRun && !Array.isArray(value.summary.plan))
  )
    throw new Error(
      dryRun
        ? "The preview could not be read. Nothing was changed; preview again."
        : "The role check result could not be read. Refresh and check Recent role changes before running it again.",
    );
  return value as unknown as ReconcileResponse;
}
