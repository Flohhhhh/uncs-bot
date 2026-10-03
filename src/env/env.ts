import { nonEmptyString } from "../common/schemas/non-empty-string.schema";
import { z } from "zod";
import { jsonSetting } from "./json-setting";
import { gameServerConnections, gameServerJoinId } from "../common/game-server";
import { DST_HOURS, SLOT_TIME, WEEKDAYS } from "../weekly-leaderboard/weekly-schedule";
import { isPublicIndividualSteamId } from "../common/steam-id";
import { parseClockList, parseWindows, validTimeZone } from "../staff-alerts/local-time";
import { SAFE_LINK } from "../common/staff-alerts";

const discordId = z.string().regex(/^\d{17,20}$/, "Use a Discord numeric ID.");
const communityMessage = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    "Use a single-line message without control characters.",
  );
const welcomeSequence = z.array(communityMessage).min(1).max(4);
const distinct = <T>(values: T[]) => new Set(values.map((value) => JSON.stringify(value))).size === values.length;
/** 20 variants of four 200-character messages, with room for JSON escapes and formatting. */
const WELCOME_VARIANTS_MAX_LENGTH = 32_768;
const ROUND_MESSAGES_MAX_LENGTH = 8_192;
/** 500 known-good entries with 80-character notes come to about 61,000 characters. Documented in STAFF_ALERTS.md. */
const KNOWN_GOOD_MAX_LENGTH = 65_536;
/**
 * Documented in STAFF_ALERTS.md. 200 watch-list entries with every field at its maximum would not fit, and
 * Linux caps one environment value at 131,072 bytes, so the guide gives the real limit instead.
 */
const WATCHLIST_MAX_LENGTH = 65_536;
const welcomeVariants = jsonSetting(
  z.array(welcomeSequence).min(1).max(20).refine(distinct, "Use different welcome variants."),
  WELCOME_VARIANTS_MAX_LENGTH,
).optional();
const flag = (fallback: "true" | "false" = "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((value) => value === "true");
const count = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const singleLine = (value: string) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
/** The personal SteamID64 shape that staff actions accept. */
const personalSteamId = z
  .string()
  .refine(isPublicIndividualSteamId, "Use a 17-digit SteamID64 for a personal Steam account.");
const uniqueSteamIds = (entries: (string | { steamId: string })[]) =>
  new Set(entries.map((entry) => (typeof entry === "string" ? entry : entry.steamId))).size === entries.length;
const knownGoodEntry = z.union([
  personalSteamId,
  z
    .object({
      steamId: personalSteamId,
      note: z.string().trim().max(80).refine(singleLine, "Use a single-line note.").optional(),
    })
    .strict(),
]);
/** Kept in its normalised form, which must pass the rule the alert applies or the alert would drop the link. */
const evidenceUrl = z
  .string()
  .trim()
  .max(500)
  .transform((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password && SAFE_LINK.test(url.href)) return url.href;
    } catch {
      /* reported below */
    }
    context.addIssue({
      code: "custom",
      message: "Use an https:// evidence link without credentials, spaces, <, > or backticks.",
    });
    return z.NEVER;
  });
const watchlistEntry = z
  .object({
    steamId: personalSteamId,
    reason: z.string().trim().min(1).max(200).refine(singleLine, "Use a single-line reason."),
    evidenceUrl: evidenceUrl.optional(),
    communities: z.number().int().min(1).max(999).optional(),
    recordedAt: z.iso.date().optional(),
    addedBy: z.string().trim().max(64).refine(singleLine, "Use a single-line name.").optional(),
    source: z.enum(["wardogs-network", "staff"]).optional(),
  })
  .strict();
const discordIds = z
  .string()
  .default("")
  .refine(
    (value) => value.split(",").every((id) => !id.trim() || /^\d{17,20}$/.test(id.trim())),
    "Use comma-separated Discord numeric IDs.",
  );

