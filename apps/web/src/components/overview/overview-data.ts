"use client";

import { z } from "zod";

const finite = z.number().finite();
const mapNames: Record<string, string> = { Kavkazi: "Bakurani", Europe: "Ozeti", NorthAmerica: "Zestafona" };
const modeNames: Record<string, string> = {
  Bakurani_KOTH_01: "King of the Hill",
  Madrid_KOTH_01: "King of the Hill",
  Detroit_KOTH_01: "King of the Hill",
  KOTH: "King of the Hill",
  KOTH_InfantryOnly: "Infantry only",
  KOTH_Hardcore: "Hardcore",
};
const lightingNames: Record<string, string> = {
  DayStartClear: "Dawn · clear",
  DayEarlyClear: "Early day · clear",
  DayEarlyFog: "Early day · fog",
  DayClear: "Day · clear",
  DayLateClear: "Late day · clear",
  DayLateGray: "Late day · overcast",
  DayLateGrayFog: "Late day · overcast & fog",
  DayEndClear: "Dusk · clear",
};
const factionCodes: Record<string, { code: string; label: string }> = {
  Valkyra: { code: "RED", label: "Red" },
  Lonestar: { code: "BLU", label: "Blue" },
  Manticore: { code: "GRN", label: "Green" },
};

const label = (names: Record<string, string>, id: string) => names[id] || id;
const mapLabel = (id: string) => label(mapNames, id);
const sameMap = (first: string | undefined, second: string | undefined) =>
  !!first && !!second && mapLabel(first) === mapLabel(second);
const modeLabel = (id: string) => label(modeNames, id);
const lightingLabel = (id: string) => label(lightingNames, id);

function zoneLabel(id: string) {
  if (id === "None") return "Map default";
  const match =
    /^ZoneAlternator\.(Bakurani|Ozeti|Zestafona)\.(Default|Farmland|Lumberyard|Church|River|SmallFactory|WaterTreatment|Houses)\.Circle$/.exec(
      id,
    );
  return match ? match[2].replace(/([a-z])([A-Z])/g, "$1 $2") : id;
}

function assignedFaction(value: string | null | undefined, factions: OverviewData["status"]["factionScores"]) {
  if (!value) return null;
  const code = value.toUpperCase();
  const matches = ["RED", "BLU", "GRN"].includes(code)
    ? factions.filter((team) => factionCodes[team.name]?.code === code)
    : factions.filter((team) => team.name === value);
  return matches.length === 1 ? matches[0].name : null;
}

export const overviewSchema = z.object({
  observedAt: z.string(),
  unlinkedPlayerCount: finite.optional(),
  status: z.object({
    serverName: z.string(),
    map: z.string(),
    lighting: z.string().optional(),
    alternator: z.string().optional(),
    experiences: z.array(z.string()).optional(),
    players: z.object({ current: finite, max: finite }),
    factionScores: z.array(z.object({ name: z.string(), score: finite })),
    scoreCap: finite.optional(),
    matchSeconds: finite.optional(),
  }),
  players: z.array(
    z.object({
      name: z.string(),
      steamId: z.string(),
      faction: z.string().nullable().optional(),
      kills: finite.optional(),
      deaths: finite.optional(),
      pingMs: finite.optional(),
    }),
  ),
});
export type OverviewData = z.infer<typeof overviewSchema>;

const mapSelectionSchema = z.object({
  map: z.string(),
  experiences: z.array(z.string()).default([]),
  lighting: z.string().optional(),
  zoneAlternator: z.string().optional(),
  denied: z.boolean().optional(),
  status: z.string().nullable().optional(),
});
export type MapSelectionData = z.infer<typeof mapSelectionSchema>;

export const settingsSchema = z.object({
  rotation: z.object({
    entries: z.array(mapSelectionSchema),
    currentIndex: finite.nullable(),
    nextIndex: finite.nullable(),
    currentMap: z.string(),
    enabled: z.boolean(),
    mode: z.string(),
  }),
});
export type SettingsData = z.infer<typeof settingsSchema>;

