import { z } from "zod";

const messageSequence = z.array(z.string());

export const communityMessagesSchema = z.object({
  enabled: z.boolean(),
  workerStarted: z.boolean(),
  lastObservedAt: z.string().nullable(),
  lastMessageAcknowledgedAt: z.string().nullable(),
  lastStatusCardUpdatedAt: z.string().nullable(),
  welcome: z.object({
    enabled: z.boolean(),
    messages: messageSequence,
    variants: z.array(messageSequence).optional(),
    whitelistedVariants: z.array(messageSequence).nullable().optional(),
    whitelist: z
      .object({
        source: z.literal("running-whitelist"),
        cacheSeconds: z.number(),
        lastLoadedAt: z.string().nullable(),
        lastFailedAt: z.string().nullable(),
      })
      .nullable()
      .optional(),
    delaySeconds: z.number(),
    spacingSeconds: z.number(),
  }),
  round: z.object({
    enabled: z.boolean(),
    message: z.string(),
    messages: messageSequence.optional(),
  }),
  discordStatus: z.object({
    enabled: z.boolean(),
    configured: z.boolean(),
    problem: z.string().nullable(),
  }),
});

export const announcementOverviewSchema = z.object({
  observedAt: z.string(),
  status: z.object({
    players: z.object({ current: z.number().finite(), max: z.number().finite() }),
  }),
  capabilities: z.object({ routes: z.array(z.string()) }),
});

export type CommunityMessages = z.infer<typeof communityMessagesSchema>;
export type AnnouncementOverview = z.infer<typeof announcementOverviewSchema>;

export const liveRefreshOptions = {
  refreshInterval: 15_000,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

export function hasBroadcastRoute(routes: string[]) {
  return routes.some((route) => route.trim().replace(/\{[^}]*\}|:[^/\s]+/g, "*") === "POST /v1/broadcast");
}

export function isOverviewFresh(overview: AnnouncementOverview | undefined, now = Date.now()) {
  if (!overview) return false;
  const observedAt = Date.parse(overview.observedAt);
  return Number.isFinite(observedAt) && now - observedAt <= 30_000 && observedAt <= now + 5_000;
}

export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatSeconds(value: number) {
  return value >= 60 && value % 60 === 0 ? `${value / 60} min` : `${value} s`;
}

export function displayDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not recorded";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
