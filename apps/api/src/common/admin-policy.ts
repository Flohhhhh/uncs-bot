// Pure policy shared by HTTP authorization and the browser. No server dependencies.
export type StaffRole = "viewer" | "moderator" | "admin";
export const moderatorActions = ["kick", "ban", "unban", "message", "kill", "team", "broadcast"] as const;
export type ActionName =
  | (typeof moderatorActions)[number]
  | "whitelist-add"
  | "whitelist-remove"
  | "match-end"
  | "match-restart"
  | "map"
  | "lighting"
  | "settings-save"
  | "rotation-save"
  | "map-next";
/** Explicit Discord identities for staff access: owner user IDs and role IDs from the environment. */
export type StaffPolicy = {
  ownerIds: readonly string[];
  adminRoleIds: readonly string[];
  moderatorRoleIds: readonly string[];
  viewerRoleIds: readonly string[];
};
/**
 * The staff role a Discord member holds under the policy, or undefined. Only the listed IDs count:
 * Discord permissions, including Administrator, never grant staff access on their own here.
 */
export function staffRoleFor(userId: string, roles: readonly string[], policy: StaffPolicy): StaffRole | undefined {
  const matches = (allowed: readonly string[]) => roles.some((role) => allowed.includes(role));
  if (policy.ownerIds.includes(userId) || matches(policy.adminRoleIds)) return "admin";
  if (matches(policy.moderatorRoleIds)) return "moderator";
  if (matches(policy.viewerRoleIds)) return "viewer";
  return undefined;
}
export function canAct(role: StaffRole, action: ActionName) {
  return role === "admin" || (role === "moderator" && (moderatorActions as readonly string[]).includes(action));
}
export function serves(capabilities: { routes: string[] }, method: string, path: string) {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/\{[^}]*\}|:[^/\s]+/g, "*")
      .replace(/\s+/g, " ");
  return capabilities.routes.some((route) => normalize(route) === normalize(`${method} ${path}`));
}
