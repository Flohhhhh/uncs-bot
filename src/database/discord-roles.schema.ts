import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export type DiscordRoleTrigger = "startup" | "event" | "member-join" | "admin" | "schedule";
export type DiscordRoleKind = "member" | "founder" | "supporter";
export type DiscordRoleBasisType = "application" | "founder" | "supporter";
export type DiscordRoleOperation = "add" | "remove" | "note";
export type DiscordRoleActionState = "started" | "applied" | "failed" | "unknown";

// Every automatic role change is recorded BEFORE Discord is called and completed afterwards.
// An unfinished ("started") row means the result is unknown. A "note" row records a role that was
// already present, so it is never counted as added by Gramps and never removed automatically.
export const discordRoleActions = pgTable(
  "discord_role_actions",
  {
    id: uuid("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    // The staff member who asked for an admin-triggered pass; null for automatic passes.
    requestedBy: text("requested_by"),
    trigger: text("trigger").$type<DiscordRoleTrigger>().notNull(),
    guildId: text("guild_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    roleKind: text("role_kind").$type<DiscordRoleKind>().notNull(),
    roleId: text("role_id").notNull(),
    operation: text("operation").$type<DiscordRoleOperation>().notNull(),
    basisType: text("basis_type").$type<DiscordRoleBasisType>().notNull(),
    // The application UUID or the supporter record UUID that justified this operation.
    basisId: text("basis_id").notNull(),
    changed: boolean("changed").notNull().default(false),
    state: text("state").$type<DiscordRoleActionState>().notNull().default("started"),
    message: text("message").notNull().default("Recorded before contacting Discord."),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("discord_role_actions_user_idx").on(table.guildId, table.discordUserId, table.roleKind, table.createdAt),
    index("discord_role_actions_created_idx").on(table.createdAt),
  ],
);
