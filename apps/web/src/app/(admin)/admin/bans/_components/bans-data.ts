import { z } from "zod";

export const bansResponseSchema = z.object({
  bans: z.array(
    z.object({
      steamId: z.string(),
      bannedAtUtc: z.string().nullable().optional(),
      bannedBy: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    }),
  ),
});

export type Ban = z.infer<typeof bansResponseSchema>["bans"][number];

export function isPublicIndividualSteamId(value: string) {
  if (value.length !== 17 || !/^\d{17}$/.test(value)) return false;
  const id = BigInt(value);
  return id >= 76561197960265729n && id <= 76561202255233023n;
}

export function banTimestamp(value: string | null | undefined) {
  if (!value || value.startsWith("0001")) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatBanDate(value: string | null | undefined) {
  const timestamp = banTimestamp(value);
  return timestamp === null ? "Date not provided" : new Date(timestamp).toLocaleString();
}

export function banSearchText(ban: Ban, playerName?: string) {
  return [ban.steamId, playerName, ban.reason, ban.bannedBy].filter(Boolean).join(" ").toLocaleLowerCase();
}

export function servesBanRoute(routes: string[], method: string, path: string) {
  const normalize = (route: string) =>
    route
      .trim()
      .replace(/\{[^}]*\}|:[^/\s]+/g, "*")
      .replace(/\s+/g, " ");
  const target = normalize(method + " " + path);
  return routes.some((route) => normalize(route) === target);
}
