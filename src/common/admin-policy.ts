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
