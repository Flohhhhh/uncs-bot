import type { z } from "zod";
import { rolesCheck } from "@uncs/contracts";
export type RolesCheck = z.infer<typeof rolesCheck>;
export type RoleCheckView = RolesCheck["roles"]["member"];
export type DiscordRoleKind = "member" | "founder" | "supporter";
export const ROLE_KINDS = ["member", "founder", "supporter"] as const;
export type DiscordFailure = "permission" | "unknown-role" | "left" | "rejected" | "transient";
export function classifyDiscordError(error: unknown): DiscordFailure {
  const value = (error && typeof error === "object" ? error : {}) as { code?: unknown; status?: unknown };
  const status = typeof value.status === "number" ? value.status : null;
  if (value.code === 50013 || value.code === 50001 || status === 403) return "permission";
  if (value.code === 10011) return "unknown-role";
  if (value.code === 10007 || value.code === 10013) return "left";
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "rejected";
  return "transient";
}
