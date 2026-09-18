import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const guildWelcomeSettings = pgTable("guild_welcome_settings", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  message: text("message").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GuildWelcomeSettings = typeof guildWelcomeSettings.$inferSelect;
