import { nonEmptyString } from "src/common/schemas/non-empty-string.schema";
import { z } from "zod";

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
  /** Separate combat-event ingest credential. Existing host feed is never rewritten automatically. */
  WARDOGS_FEED_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WARDOGS_FEED_TOKEN: z.string().min(32).max(512).regex(/^\S+$/).optional(),

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
  SERVER_COMMUNITY_ROUND_MESSAGE: communityMessage.default("GG! Thanks for playing on The UNCs. See you next round."),
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
