import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
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
