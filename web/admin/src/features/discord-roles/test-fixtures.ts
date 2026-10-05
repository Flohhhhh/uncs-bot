import type {
  DiscordRolesStatus,
  PassSummary,
  PlanEntry,
  ReconcileResponse,
  RoleCheck,
  RoleKind,
  RoleLedgerRow,
} from "./types";

/** Sample Discord user IDs; none belongs to a real account. */
export const members = {
  newUnc: "310000000000000001",
  founder: "310000000000000004",
  revoked: "310000000000000006",
  tagged: "310000000000000007",
  away: "310000000000000008",
  refused: "310000000000000012",
};
const ready = (id: string, name: string, position: number): RoleCheck => ({
  id,
  name,
  exists: true,
  position,
  managed: false,
  privileged: false,
  staffRole: false,
  assignable: true,
  problem: null,
});
export function pass(overrides: Partial<PassSummary> = {}): PassSummary {
  return {
    trigger: "startup",
    requestedBy: null,
    dryRun: false,
    startedAt: "2026-10-03T12:00:00.000Z",
    finishedAt: "2026-10-03T12:00:09.000Z",
    users: 10,
    added: 2,
    removed: 1,
    noted: 3,
    confirmed: 0,
    failed: 1,
    blocked: 0,
    deferred: 4,
    error: null,
    attention: [],
    ...overrides,
  };
}
export function ledgerRow(index: number, overrides: Partial<RoleLedgerRow> = {}): RoleLedgerRow {
  return {
    id: `01234567-89ab-4cde-8fab-${String(index).padStart(12, "0")}`,
    actorId: "system:discord-roles",
    actorName: "Gramps Discord roles",
    requestedBy: null,
    trigger: "schedule",
    guildId: "111111111111111111",
    discordUserId: `3200000000000${String(index).padStart(5, "0")}`,
    roleKind: "member",
    roleId: "600000000000000001",
    operation: "add",
    basisType: "application",
    basisId: "01234567-89ab-4cde-8fab-0123456789ab",
    changed: true,
    state: "applied",
    message: "Role added.",
    createdAt: new Date(Date.UTC(2026, 9, 3, 12, 0) - index * 60_000).toISOString(),
    completedAt: new Date(Date.UTC(2026, 9, 3, 12, 0) - index * 60_000).toISOString(),
    ...overrides,
  };
}
/** Off, with UNC and Founder ready and the optional Supporter role not set up: "Ready to switch on". */
export function rolesStatus(overrides: Partial<DiscordRolesStatus> = {}): DiscordRolesStatus {
  return {
    enabled: false,
    configured: { guild: true, memberRole: true, founderRole: true, supporterRole: false },
    discordReady: true,
    bot: { manageRoles: true, highestRolePosition: 14 },
    roles: {
      member: ready("600000000000000001", "UNC", 9),
      founder: ready("600000000000000002", "Founder", 10),
      supporter: {
        id: null,
        name: null,
        exists: false,
        position: null,
        managed: false,
        privileged: false,
        staffRole: false,
        assignable: false,
        problem:
          "Set DISCORD_SUPPORTER_ROLE_ID to the Supporter role ID (Server Settings, Roles, right-click the role, Copy Role ID).",
        candidates: [{ id: "600000000000000003", name: "Supporter" }],
      },
    },
    ready: true,
    running: false,
    lastPass: null,
    lastFullPass: null,
    queued: 0,
    fullPassQueued: false,
    nextRetryAt: null,
    summary: { memberEligible: 42, founders: 6, foundersWithoutDiscord: 2, supporterEligible: null },
    attention: [
      {
        kind: "founder_without_discord",
        supporterId: "01234567-89ab-4cde-8fab-0123456789ac",
        displayName: "Grandpa Joe",
        provider: "paypal",
        at: "2026-10-02T12:00:00.000Z",
      },
      { kind: "not_in_server", discordUserId: members.away, at: "2026-10-03T09:00:00.000Z" },
      { kind: "failed", discordUserId: members.refused, roleKind: "member", at: "2026-10-03T09:00:00.000Z" },
    ],
    recent: [ledgerRow(1), ledgerRow(2, { operation: "note", changed: false, message: "Already present." })],
    note: "Gramps adds and removes only the roles it manages.",
    ...overrides,
  };
}
/**
 * What the server reports when it could not read Discord (not connected, ADMIN_GUILD_ID unset or unreadable): no bot
 * facts, and every role, configured or not, carries that same reason as its problem.
 */
export function unreadStatus(problem: string, overrides: Partial<DiscordRolesStatus> = {}): DiscordRolesStatus {
  const status = rolesStatus();
  const unread = (kind: RoleKind): RoleCheck => ({
    id: kind === "supporter" ? null : status.roles[kind].id,
    name: null,
    exists: false,
    position: null,
    managed: false,
    privileged: false,
    staffRole: false,
    assignable: false,
    problem,
  });
  return {
    ...status,
    discordReady: false,
    ready: false,
    bot: { manageRoles: null, highestRolePosition: null },
    roles: { member: unread("member"), founder: unread("founder"), supporter: unread("supporter") },
    ...overrides,
  };
}
export const adds: PlanEntry[] = [
  { discordUserId: members.newUnc, roleKind: "member", op: "add", why: "desired" },
  { discordUserId: members.founder, roleKind: "founder", op: "add", why: "desired" },
];
export const removal: PlanEntry = {
  discordUserId: members.revoked,
  roleKind: "member",
  op: "remove",
  why: "application-revoked",
};
export const notes: PlanEntry[] = [
  { discordUserId: members.tagged, roleKind: "member", op: "note", why: "already-present" },
  { discordUserId: members.away, roleKind: null, op: "none", why: "not-in-server" },
];
export function dryRun(plan: PlanEntry[], overrides: Partial<PassSummary> = {}): ReconcileResponse {
  return {
    ok: true,
    replayed: false,
    // A dry run counts the people it read; its plan, not the counts, says what would change.
    summary: pass({
      trigger: "admin",
      requestedBy: "12345678901234567",
      reason: "Preview from the dashboard",
      dryRun: true,
      users: plan.length,
      added: 0,
      removed: 0,
      noted: 0,
      failed: 0,
      deferred: 0,
      plan,
      ...overrides,
    }),
  };
}
