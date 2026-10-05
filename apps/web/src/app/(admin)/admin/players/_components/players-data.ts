import { z } from "zod";

const finite = z.number().finite();

export const playersOverviewSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  unlinkedPlayerCount: z.number().int().nonnegative().optional(),
  status: z.object({
    serverName: z.string(),
    map: z.string(),
    matchSeconds: finite.optional(),
    players: z.object({ current: finite, max: finite }),
    factionScores: z.array(z.object({ name: z.string(), score: finite })),
  }),
  players: z.array(
    z.object({
      name: z.string(),
      steamId: z.string().regex(/^\d{17}$/),
      faction: z.string().nullable().optional(),
      kills: finite.optional(),
      deaths: finite.optional(),
      cash: finite.optional(),
      pingMs: finite.optional(),
    }),
  ),
  capabilities: z.object({
    build: z.string().optional(),
    routes: z.array(z.string()),
    config: z.object({ writable: z.boolean() }).optional(),
    limits: z.object({ maxRequestsPerMinutePerIp: finite.optional() }).optional(),
  }),
});

export type PlayersOverview = z.infer<typeof playersOverviewSchema>;
export type Player = PlayersOverview["players"][number];
export type Team = PlayersOverview["status"]["factionScores"][number];
export type PlayerAction = "message" | "team" | "kick" | "ban" | "whitelist-add" | "kill";

export const TEAM_TONES = {
  Valkyra: { dot: "bg-red-500", badge: "border-red-500/30 bg-red-500/10 text-red-400" },
  Lonestar: { dot: "bg-blue-500", badge: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
  Manticore: { dot: "bg-green-500", badge: "border-green-500/30 bg-green-500/10 text-green-400" },
} as const;

const FACTION_CODES: Record<string, string> = {
  Valkyra: "RED",
  Lonestar: "BLU",
  Manticore: "GRN",
};

const ACTION_ROUTES: Record<Exclude<PlayerAction, "whitelist-add">, { method: string; path: string }> = {
  message: { method: "POST", path: "/v1/players/{id}/message" },
  team: { method: "PATCH", path: "/v1/players/{id}" },
  kick: { method: "POST", path: "/v1/players/{id}/kick" },
  ban: { method: "POST", path: "/v1/bans" },
  kill: { method: "POST", path: "/v1/players/{id}/kill" },
};

const STAFF_ACTIONS: readonly PlayerAction[] = ["message", "team", "kick", "ban", "kill"];

export function teamFor(player: Player, teams: Team[]): Team | undefined {
  if (!player.faction) return undefined;
  const exact = teams.filter((team) => team.name === player.faction);
  if (exact.length === 1) return exact[0];
  const factionCode = player.faction.toUpperCase();
  const coded = teams.filter((team) => FACTION_CODES[team.name] === factionCode);
  return coded.length === 1 ? coded[0] : undefined;
}

export function toneFor(teamName: string) {
  return (
    TEAM_TONES[teamName as keyof typeof TEAM_TONES] ?? {
      dot: "bg-muted-foreground",
      badge: "border-border bg-muted text-muted-foreground",
    }
  );
}

function normalizeRoute(route: string) {
  return route
    .trim()
    .replace(/\{[^}]*\}|:[^/\s]+/g, "*")
    .replace(/\s+/g, " ");
}

function serves(overview: PlayersOverview, method: string, path: string) {
  const target = normalizeRoute(`${method} ${path}`);
  return overview.capabilities.routes.some((route) => normalizeRoute(route) === target);
}

export function canPlayerAction(
  action: PlayerAction,
  role: "admin" | "moderator" | "viewer",
  overview: PlayersOverview | undefined,
  stale: boolean,
  busy: boolean,
) {
  if (!overview || stale || busy) return false;
  if (role !== "admin" && !(role === "moderator" && STAFF_ACTIONS.includes(action))) return false;

  if (action === "whitelist-add") {
    return (
      serves(overview, "POST", "/v1/reserved-slots") ||
      (serves(overview, "PUT", "/v1/config") && overview.capabilities.config?.writable !== false)
    );
  }

  const route = ACTION_ROUTES[action];
  return serves(overview, route.method, route.path);
}

export type RoundStamp = { map: string; startedAt: number };

export function roundStamp(overview: PlayersOverview): RoundStamp | null {
  const observedAt = Date.parse(overview.observedAt);
  const elapsed = overview.status.matchSeconds;
  if (!Number.isFinite(observedAt) || elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0) return null;
  return { map: overview.status.map, startedAt: observedAt - elapsed * 1000 };
}

export function sameRound(first: RoundStamp, second: RoundStamp) {
  const aliases: Record<string, string> = { Kavkazi: "Bakurani", Europe: "Ozeti", NorthAmerica: "Zestafona" };
  return (
    (aliases[first.map] ?? first.map) === (aliases[second.map] ?? second.map) &&
    Math.abs(first.startedAt - second.startedAt) <= 30_000
  );
}

export function isRosterFresh(overview: PlayersOverview, now = Date.now()) {
  const observedAt = Date.parse(overview.observedAt);
  return Number.isFinite(observedAt) && now - observedAt <= 30_000 && observedAt <= now + 5_000;
}

export function moveSpacing(overview: PlayersOverview) {
  const allowance = overview.capabilities.limits?.maxRequestsPerMinutePerIp;
  return Math.max(2_200, allowance ? Math.ceil((60_000 * 7) / (allowance / 2)) : 0);
}