export const rotationSchema = z.object({
  entries: z.array(mapSelectionSchema),
  enabled: z.boolean(),
  mode: z.string(),
});
export type RotationData = z.infer<typeof rotationSchema>;

export const voteListSchema = z.object({
  enabled: z.boolean(),
  observedAt: z.string().optional(),
  votes: z.array(
    z.object({
      state: z.string(),
      closesAt: z.string(),
      counted: z.boolean().optional(),
      counts: z.array(finite).optional(),
    }),
  ),
});
export type VoteListData = z.infer<typeof voteListSchema>;

export const activitySchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      observedAt: z.string(),
      category: z.enum(["players", "match", "connection"]),
      message: z.string(),
    }),
  ),
});
export type ActivityData = z.infer<typeof activitySchema>;

const actionStateSchema = z.enum(["applied", "accepted", "pending", "failed", "unknown", "started"]);
export const auditSchema = z.array(
  z.object({
    id: z.string(),
    actorName: z.string(),
    action: z.string(),
    target: z.string(),
    state: actionStateSchema,
    message: z.string(),
    createdAt: z.string(),
    details: z.object({ reason: z.string(), playerName: z.string().optional() }),
  }),
);
export type AuditData = z.infer<typeof auditSchema>;

export const combatSchema = z.object({
  events: z.array(
    z.object({
      eventId: z.string(),
      serverInstanceId: z.string(),
      receivedAt: z.string(),
      killerName: z.string().nullable(),
      victimName: z.string().nullable(),
      cause: z.string().nullable(),
      distanceMeters: finite.nullable(),
      headshot: z.boolean(),
      suicide: z.boolean(),
    }),
  ),
});
export type CombatData = z.infer<typeof combatSchema>;

export class AdminApiError extends Error {
  constructor(readonly status: number) {
    super("The server data could not be loaded.");
  }
}

export async function readAdminApi<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new AdminApiError(response.status);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("The server returned data this page could not read.");
  return parsed.data;
}

export function serverApiPath(serverId: string, resource: string) {
  return /^[a-z][a-z0-9-]{0,39}$/.test(serverId)
    ? `/admin/api/servers/${encodeURIComponent(serverId)}/${resource}`
    : null;
}

/** Scope SWR entries by parser when several views read the same URL with different schemas. */
export type ApiResponseCacheScope =
  | "overview"
  | "players-overview"
  | "match-overview"
  | "announcement-overview"
  | "whitelist-overview"
  | "settings-summary"
  | "match-settings"
  | "settings-snapshot"
  | "vote-list"
  | "match-votes";

export function apiResponseCacheKey(path: string | null, scope: ApiResponseCacheScope) {
  return path ? ([path, `response:${scope}`] as const) : null;
}

export function formatElapsed(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "No clock";
  const total = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}` : minutes}:${pad(total % 60)} elapsed`;
}

export function formatObservedTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function mapDisplayName(value: string) {
  return mapLabel(value);
}

export function factionTone(name: string) {
  switch (name.toLowerCase()) {
    case "valkyra":
      return { dot: "bg-red-500", bar: "bg-red-500" };
    case "lonestar":
      return { dot: "bg-blue-500", bar: "bg-blue-500" };
    case "manticore":
      return { dot: "bg-green-500", bar: "bg-green-500" };
    default:
      return { dot: "bg-slate-500", bar: "bg-slate-500" };
  }
}

