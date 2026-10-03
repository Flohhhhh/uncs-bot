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
import type { StoredVotingPolicy, VoteAutomation } from "../common/voting-policy";
import type {
  EventOperation,
  EventOptions,
  EventProgress,
  EventState,
  EventStop,
} from "../server-events/server-events.types";
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
    serverId: text("server_id").notNull().default("primary"),
    discordUserId: text("discord_user_id").notNull(),
    discordDisplayName: text("discord_display_name").notNull(),
    steamId: text("steam_id").notNull(),
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
  (table) => [
    index("whitelist_applications_submitted_idx").on(table.serverId, table.submittedAt),
    uniqueIndex("whitelist_applications_server_discord_idx").on(table.serverId, table.discordUserId),
    uniqueIndex("whitelist_applications_server_steam_idx").on(table.serverId, table.steamId),
  ],
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

// A human contributor must generate and review the migration for these voting controls.
export const mapVotePolicies = pgTable("map_vote_policies", {
  serverId: text("server_id").primaryKey(),
  version: integer("version").notNull().default(1),
  policy: jsonb("policy").$type<StoredVotingPolicy>().notNull(),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(),
  connectionHash: text("connection_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    automation: jsonb("automation").$type<VoteAutomation>(),
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

export const serverEvents = pgTable(
  "server_events",
  {
    id: uuid("id").primaryKey(),
    serverId: text("server_id").notNull(),
    serverName: text("server_name").notNull(),
    connectionHash: text("connection_hash").notNull(),
    guildId: text("guild_id").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    options: jsonb("options").$type<EventOptions>().notNull(),
    originalLock: boolean("original_lock").notNull(),
    initialRevision: text("initial_revision").notNull(),
    restoreRevision: text("restore_revision"),
    state: text("state").$type<EventState>().notNull().default("preparing"),
    progress: jsonb("progress").$type<EventProgress>().notNull(),
    operationId: uuid("operation_id"),
    version: integer("version").notNull().default(1),
    message: text("message").notNull().default("Preparing the optional event."),
    lastActionId: uuid("last_action_id"),
    stop: jsonb("stop").$type<EventStop>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("server_events_active_server_idx")
      .on(table.serverId)
      .where(sql`${table.state} <> 'complete'`),
    index("server_events_created_idx").on(table.createdAt),
  ],
);

export const serverEventOperations = pgTable(
  "server_event_operations",
  {
    id: uuid("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => serverEvents.id),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    operation: jsonb("operation").$type<EventOperation>().notNull(),
    state: text("state").notNull().default("started"),
    message: text("message").notNull().default("Recorded before contacting the game."),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("server_event_operations_event_idx").on(table.eventId, table.createdAt)],
);