export const Env = z.object({
  /** The environment the app is running in */
  NEST_ENV: z
    .enum(["development", "staging", "production"])
    .optional()
    .default(process.env.NODE_ENV === "development" ? "development" : "production"),

  /** The port the application will run on */
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),

  /** Discord bot token */
  DISCORD_BOT_TOKEN: nonEmptyString,

  /** Neon PostgreSQL connection string */
  DATABASE_URL: nonEmptyString,

  /** Staff dashboard is opt-in; credentials never go to the browser. */
  ADMIN_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ADMIN_ORIGIN: z.url().optional(),
  ADMIN_DISCORD_CLIENT_ID: discordId.optional(),
  ADMIN_DISCORD_CLIENT_SECRET: nonEmptyString.optional(),
  ADMIN_SESSION_SECRET: z.string().min(32).optional(),
  ADMIN_GUILD_ID: discordId.optional(),
  ADMIN_OWNER_IDS: discordIds,
  ADMIN_ADMIN_ROLE_IDS: discordIds,
  ADMIN_MODERATOR_ROLE_IDS: discordIds,
  ADMIN_VIEWER_ROLE_IDS: discordIds,
  WARDOGS_RCON_URL: z.url().optional(),
  WARDOGS_RCON_PASSWORD: nonEmptyString.optional(),
  /** Public game join code, never an RCON credential. Registry entries use their own joinId instead. */
  WARDOGS_SERVER_JOIN_ID: gameServerJoinId.optional(),
  /** Explicit server registry. Never expose connection fields through public APIs. */
  WARDOGS_SERVERS: jsonSetting(gameServerConnections, 65_536).optional(),
  /** Requires a human-reviewed map-vote migration and a configured guild channel. */
  MAP_VOTES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MAP_VOTES_CHANNEL_ID: discordId.optional(),
  /**
   * Optional private staff-only text channel in ADMIN_GUILD_ID for staff alerts, including the map-vote
   * and 50v50 automation alerts. Never a community channel.
   */
  STAFF_ALERTS_CHANNEL_ID: discordId.optional(),
  /** Alert-only staff alerts: Gramps never kicks, bans or edits the whitelist because of one. */
  STAFF_ALERTS_ENABLED: flag(),
  /** Optional role pinged for high-severity alerts only; never the @everyone role. */
  STAFF_ALERTS_PING_ROLE_ID: discordId.optional(),
  STAFF_ALERTS_TIME_ZONE: z
    .string()
    .trim()
    .default("America/New_York")
    .refine(validTimeZone, "Use an IANA time zone such as America/New_York."),
  STAFF_ALERTS_HEALTH_ENABLED: flag(),
  STAFF_ALERTS_HEALTH_DOWN_MINUTES: count(2, 120, 10),
  STAFF_ALERTS_HEALTH_RESTART_PLAYERS: count(0, 200, 10),
  /** Local HH:MM list (at most 6); restarts within 20 minutes of one are labelled scheduled. */
  STAFF_ALERTS_HEALTH_SCHEDULED_RESTARTS: z
    .string()
    .default("")
    .refine((value) => parseClockList(value, 6) !== null, "Use up to 6 different local times such as 04:00,16:00."),
  STAFF_ALERTS_SEEDING_ENABLED: flag(),
  STAFF_ALERTS_SEEDING_BELOW: count(1, 100, 1),
  STAFF_ALERTS_SEEDING_MINUTES: count(5, 360, 30),
  /** 0 turns the post-restart trigger off. */
  STAFF_ALERTS_SEEDING_AFTER_RESTART_HOURS: count(0, 48, 12),
  /** Local HH:MM-HH:MM windows (at most 4, may cross midnight); "" turns prime-time alerts off. */
  STAFF_ALERTS_SEEDING_PRIME_HOURS: z
    .string()
    .default("17:00-23:00")
    .refine((value) => parseWindows(value, 4) !== null, "Use up to 4 local windows such as 17:00-23:00."),
  /** false, observe (dashboard only, nothing posted) or true. */
  STAFF_ALERTS_PERFORMANCE_ENABLED: z.enum(["false", "observe", "true"]).default("false"),
  STAFF_ALERTS_PERFORMANCE_WINDOW_MINUTES: count(2, 15, 5),
  STAFF_ALERTS_PERFORMANCE_WINDOW_KILLS: count(10, 500, 30),
  STAFF_ALERTS_PERFORMANCE_MATCH_KILLS: count(10, 1000, 40),
  STAFF_ALERTS_PERFORMANCE_MATCH_KD: z.coerce.number().finite().min(2).max(1000).default(20),
  STAFF_ALERTS_PERFORMANCE_PLAYER_COOLDOWN_MINUTES: count(0, 10_080, 360),
  STAFF_ALERTS_PERFORMANCE_MAX_PER_HOUR: count(1, 30, 3),
  STAFF_ALERTS_PERFORMANCE_SKIP_WHITELISTED: flag(),
  /** Never flagged: SteamID64 strings or {"steamId","note"} objects. */
  STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: jsonSetting(
    z.array(knownGoodEntry).max(500).refine(uniqueSteamIds, "List each SteamID once."),
    KNOWN_GOOD_MAX_LENGTH,
  ).optional(),
  STAFF_ALERTS_WATCHLIST_ENABLED: flag(),
  /** Copied by staff from WarDogs network alerts. Monitoring only; never an automatic ban. */
  STAFF_ALERTS_WATCHLIST: jsonSetting(
    z.array(watchlistEntry).max(200).refine(uniqueSteamIds, "List each SteamID once."),
    WATCHLIST_MAX_LENGTH,
  ).optional(),
  STAFF_ALERTS_WATCHLIST_HIGHLIGHT_COMMUNITIES: count(1, 100, 3),
  STAFF_ALERTS_WATCHLIST_COOLDOWN_MINUTES: count(0, 10_080, 360),
  /** Optional event automation; requires a human-reviewed schema and controlled game rehearsal. */
  SERVER_EVENTS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Separate combat-event ingest credential. Existing host feed is never rewritten automatically. */
  WARDOGS_FEED_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WARDOGS_FEED_TOKEN: z.string().min(32).max(512).regex(/^\S+$/).optional(),

  /** Weekly Discord leaderboard post; off by default. Also gates the staff post-now; preview still works. */
  WEEKLY_LEADERBOARD_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Text or announcement channel in ADMIN_GUILD_ID. */
  WEEKLY_LEADERBOARD_CHANNEL_ID: discordId.optional(),
  /** Day and time of the weekly slot in America/New_York (fixed time zone). */
  WEEKLY_LEADERBOARD_DAY: z.enum(WEEKDAYS).default("sunday"),
  WEEKLY_LEADERBOARD_TIME: z
    .string()
    .regex(SLOT_TIME, "Use HH:MM in 24-hour time.")
    .refine((value) => !DST_HOURS.test(value), "Choose a time outside 01:00–02:59 (DST changes).")
    .default("20:00"),
  WEEKLY_LEADERBOARD_MIN_KILLS: z.coerce.number().int().min(1).max(100_000).default(100),
  WEEKLY_LEADERBOARD_MIN_PLAYERS: z.coerce.number().int().min(5).max(1_000).default(10),

  /** One optional community worker; leave off until the old announcer is disabled. */
  SERVER_COMMUNITY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SERVER_COMMUNITY_WELCOME_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SERVER_COMMUNITY_ROUND_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SERVER_COMMUNITY_WELCOME_MESSAGE: communityMessage.default("Welcome to The UNCs! Squad up and enjoy the server."),
  /** Optional JSON array replaces the legacy single message. No placeholder expansion. */
  SERVER_COMMUNITY_WELCOME_MESSAGES: jsonSetting(welcomeSequence, 2048).optional(),
  /** Optional JSON array of 1-20 welcome sequences; one is chosen per join. Replaces both settings above. */
  SERVER_COMMUNITY_WELCOME_VARIANTS: welcomeVariants,
  /**
   * Optional variants, in the same shape, for joiners on that server's running whitelist (reserved slots).
   * Unset, or when the whitelist cannot be read, every joiner gets the ordinary welcome settings above.
   */
  SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS: welcomeVariants,
  SERVER_COMMUNITY_WELCOME_DELAY_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
  SERVER_COMMUNITY_WELCOME_SPACING_SECONDS: z.coerce.number().int().min(10).max(120).default(20),
  SERVER_COMMUNITY_ROUND_MESSAGE: communityMessage.default("GG! Thanks for playing on The UNCs. See you next round."),
  /** Optional JSON array of 1-20 round messages; one is chosen per round. Replaces the single message. */
  SERVER_COMMUNITY_ROUND_MESSAGES: jsonSetting(
    z.array(communityMessage).min(1).max(20).refine(distinct, "Use different round messages."),
    ROUND_MESSAGES_MAX_LENGTH,
  ).optional(),
  SERVER_COMMUNITY_DISCORD_CHANNEL_ID: discordId.optional(),
  SERVER_COMMUNITY_DISCORD_MESSAGE_ID: discordId.optional(),

  /** Patreon observations and private supporter records; no automatic game grants. */
  PATREON_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PATREON_CAMPAIGN_ID: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  PATREON_WEBHOOK_SECRET: z.string().min(16).max(512).optional(),
  PATREON_FOUNDER_START_AT: z.iso.datetime({ offset: true }).optional(),
  PATREON_FOUNDER_END_AT: z.iso.datetime({ offset: true }).optional(),
  /**
   * Creator's Access Token for the read-only member import. Never logged or returned. A malformed value
   * leaves the import unconfigured (shown on the Supporters page) instead of stopping the bot.
   */
  PATREON_CREATOR_ACCESS_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  PATREON_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(10).max(1440).default(30),

  /** Website requests remain disabled until the reviewed schema is deployed. */
  WHITELIST_APPLICATIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  APPLICATION_ORIGIN: z.url().optional(),
  WHITELIST_APPLICATION_EMAIL_REQUIRED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /** A Discord server (guild) ID to use for development */
  DISCORD_DEVELOPMENT_GUILD_ID: nonEmptyString
    .trim()
    .transform((val) => val.split(",").map((id) => id.trim()))
    .optional(),

  /** Railway provided variables */
  RAILWAY_PUBLIC_DOMAIN: nonEmptyString.optional(),
  RAILWAY_PRIVATE_DOMAIN: nonEmptyString.optional(),
  RAILWAY_PROJECT_NAME: nonEmptyString.optional(),
  RAILWAY_ENVIRONMENT_NAME: nonEmptyString.optional(),
  RAILWAY_SERVICE_NAME: nonEmptyString.optional(),
  RAILWAY_PROJECT_ID: nonEmptyString.optional(),
  RAILWAY_ENVIRONMENT_ID: nonEmptyString.optional(),
  RAILWAY_SERVICE_ID: nonEmptyString.optional(),
});

export type Env = z.infer<typeof Env>;
