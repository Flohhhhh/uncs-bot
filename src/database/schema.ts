import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { MapVoteCancellation, MapVoteChoice, MapVoteState } from "../map-votes/map-votes.types";
export * from "./telemetry.schema";
export * from "./supporters.schema";

export const guildWelcomeSettings = pgTable("guild_welcome_settings", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GuildWelcomeSettings = typeof guildWelcomeSettings.$inferSelect;

export const adminSessions = pgTable(
  "admin_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    csrf: text("csrf").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("admin_sessions_expiry_idx").on(table.expiresAt)],
);

// The initial record is committed BEFORE RCON is called. An unfinished record means
// the result is unknown and must be checked, never automatically replayed.
export const adminActions = pgTable(
  "admin_actions",
  {
    id: uuid("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    requestHash: text("request_hash").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull().default("started"),
    message: text("message").notNull().default("Action started; result not yet recorded."),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("admin_actions_created_idx").on(table.createdAt)],
);

export const whitelistApplications = pgTable(
  "whitelist_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordUserId: text("discord_user_id").notNull().unique(),
    discordDisplayName: text("discord_display_name").notNull(),
    steamId: text("steam_id").notNull().unique(),
    relationship: text("relationship").$type<"unc_member" | "friend_regular" | "new_player">().notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    steamOwnershipVerified: boolean("steam_ownership_verified").notNull().default(false),
    contactConsent: boolean("contact_consent").notNull(),
    consentVersion: text("consent_version").notNull(),
    contactConsentAt: timestamp("contact_consent_at", { withTimezone: true }),
    rulesAcceptedAt: timestamp("rules_accepted_at", { withTimezone: true }).notNull(),
    status: text("status")
      .$type<"pending" | "processing" | "approved" | "declined" | "needs_review">()
      .notNull()
      .default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    reviewReason: text("review_reason"),
    actionId: uuid("action_id").unique(),
    reviewId: uuid("review_id").unique(),
    reviewKind: text("review_kind").$type<"approve" | "decline" | "recheck">(),
    lastActionState: text("last_action_state"),
    lastActionMessage: text("last_action_message"),
  },
  (table) => [index("whitelist_applications_submitted_idx").on(table.submittedAt)],
);

// Record the review before touching RCON. Only completion fields are updated;
// reviewer, reason, target and request identity remain the original evidence.
export const whitelistApplicationReviews = pgTable(
  "whitelist_application_reviews",
  {
    id: uuid("id").primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => whitelistApplications.id),
    kind: text("kind").$type<"approve" | "decline" | "recheck">().notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("whitelist_application_reviews_application_idx").on(table.applicationId)],
);

// New source schema only: a human must generate/review its migration before enabling map votes.
export const mapVotes = pgTable(
  "map_votes",
  {
    id: uuid("id").primaryKey(),
    serverId: text("server_id").notNull(),
    serverName: text("server_name").notNull(),
    connectionHash: text("connection_hash").notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    choices: jsonb("choices").$type<MapVoteChoice[]>().notNull(),
    revision: text("revision").notNull(),
    currentMap: text("current_map").notNull(),
    currentIndex: integer("current_index").notNull(),
    roundStartedAt: timestamp("round_started_at", { withTimezone: true }),
    state: text("state").$type<MapVoteState>().notNull().default("publishing"),
    winner: integer("winner"),
    counts: jsonb("counts").$type<number[]>().notNull(),
    message: text("message").notNull().default("Creating the Discord ballot."),
    cancellation: jsonb("cancellation").$type<MapVoteCancellation>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("map_votes_active_server_idx")
      .on(table.serverId)
      .where(sql`${table.state} in ('publishing', 'open', 'closing', 'needs_review')`),
    index("map_votes_created_idx").on(table.createdAt),
  ],
);

export const mapVoteBallots = pgTable(
  "map_vote_ballots",
  {
    voteId: uuid("vote_id")
      .notNull()
      .references(() => mapVotes.id),
    discordUserId: text("discord_user_id").notNull(),
    choice: integer("choice").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.voteId, table.discordUserId] })],
);
