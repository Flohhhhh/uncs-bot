import { BadRequestException } from "@nestjs/common";
import { isIP } from "node:net";
import { z } from "zod";
import type { CauseKind } from "../common/cause-labels";
import { isPublicIndividualSteamId } from "../common/steam-id";

export const MAX_FEED_BYTES = 65_536;
/** Largest kept sample of a feed event type, in bytes of JSON. */
export const MAX_SAMPLE_BYTES = 4_096;
/** Feed event type names that are tallied; any other string type is an invalid entry. */
export const FEED_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

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

/** One feed event type in a batch: how many entries it had and the latest one, for staff. */
export type FeedTypeTally = {
  type: string;
  /** Entries of this type. For killed, only valid killed events. */
  count: number;
  /**
   * The latest entry of this type that is at most MAX_SAMPLE_BYTES as JSON, made storable, else
   * { tooLarge: true, bytes } for the latest. Always null for killed, whose events are stored in full.
   */
  sample: unknown;
};

export type ParsedFeed = {
  serverId: string;
  serverName: string;
  /** Entries not stored as combat events: other event types plus invalid entries. */
  skipped: number;
  /** Malformed killed events, entries without a string or bounded type and non-objects. Included in skipped. */
  invalid: number;
  /** Schema location of the first invalid entry, never its value. */
  firstInvalid: string | null;
  /**
   * Schema location of the first invalid entry other than one whose string type is not a bounded
   * name. Such entries were skipped, not refused, before type names were checked, so they alone
   * never refuse a batch.
   */
  firstMalformed: string | null;
  /** Every valid event type in the batch, in first-seen order: counts for staff, never per-event rows. */
  types: FeedTypeTally[];
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
/**
 * Optional per-row extras on the public leaderboard, each omitted when unknown (never null): the player's
 * most-used named weapon, their longest firearm kill within the public distance cap, and their most kills
 * without dying within one server session.
 */
export type RowExtras = { topWeapon?: string; longestKillMeters?: number; bestStreak?: number };
// Public leaderboard rows carry game statistics only: no SteamID and no other account identifier.
export type PublicCombatStats = Omit<CombatStats, "steamId"> & RowExtras;
export type CombatTotals = { events: number; kills: number; deaths: number; headshotKills: number; players: number };
export type CombatAggregate = { leaderboard: CombatStats[]; totals: CombatTotals };
export type TrackingRecord = { firstReceivedAt: Date; lastReceivedAt: Date } | null;
/** Staff diagnostic: one feed event type over whole UTC days, with its latest kept sample. */
export type FeedEventTypeSummary = {
  type: string;
  count: number;
  firstReceivedAt: Date;
  lastReceivedAt: Date;
  sample: unknown;
};
export const emptyTotals = (): CombatTotals => ({ events: 0, kills: 0, deaths: 0, headshotKills: 0, players: 0 });
/** Weekly shout-out inputs. Names fall back to the SteamID, so callers must apply public name rules. */
export type WeeklyHighlights = {
  bestKd: { steamId: string; name: string; kills: number; deaths: number } | null;
  mostHeadshots: { steamId: string; name: string; headshotKills: number } | null;
  /** The longest firearm kill: vehicles, their weapons, explosives, melee and tools never count. */
  longestKill: {
    steamId: string;
    name: string;
    distanceCentimeters: number;
    cause: string | null;
    mapName: string | null;
  } | null;
  /** Non-suicide kills with a linked killer. */
  kills: number;
  killsWithCause: number;
  topCause: { cause: string; kills: number } | null;
  /** Kills per stored map name, most first, at most 50. */
  maps: Array<{ mapName: string; kills: number }>;
};
/** 2 km sanity cap on every public distance, the same 2,000 m the weekly post uses. */
export const PUBLIC_MAX_DISTANCE_CENTIMETERS = 200_000;
/** Kill-context tags with a public top-5 list, by the short name the feed's tags end in. */
export const LEADER_TAGS = {
  melee: "WeaponMelee",
  roadkill: "RoadKill",
  vehicleExplosion: "VehicleExplosion",
  penetration: "Penetration",
  ricochet: "Ricochet",
  falling: "Falling",
} as const;
export type LeaderTag = keyof typeof LEADER_TAGS;
/** Self-inflicted deaths are counted, never listed by name. */
export type StatTag = LeaderTag | "suicide";
export type StatsTotals = CombatTotals & { suicides: number };
/** Server-wide public stats: names and game statistics only, never a SteamID or any account identifier. */
export type PublicServerStats = {
  totals: StatsTotals;
  /** At most 25, by kills. */
  weapons: Array<{
    label: string;
    kind: CauseKind;
    kills: number;
    headshotKills: number;
    longestMeters: number | null;
  }>;
  /** At most 10, by kills. */
  maps: Array<{ label: string; kills: number }>;
  /** At most 10, each player's own longest firearm kill. */
  longestKills: Array<{ name: string; weapon: string | null; meters: number; map: string | null }>;
  /** Kills per UTC hour of receipt; index 0 is 00:00-00:59 UTC. */
  hours: number[];
  tags: Record<StatTag, number>;
  /** At most 5 names per tag. */
  tagLeaders: Record<LeaderTag, Array<{ name: string; count: number }>>;
};
/**
 * Store-internal stats inputs. These still carry SteamIDs for name lookups; only
 * publicServerStats() turns them into the public shape.
 */
export type ServerStatsAggregate = {
  /** S1 grouping-set rows: set 3 = by cause, 5 = by map, 6 = by UTC hour, 7 = all kills. */
  groups: Array<{
    set: number;
    causeKey: string | null;
    cause: string | null;
    mapName: string | null;
    hour: number | null;
    kills: number;
    headshotKills: number;
    longestCentimeters: number | null;
    melee: number;
    roadkill: number;
    vehicleExplosion: number;
    penetration: number;
    ricochet: number;
  }>;
  totals: { events: number; deaths: number; suicides: number; falling: number; players: number };
  longest: Array<{
    steamId: string;
    name: string | null;
    cause: string | null;
    mapName: string | null;
    distanceCentimeters: number;
  }>;
  leaders: Array<{ tag: string; steamId: string; name: string | null; count: number }>;
};
/** Store-internal leaderboard row inputs, keyed by SteamID for the service to attach. */
export type RowExtrasAggregate = {
  /** Per cause; longestCentimeters is set for firearm causes only, so it feeds longestKillMeters alone. */
  weapons: Array<{ steamId: string; cause: string | null; kills: number; longestCentimeters: number | null }>;
  streaks: Array<{ steamId: string; bestStreak: number }>;
};
export const emptyHighlights = (): WeeklyHighlights => ({
  bestKd: null,
  mostHeadshots: null,
  longestKill: null,
  kills: 0,
  killsWithCause: 0,
  topCause: null,
  maps: [],
});

// PostgreSQL jsonb refuses NUL characters and unpaired UTF-16 surrogates, so a sample drops the first
// and replaces the second: one odd string must not fail the batch's transaction. IP addresses in keys
// and strings are replaced too, since an unknown event type could carry a player's address.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const IP_REMOVED = "[IP address removed]";
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_IN_TEXT = new RegExp(`\\b${OCTET}(?:\\.${OCTET}){3}\\b`, "g");
// A run of the characters an address, its brackets, port or zone can contain.
const ADDRESS_WORD = /[\w.:%[\]]+/g;
const ipAddress = (text: string) =>
  isIP(text) !== 0 || isIP(text.replace(/:\d{1,5}$/, "")) !== 0 || isIP(text.replace(/^\[(.+)\]:\d{1,5}$/, "$1")) === 6;
// A whole-value address is replaced whole; otherwise each address-like word, then IPv4 inside text.
const storableText = (value: string) => {
  const text = value.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\uFFFD");
  if (ipAddress(text.trim())) return IP_REMOVED;
  return text.replace(ADDRESS_WORD, (word) => (ipAddress(word) ? IP_REMOVED : word)).replace(IPV4_IN_TEXT, IP_REMOVED);
};
function storableSample(value: unknown): unknown {
  if (typeof value === "string") return storableText(value);
  // jsonb keeps numbers as numeric and prints them without an exponent, so 1e308 would read back as
  // 309 digits: such numbers are kept as their JSON text.
  if (typeof value === "number" && /e/i.test(String(value))) return String(value);
  if (Array.isArray(value)) return value.map(storableSample);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [storableText(key), storableSample(item)]));
  return value;
}

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
    firstMalformed: null,
    types: [],
    events: [],
  };
  const tallies = new Map<string, FeedTypeTally & { fits: boolean }>();
  const tally = (type: string) => {
    let entry = tallies.get(type);
    if (!entry) tallies.set(type, (entry = { type, count: 0, sample: null, fits: false }));
    entry.count++;
    return entry;
  };
  // One odd entry never discards the batch: it is skipped and counted, and the first is named.
  const invalid = (label: string, malformed = true) => {
    output.skipped++;
    output.invalid++;
    output.firstInvalid ??= label;
    if (malformed) output.firstMalformed ??= label;
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
    if (!FEED_TYPE_PATTERN.test(type)) {
      invalid(`events.${index}.type (bad format)`, false);
      continue;
    }
    if (type !== "killed") {
      output.skipped++;
      const entry = tally(type);
      // The cap applies to the sample as stored, after IP addresses are replaced, which can lengthen
      // it. The whole batch serialized above, so this entry does too. An entry over the cap keeps an
      // earlier sample of its type from this batch.
      const sample = storableSample(raw);
      const bytes = Buffer.byteLength(JSON.stringify(sample), "utf8");
      if (bytes <= MAX_SAMPLE_BYTES) Object.assign(entry, { sample, fits: true });
      else if (!entry.fits) entry.sample = { tooLarge: true, bytes };
      continue;
    }
    const event = eventSchema.safeParse(raw);
    if (!event.success) {
      invalid(issueLabel(event.error, ["events", index]));
      continue;
    }
    tally(type);
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
  output.types = [...tallies.values()].map(({ type, count, sample }) => ({ type, count, sample }));
  return output;
}
