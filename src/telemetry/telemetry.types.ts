import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";

export const MAX_FEED_BYTES = 65_536;
export const periodSchema = z.enum(["day", "week", "month"]);
export type TelemetryPeriod = z.infer<typeof periodSchema>;
export const periodMilliseconds: Record<TelemetryPeriod, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};
export const telemetrySteamId = z.string().refine(isPublicIndividualSteamId);
const linkedId = z
  .unknown()
  .transform((value) => (telemetrySteamId.safeParse(value).success ? (value as string) : null));
const feedText = z
  .string()
  .max(200)
  .transform((value) =>
    [...value]
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .trim(),
  );
const optionalText = feedText.nullish().transform((value) => value || null);
const eventSchema = z.object({
  eventId: z.uuid(),
  type: z.literal("killed"),
  eventTime: z.number().min(0).max(1e12),
  matchId: z.uuid().nullish(),
  mapName: optionalText,
  killerSteamId: linkedId,
  killerName: optionalText,
  victimSteamId: linkedId,
  victimName: optionalText,
  cause: optionalText,
  distance: z.number().min(0).max(1e12).nullish(),
  contextTags: z
    .array(feedText)
    .max(32)
    .nullish()
    .transform((value) => value ?? []),
});
const batchSchema = z.object({ serverId: z.uuid(), serverName: feedText, events: z.array(z.unknown()).max(200) });

export type ParsedFeed = {
  serverId: string;
  serverName: string;
  skipped: number;
  events: Array<{
    eventId: string;
    eventTime: number;
    matchId: string | null;
    mapName: string | null;
    killerSteamId: string | null;
    killerName: string | null;
    victimSteamId: string | null;
    victimName: string | null;
    cause: string | null;
    distanceCentimeters: number | null;
    contextTags: string[];
    headshot: boolean;
    suicide: boolean;
  }>;
};
export type CombatStats = {
  steamId: string;
  name: string;
  kills: number;
  deaths: number;
  headshotKills: number;
  kd: number | null;
};
export type CombatTotals = { events: number; kills: number; deaths: number; headshotKills: number; players: number };
export type CombatAggregate = { leaderboard: CombatStats[]; totals: CombatTotals };
export type TrackingRecord = { firstReceivedAt: Date; lastReceivedAt: Date } | null;
export const emptyTotals = (): CombatTotals => ({ events: 0, kills: 0, deaths: 0, headshotKills: 0, players: 0 });

export function parseFeed(input: unknown): ParsedFeed {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
  } catch {
    throw new BadRequestException("Invalid feed payload.");
  }
  if (bytes > MAX_FEED_BYTES) throw new BadRequestException("The feed payload exceeds 64 KiB.");
  const batch = batchSchema.safeParse(input);
  if (!batch.success) throw new BadRequestException("Invalid feed batch or event count.");
  const output: ParsedFeed = {
    serverId: batch.data.serverId,
    serverName: batch.data.serverName,
    skipped: 0,
    events: [],
  };
  for (const raw of batch.data.events) {
    if (raw && typeof raw === "object" && "type" in raw && raw.type !== "killed") {
      output.skipped++;
      continue;
    }
    const event = eventSchema.safeParse(raw);
    if (!event.success) throw new BadRequestException("Invalid killed event fields.");
    const value = event.data;
    const tags = new Set(
      value.contextTags.map((tag) =>
        tag.replace(/^Meta\.(?:Progression\.Context\.Player\.KillContext|PlayerKillFlag\.Player)\./, ""),
      ),
    );
    output.events.push({
      eventId: value.eventId,
      eventTime: value.eventTime,
      matchId: value.matchId ?? null,
      mapName: value.mapName,
      killerSteamId: value.killerSteamId,
      killerName: value.killerName,
      victimSteamId: value.victimSteamId,
      victimName: value.victimName,
      cause: value.cause,
      distanceCentimeters: value.distance ?? null,
      contextTags: value.contextTags,
      headshot: tags.has("Headshot"),
      suicide: tags.has("Suicide") || (value.killerSteamId !== null && value.killerSteamId === value.victimSteamId),
    });
  }
  return output;
}
