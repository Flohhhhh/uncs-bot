import { z } from "zod";

const selection = z.object({
  map: z.string(),
  experiences: z.array(z.string()).default([]),
  lighting: z.string().optional(),
  zoneAlternator: z.string().optional(),
  denied: z.boolean().optional(),
  status: z.string().nullable().optional(),
});

export const matchSettingsSchema = z.object({
  revision: z.string(),
  writable: z.boolean(),
  notice: z.string(),
  fields: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).nullable() })),
  rotation: z.object({
    entries: z.array(selection),
    editable: z.boolean(),
    note: z.string(),
    currentIndex: z.number().int().nullable(),
    nextIndex: z.number().int().nullable(),
    positionNote: z.string(),
    currentMap: z.string(),
    enabled: z.boolean(),
    mode: z.string(),
  }),
});

export const matchOverviewSchema = z.object({
  observedAt: z.string(),
  status: z.object({
    serverName: z.string(),
    map: z.string(),
    lighting: z.string().optional(),
    alternator: z.string().optional(),
    experiences: z.array(z.string()).optional(),
    players: z.object({ current: z.number(), max: z.number() }),
    factionScores: z.array(z.object({ name: z.string(), score: z.number() })),
    matchSeconds: z.number().optional(),
  }),
  players: z.array(z.object({ name: z.string(), steamId: z.string() })).optional(),
  capabilities: z.object({ routes: z.array(z.string()) }),
});

export const matchCatalogSchema = z.object({
  maps: z.array(z.object({ id: z.string(), displayName: z.string().optional() })),
  experiences: z.array(z.object({ id: z.string(), displayName: z.string().optional() })),
  lightings: z.array(z.object({ id: z.string(), displayName: z.string().optional() })),
});

export const mapOptionsSchema = z.object({
  experiences: z.array(z.object({ id: z.string(), displayName: z.string().optional() })),
  zones: z.array(z.string()).nullable(),
});

export const matchVotesSchema = z.object({
  enabled: z.boolean(),
  observedAt: z.string(),
  automatic: z
    .object({ enabled: z.boolean(), message: z.string(), phase: z.string().optional() })
    .nullable()
    .optional(),
  votes: z.array(
    z.object({
      id: z.string(),
      actorName: z.string(),
      reason: z.string(),
      choices: z.array(selection),
      state: z.string(),
      winner: z.number().int().nullable(),
      counts: z.array(z.number()).default([]),
      counted: z.boolean().optional(),
      createdAt: z.string(),
      closesAt: z.string(),
      message: z.string(),
      messageUrl: z.string().nullable().optional(),
    }),
  ),
});

export const matchEventsSchema = z.object({
  enabled: z.boolean(),
  serverId: z.string(),
  events: z.array(
    z.object({
      id: z.string(),
      actorName: z.string(),
      reason: z.string(),
      options: z.object({
        teams: z.tuple([z.string(), z.string()]),
        durationMinutes: z.number(),
        source: z.object({ kind: z.string() }).optional(),
      }),
      state: z.string(),
      message: z.string(),
      movedThisRound: z.number().optional(),
      stop: z.object({ reason: z.string(), at: z.string() }).nullable().optional(),
      createdAt: z.string(),
      endsAt: z.string(),
    }),
  ),
});

export type MatchSettings = z.infer<typeof matchSettingsSchema>;
export type MatchSelection = z.infer<typeof selection>;
export type MatchCatalog = z.infer<typeof matchCatalogSchema>;
export type MatchOverview = z.infer<typeof matchOverviewSchema>;
export type MatchMapOptions = z.infer<typeof mapOptionsSchema>;
export type MatchControl = "lighting" | "map" | "match-end" | "match-restart";

export function isMatchSelectionReady(
  selection: MatchSelection,
  catalog: MatchCatalog | undefined,
  options: MatchMapOptions | undefined,
) {
  return Boolean(
    selection.map &&
    catalog?.maps.some((map) => map.id === selection.map) &&
    options &&
    selection.experiences.every((id) => options.experiences.some((experience) => experience.id === id)) &&
    (!selection.zoneAlternator ||
      selection.zoneAlternator === "None" ||
      options.zones?.includes(selection.zoneAlternator)) &&
    (!selection.lighting || catalog.lightings.some((lighting) => lighting.id === selection.lighting)),
  );
}

export const liveRefreshOptions = {
  refreshInterval: 15_000,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

export function voteSummary(votes: z.infer<typeof matchVotesSchema> | undefined) {
  if (!votes?.enabled) return "Off";
  const active = votes.votes.find((vote) => vote.state === "open");
  return active
    ? `Open · closes ${new Date(active.closesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "On · no open vote";
}

export function stateLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
