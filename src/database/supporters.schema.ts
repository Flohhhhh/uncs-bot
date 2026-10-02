import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type SupporterProvider = "patreon" | "paypal";
// Plain text column: a new source is a TypeScript-only addition unless a check constrains it.
export type SupporterPaymentSource = "signed_status" | "manual_receipt" | "patreon_api" | "paypal";

export const supporterMembers = pgTable(
  "supporter_members",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").$type<SupporterProvider>().notNull().default("patreon"),
    // Patreon-only identifiers. PayPal supporters have neither; checks below keep each provider's shape.
    campaignId: text("campaign_id"),
    patreonMemberId: text("patreon_member_id"),
    displayName: text("display_name"),
    patronStatus: text("patron_status"),
    lastChargeStatus: text("last_charge_status"),
    lastChargeAt: timestamp("last_charge_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    reviewState: text("review_state").$type<"pending" | "verified" | "unverified">().notNull().default("pending"),
    discordId: text("discord_id"),
    steamId: text("steam_id"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("supporter_provider_member_unique").on(table.campaignId, table.patreonMemberId),
    uniqueIndex("supporter_discord_unique").on(table.campaignId, table.discordId),
    uniqueIndex("supporter_steam_unique").on(table.campaignId, table.steamId),
    // PayPal rows have no campaign, so the campaign-scoped indexes above never compare them.
    uniqueIndex("supporter_paypal_discord_unique")
      .on(table.discordId)
      .where(sql`${table.provider} = 'paypal'`),
    uniqueIndex("supporter_paypal_steam_unique")
      .on(table.steamId)
      .where(sql`${table.provider} = 'paypal'`),
    check("supporter_members_provider_check", sql`${table.provider} in ('patreon', 'paypal')`),
    check(
      "supporter_members_patreon_fields_check",
      sql`${table.provider} <> 'patreon' or (${table.campaignId} is not null and ${table.patreonMemberId} is not null)`,
    ),
    check(
      "supporter_members_paypal_fields_check",
      sql`${table.provider} <> 'paypal' or (${table.campaignId} is null and ${table.patreonMemberId} is null)`,
    ),
  ],
);

export const supporterObservations = pgTable(
  "supporter_observations",
  {
    hash: text("hash").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => supporterMembers.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    trigger: text("trigger").notNull(),
    patronStatus: text("patron_status"),
    lastChargeStatus: text("last_charge_status"),
    lastChargeAt: timestamp("last_charge_at", { withTimezone: true }),
  },
  (table) => [index("supporter_observations_member_idx").on(table.memberId, table.receivedAt)],
);

export const supporterPayments = pgTable(
  "supporter_payments",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => supporterMembers.id),
    // Null for PayPal payments, which belong to no Patreon campaign.
    campaignId: text("campaign_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    source: text("source").$type<SupporterPaymentSource>().notNull(),
    reference: text("reference").notNull(),
    verificationState: text("verification_state").$type<"verified" | "unverified">().notNull(),
    firstSuccessfulPaymentVerified: boolean("first_successful_payment_verified").notNull().default(false),
    verifiedBy: text("verified_by"),
    // Staff attestation that a non-USD payment was worth at least the US$5 founder minimum.
    minimumConfirmed: boolean("minimum_confirmed").notNull().default(false),
    // Staff ID or a system actor such as "system:patreon-import"; null for signed webhook rows.
    recordedBy: text("recorded_by"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("supporter_payment_reference_unique").on(table.campaignId, table.source, table.reference),
    index("supporter_payment_member_idx").on(table.memberId, table.paidAt),
    // A PayPal transaction ID is recorded once across the whole ledger.
    uniqueIndex("supporter_payment_paypal_reference_unique")
      .on(table.reference)
      .where(sql`${table.source} = 'paypal'`),
    check(
      "supporter_payments_paypal_fields_check",
      sql`${table.source} <> 'paypal' or (${table.campaignId} is null and ${table.amountCents} is not null and ${table.currency} is not null and ${table.verificationState} = 'verified')`,
    ),
  ],
);

// Permanent promises are separate records. Provider updates never mutate them.
export const supporterFounders = pgTable("supporter_founders", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => supporterMembers.id),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => supporterPayments.id),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull(),
  awardedBy: text("awarded_by").notNull(),
  reason: text("reason").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
});

export const supporterActions = pgTable(
  "supporter_actions",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => supporterMembers.id),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    fingerprint: text("fingerprint").notNull(),
    details: jsonb("details").$type<Record<string, string | number | null>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("supporter_actions_member_idx").on(table.memberId, table.createdAt)],
);
