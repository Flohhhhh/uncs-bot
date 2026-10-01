import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";

export const GAME_LOG_LIMIT = 100;
export type GameLogEntry = {
  timestamp: string | null;
  event: string;
  operation: string | null;
  statusCode: number | null;
  changesState: boolean;
};
export type GameLog = {
  available: boolean;
  observedAt: string;
  limit: number;
  entries: GameLogEntry[];
};

const events = new Set(["HTTP", "COMMAND", "ACCEPT", "AUTH_OK", "AUTH_FAIL", "REJECT", "CLOSE"]);
const staticPaths = new Set([
  "/v1/capabilities",
  "/v1/health",
  "/v1/status",
  "/v1/players",
  "/v1/bans",
  "/v1/reserved-slots",
  "/v1/broadcast",
  "/v1/match/end",
  "/v1/match/restart",
  "/v1/match/map",
  "/v1/world/lighting",
  "/v1/rotation",
  "/v1/config",
  "/v1/config/validate",
  "/v1/audit",
  "/v1/sponsor",
  "/v1/server-id",
  "/v1/catalog/maps",
  "/v1/catalog/experiences",
  "/v1/catalog/lightings",
]);
function safePath(path: string) {
  const pathname = path.split("?")[0];
  if (staticPaths.has(pathname)) return pathname;
  const player = /^\/v1\/(?:players|bans|reserved-slots)\/(\d{17})(?:\/(?:kick|kill|message))?$/.exec(pathname);
  if (player && isPublicIndividualSteamId(player[1])) return pathname;
  const catalog = /^\/v1\/catalog\/maps\/[^/]+\/(experiences|alternators)$/.exec(pathname);
  return catalog ? `/v1/catalog/maps/{map}/${catalog[1]}` : null;
}

/** Only known request summaries leave the backend. Never forward raw detail,
 * peer addresses, session IDs, query values, bodies or unknown event strings. */
export function parseGameLog(value: unknown): GameLogEntry[] {
  const body = z.object({ entries: z.array(z.unknown()).max(500) }).parse(value);
  return body.entries.slice(0, GAME_LOG_LIMIT).map((raw) => {
    const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const date =
      typeof entry.timestampUtc === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(entry.timestampUtc)
        ? Date.parse(entry.timestampUtc)
        : NaN;
    const event = typeof entry.event === "string" && events.has(entry.event) ? entry.event : "OTHER";
    const http =
      typeof entry.detail === "string" && entry.detail.length <= 500
        ? /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE) (\/v1\/\S+) -> ([1-5]\d{2})$/.exec(entry.detail)
        : null;
    const path = http ? safePath(http[2]) : null;
    return {
      timestamp: Number.isFinite(date) ? new Date(date).toISOString() : null,
      event,
      operation: http && path ? `${http[1]} ${path}` : null,
      statusCode: http && path ? Number(http[3]) : null,
      changesState: !!(
        http &&
        path &&
        !["GET", "HEAD", "OPTIONS"].includes(http[1]) &&
        !(http[1] === "POST" && path === "/v1/config/validate")
      ),
    };
  });
}
