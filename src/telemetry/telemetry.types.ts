import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";

export const MAX_FEED_BYTES = 65_536;

/** A 400 for a refused feed body, with a short category that is safe to show staff and log. */
export class FeedRejectedException extends BadRequestException {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}
const issueHints: Partial<Record<string, string>> = {
  invalid_type: "missing or wrong type",
  invalid_format: "bad format",
  invalid_value: "unexpected value",
  too_big: "over the limit",
  too_small: "under the limit",
};
// Names only the schema location of the first problem, never the submitted value.
export function issueLabel(error: z.ZodError, prefix: PropertyKey[] = []) {
  const [issue] = error.issues;
  const path = [...prefix, ...(issue?.path ?? [])]
    .map((part) => (typeof part === "number" || /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(String(part)) ? String(part) : "?"))
    .join(".");
  const hint = issue ? issueHints[issue.code] : undefined;
  return `${path || "batch"}${hint ? ` (${hint})` : ""}`;
}
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
// Any 8-4-4-4-12 hex GUID, in either case. The game's GUIDs need not carry RFC 4122 version and
// variant bits, and PostgreSQL uuid columns accept any 32 hex digits. Lowercasing keeps eventId
// deduplication exact.
const feedGuid = z.guid().transform((value) => value.toLowerCase());
const eventSchema = z.object({
  eventId: feedGuid,
  type: z.literal("killed"),
  eventTime: z.number().min(0).max(1e12),
  matchId: feedGuid.nullish(),
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
const batchSchema = z.object({ serverId: feedGuid, serverName: feedText, events: z.array(z.unknown()).max(200) });

export type ParsedFeed = {
  serverId: string;
  serverName: string;
  /** Entries not stored: other event types plus invalid entries. */
  skipped: number;
  /** Malformed killed events, entries without a string type and non-objects. Included in skipped. */
  invalid: number;
  /** Schema location of the first invalid entry, never its value. */
  firstInvalid: string | null;
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
// Public leaderboard rows carry game statistics only: no SteamID and no other account identifier.
export type PublicCombatStats = Omit<CombatStats, "steamId">;
export type CombatTotals = { events: number; kills: number; deaths: number; headshotKills: number; players: number };
export type CombatAggregate = { leaderboard: CombatStats[]; totals: CombatTotals };
export type TrackingRecord = { firstReceivedAt: Date; lastReceivedAt: Date } | null;
export const emptyTotals = (): CombatTotals => ({ events: 0, kills: 0, deaths: 0, headshotKills: 0, players: 0 });

export function parseFeed(input: unknown): ParsedFeed {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
  } catch {
    throw new FeedRejectedException("Invalid feed payload.", "invalid payload: batch");
  }
  if (bytes > MAX_FEED_BYTES) throw new FeedRejectedException("The feed payload exceeds 64 KiB.", "too large");
  const batch = batchSchema.safeParse(input);
  if (!batch.success)
    throw new FeedRejectedException(
      "Invalid feed batch or event count.",
      input === undefined ? "invalid payload: missing JSON body" : `invalid payload: ${issueLabel(batch.error)}`,
    );
  const output: ParsedFeed = {
    serverId: batch.data.serverId,
    serverName: batch.data.serverName,
    skipped: 0,
    invalid: 0,
    firstInvalid: null,
    events: [],
  };
  // One odd entry never discards the batch: it is skipped and counted, and the first is named.
  const invalid = (label: string) => {
    output.skipped++;
    output.invalid++;
    output.firstInvalid ??= label;
  };
  for (const [index, raw] of batch.data.events.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid(`events.${index} (not an object)`);
      continue;
    }
    const type: unknown = (raw as { type?: unknown }).type;
    if (typeof type !== "string") {
      invalid(`events.${index}.type (missing or wrong type)`);
      continue;
    }
    if (type !== "killed") {
      output.skipped++;
      continue;
    }
    const event = eventSchema.safeParse(raw);
    if (!event.success) {
      invalid(issueLabel(event.error, ["events", index]));
      continue;
    }
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