export function formatActivityTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? clock
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`;
}

export function formatCurrentSetup(status: OverviewData["status"]) {
  return [
    ...(status.experiences ?? []).map((id) => modeLabel(id)),
    status.alternator && status.alternator !== "None" ? zoneLabel(status.alternator) : "",
    status.lighting ? lightingLabel(status.lighting).replaceAll(" · ", " ") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function roundLabel(entry: MapSelectionData) {
  return [
    mapLabel(entry.map),
    ...entry.experiences.map((id) => modeLabel(id)),
    entry.zoneAlternator && entry.zoneAlternator !== "None" ? zoneLabel(entry.zoneAlternator) : "",
    entry.lighting ? lightingLabel(entry.lighting).replaceAll(" · ", " ") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function settingsNextRound(rotation: SettingsData["rotation"], currentMap: string) {
  if (!rotation.enabled || rotation.mode !== "Ordered" || !rotation.entries.length) {
    return {
      label: "No fixed next round",
      note: !rotation.enabled ? "Rotation is off" : `Rotation is ${rotation.mode.toLowerCase()}`,
    };
  }

  if (
    rotation.currentIndex !== null &&
    rotation.entries[rotation.currentIndex] &&
    sameMap(rotation.entries[rotation.currentIndex].map, currentMap)
  ) {
    const next = rotation.entries[(rotation.currentIndex + 1) % rotation.entries.length];
    return { label: roundLabel(next), note: "Saved next round" };
  }

  if (
    rotation.currentIndex === null &&
    rotation.nextIndex !== null &&
    Number.isInteger(rotation.nextIndex) &&
    rotation.entries[rotation.nextIndex]
  ) {
    return { label: roundLabel(rotation.entries[rotation.nextIndex]), note: "Game's next rotation entry" };
  }

  return { label: "Not confirmed", note: "Rotation position unknown" };
}

export function runningNextRound(rotation: RotationData, currentMap: string) {
  if (!rotation.enabled || rotation.mode !== "Ordered" || !rotation.entries.length) {
    return {
      label: "No fixed next round",
      note: !rotation.enabled ? "Rotation is off" : `Rotation is ${rotation.mode.toLowerCase()}`,
    };
  }

  const now = rotation.entries.flatMap((entry, index) => (entry.status === "now" ? [index] : []));
  const next = rotation.entries.flatMap((entry, index) => (entry.status === "next" ? [index] : []));
  if (now.length === 1) {
    const index = now[0];
    const nextEntry = rotation.entries[(index + 1) % rotation.entries.length];
    if (!rotation.entries[index].denied && !nextEntry.denied && sameMap(rotation.entries[index].map, currentMap)) {
      return { label: roundLabel(nextEntry), note: "Running rotation" };
    }
  }
  if (!now.length && next.length === 1 && !rotation.entries[next[0]].denied) {
    return { label: roundLabel(rotation.entries[next[0]]), note: "Game's next rotation entry" };
  }
  return { label: "Not confirmed", note: "Rotation position unknown" };
}

export function voteSummary(votes: VoteListData) {
  if (!votes.enabled) return "Off";
  const active = votes.votes.find((vote) => ["publishing", "open", "closing", "needs_review"].includes(vote.state));
  if (!active) return "None";
  const labels: Record<string, string> = {
    publishing: "Creating ballot",
    closing: "Counting votes",
    needs_review: "Needs review",
  };
  if (active.state !== "open") return labels[active.state] ?? "Vote in progress";
  const total = active.counted ? active.counts?.reduce((sum, count) => sum + count, 0) : undefined;
  const closeTime = formatObservedTime(active.closesAt);
  return `Open · ends ${closeTime}${total === undefined ? "" : ` · ${total} ${total === 1 ? "vote" : "votes"}`}`;
}

export function factionFor(player: OverviewData["players"][number], teams: OverviewData["status"]["factionScores"]) {
  const name = assignedFaction(player.faction, teams);
  const team = teams.find((entry) => entry.name === name);
  if (!team) return null;
  const factionLabel = factionCodes[team.name]?.label;
  return { ...team, tone: factionTone(team.name), label: factionLabel ? `${factionLabel} · ${team.name}` : team.name };
}
