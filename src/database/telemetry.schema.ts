import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// serverId is the configured connection. serverInstanceId is a per-boot deduplication
// namespace supplied by the game, never an authorization or tenant selector.
export const combatEvents = pgTable(
  "combat_events",
  {
    serverId: text("server_id").notNull().default("primary"),
    serverInstanceId: uuid("server_instance_id").notNull(),
    eventId: uuid("event_id").notNull(),
    serverName: text("server_name").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    eventTime: doublePrecision("event_time").notNull(),
    matchId: uuid("match_id"),
    mapName: text("map_name"),
    killerSteamId: text("killer_steam_id"),
    killerName: text("killer_name"),
    victimSteamId: text("victim_steam_id"),
    victimName: text("victim_name"),
    cause: text("cause"),
    distanceCentimeters: doublePrecision("distance_centimeters"),
    contextTags: jsonb("context_tags").$type<string[]>().notNull(),
    headshot: boolean("headshot").notNull(),
    suicide: boolean("suicide").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.serverInstanceId, table.eventId] }),
    index("combat_events_received_idx").on(table.serverId, table.receivedAt),
    index("combat_events_killer_received_idx").on(table.serverId, table.killerSteamId, table.receivedAt),
    index("combat_events_victim_received_idx").on(table.serverId, table.victimSteamId, table.receivedAt),
  ],
);

export const combatTracking = pgTable("combat_tracking", {
  id: text("id").primaryKey(),
  firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull(),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull(),
  lastCleanupAt: timestamp("last_cleanup_at", { withTimezone: true }),
});

// One row per configured server, feed event type and UTC receipt day: a running count and the latest
// entry of that type (at most 4 KiB as stored, never kept for killed events), so staff can learn what the
// game sends without storing each event. Repeat deliveries can count twice. Purged after 90 days.
export const gameFeedEventTypes = pgTable(
  "game_feed_event_types",
  {
    serverId: text("server_id").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    day: date("day", { mode: "string" }).notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
    firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull(),
    sample: jsonb("sample"),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.type, table.day] }),
    index("game_feed_event_types_day_idx").on(table.serverId, table.day),
  ],
);
