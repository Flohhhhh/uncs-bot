import { and, eq, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../database/database.types";
import { supporterFounders, supporterMembers, supporterPayments } from "../database/supporters.schema";
import {
  FOUNDER_PAYMENT_SOURCES,
  founderBlocker,
  founderIdentity,
  type FounderBlockedReason,
  type FounderPaymentFacts,
  type FounderPolicy,
} from "./supporters.types";

/**
 * The founder rule's database checks, shared by staff awards, PayPal records and automatic matching so every path
 * applies exactly the same rule under the same locks.
 */
export type Executor = Pick<Database, "select" | "execute">;
export type FounderIdentity = { id: string; discordId: string | null; steamId: string | null };

export const qualifyingSources = sql`(${sql.join(
  FOUNDER_PAYMENT_SOURCES.map((source) => sql`${source}`),
  sql`, `,
)})`;
/**
 * Staff estimate a receipt's time from Patreon's date-only payment history, so the imported row for the same charge
 * can fall on either side of it. Monthly charges are weeks apart.
 */
export const RECEIPT_COPY_TOLERANCE = "interval '36 hours'";
/**
 * Lateral subquery for the imported copy of the staff receipt aliased `receipt`: the patreon_api payment with the
 * receipt's amount and currency nearest in time to it, within the tolerance. Yields no row for other sources.
 */
export const receiptCopy = (receipt: string) =>
  sql.raw(`(SELECT api.id, api.verification_state FROM supporter_payments api
      WHERE ${receipt}.source = 'manual_receipt' AND api.member_id = ${receipt}.member_id AND api.source = 'patreon_api'
      AND api.amount_cents = ${receipt}.amount_cents AND api.currency = ${receipt}.currency
      AND api.paid_at BETWEEN ${receipt}.paid_at - ${RECEIPT_COPY_TOLERANCE} AND ${receipt}.paid_at + ${RECEIPT_COPY_TOLERANCE}
      ORDER BY abs(extract(epoch FROM api.paid_at - ${receipt}.paid_at)), api.paid_at, api.id LIMIT 1)`);
/**
 * The founder rule's earlier-payment test for the payment aliased `p` and its receipt copy `dup`, for every provider.
 * founderCheck applies the same test. The imported copy of a staff receipt's own charge is not an earlier payment, and
 * webhook status rows (no amount, repeating charges the authenticated history covers) never block a Patreon API payment.
 */
export const earlierPayment = sql.raw(`EXISTS (SELECT 1 FROM supporter_payments earlier
            WHERE earlier.member_id = p.member_id AND earlier.paid_at < p.paid_at AND earlier.id IS DISTINCT FROM dup.id
            AND (p.source <> 'patreon_api' OR earlier.source <> 'signed_status'))`);

/** A payment as the Supporters page shows it, for the payment row aliased `alias`. */
export const paymentJson = (alias: string) =>
  sql.raw(
    `json_build_object('id', ${alias}.id, 'paidAt', ${alias}.paid_at, 'amountCents', ${alias}.amount_cents, 'currency', ${alias}.currency, 'source', ${alias}.source, 'reference', ${alias}.reference, 'verificationState', ${alias}.verification_state, 'firstSuccessfulPaymentVerified', ${alias}.first_successful_payment_verified, 'minimumConfirmed', ${alias}.minimum_confirmed, 'recordedBy', ${alias}.recorded_by)`,
  );

/**
 * The audit rows the Patreon import writes on a record that gave up a Discord account Patreon moved elsewhere: the
 * record it moved from (`patreon-discord-moved`), or a Patreon link that followed another account
 * (`patreon-discord-link`). Each names the account in `previousDiscordId`, so that record stays the same person's.
 */
export const PATREON_DISCORD_RELEASED = ["patreon-discord-moved", "patreon-discord-link"] as const;
const releasedKinds = sql.raw(`(${PATREON_DISCORD_RELEASED.map((kind) => `'${kind}'`).join(", ")})`);

/**
 * The facts automatic supporter matching reads for the supporter row aliased `m` (see MatchFacts). The Supporters page
 * and the automatic writes both select this one expression, so the page shows exactly what automation would do.
 *
 * - applications: every whitelist application of the record's Discord account on any server, with whether another
 *   Discord account claims its SteamID, whether any application for that SteamID was declined or revoked, and whether
 *   another supporter record (any PayPal record, or a Patreon record of `campaignId`) holds it. Email, consent and
 *   reviewer notes are never selected.
 * - automatic: the earliest verified first Patreon API payment, with the founder rule's own earlier-payment test and
 *   whether another record with the same Discord account or SteamID has an earlier payment of any kind. A record the
 *   Patreon import took this Discord account from counts too (see PATREON_DISCORD_RELEASED), so moving an account
 *   never hides the person's earlier payment.
 * - whether Patreon reports this record's Discord account for another patron, and whether the account Patreon reports
 *   for this record is linked to another record.
 * - whether another Discord account has an application for the linked SteamID that was not declined or revoked. Only
 *   that yes or no is read: never the other account, its server or its status.
 * - when the patron last linked the record's current Discord account by signing in to Discord and Patreon, from the
 *   audit row "Link Patreon" writes. A later link of another account does not count for this one.
 */
export function matchFactsSql(campaignId: string | null) {
  return sql`json_build_object(
    'applications', (SELECT coalesce(json_agg(json_build_object('id', a.id, 'serverId', a.server_id,
        'steamId', a.steam_id, 'status', a.status, 'accessIntent', a.access_intent,
        'whitelistGrant', a.whitelist_grant, 'revokedAt', a.revoked_at, 'reviewedAt', a.reviewed_at,
        'otherDiscordClaim', EXISTS (SELECT 1 FROM whitelist_applications claim WHERE claim.steam_id = a.steam_id
          AND claim.discord_user_id <> a.discord_user_id AND claim.status NOT IN ('declined', 'revoked')),
        'rejectedBefore', EXISTS (SELECT 1 FROM whitelist_applications rejected WHERE rejected.steam_id = a.steam_id
          AND rejected.status IN ('declined', 'revoked')),
        'otherSupporter', EXISTS (SELECT 1 FROM supporter_members holder WHERE holder.id <> m.id
          AND holder.steam_id = a.steam_id
          AND (holder.provider = 'paypal' OR (holder.provider = 'patreon' AND holder.campaign_id = ${campaignId}))))
        ORDER BY a.reviewed_at NULLS LAST, a.id), '[]'::json)
      FROM whitelist_applications a WHERE a.discord_user_id = m.discord_id),
    'automatic', (SELECT json_build_object('payment', ${paymentJson("p")}, 'earlier', ${earlierPayment},
        'earlierOtherRecord', EXISTS (SELECT 1 FROM supporter_members other_record
          JOIN supporter_payments other_payment ON other_payment.member_id = other_record.id
          WHERE other_record.id <> m.id AND other_payment.paid_at < p.paid_at
          AND ((m.discord_id IS NOT NULL AND other_record.discord_id = m.discord_id)
            OR (m.steam_id IS NOT NULL AND other_record.steam_id = m.steam_id)
            OR (m.discord_id IS NOT NULL AND EXISTS (SELECT 1 FROM supporter_actions held
              WHERE held.member_id = other_record.id AND held.kind IN ${releasedKinds}
              AND held.details->>'previousDiscordId' = m.discord_id)))))
      FROM supporter_payments p LEFT JOIN LATERAL ${receiptCopy("p")} dup ON true
      WHERE p.member_id = m.id AND p.source = 'patreon_api' AND p.verification_state = 'verified'
        AND p.first_successful_payment_verified
      ORDER BY p.paid_at, p.id LIMIT 1),
    'discordReportedForOtherPatron', EXISTS (SELECT 1 FROM supporter_members reporter WHERE reporter.id <> m.id
      AND reporter.provider = 'patreon' AND reporter.campaign_id = m.campaign_id
      AND reporter.patreon_discord_id = m.discord_id),
    'patreonDiscordElsewhere', m.patreon_discord_id IS NOT NULL AND m.patreon_discord_id IS DISTINCT FROM m.discord_id
      AND EXISTS (SELECT 1 FROM supporter_members linked WHERE linked.id <> m.id AND linked.provider = 'patreon'
        AND linked.campaign_id = m.campaign_id AND linked.discord_id = m.patreon_discord_id),
    'linkedSteamShared', m.discord_id IS NOT NULL AND m.steam_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM whitelist_applications shared WHERE shared.steam_id = m.steam_id
        AND shared.discord_user_id <> m.discord_id AND shared.status NOT IN ('declined', 'revoked')),
    'patronLinkedAt', (SELECT max(a.created_at) FROM supporter_actions a WHERE a.member_id = m.id
      AND a.kind = 'patron-discord-link' AND a.details->>'discordId' = m.discord_id))`;
}

/** Founder awards for one person serialize on each identity before the cross-record check. */
export async function lockKeys(tx: Executor, keys: string[]) {
  for (const key of [...new Set(keys)].sort())
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * The lock every write that links a SteamID to a supporter record takes first: the automatic fill, a staff Link and a
 * PayPal record. It comes after the member row lock and before any founder lock, the same order everywhere, so the
 * fill's check of other holders, made after it, sees every committed link of that SteamID.
 */
export function supporterSteamKeys(steamId: string | null | undefined) {
  return steamId ? [`supporter:steam:${steamId}`] : [];
}

export function identityKeys(prefix: string, identity: { discordId?: string | null; steamId?: string | null }) {
  return [
    ...(identity.discordId ? [`${prefix}:discord:${identity.discordId}`] : []),
    ...(identity.steamId ? [`${prefix}:steam:${identity.steamId}`] : []),
  ];
}

/**
 * How another founder record is the same person. `identity`: it holds the same Discord account or SteamID.
 * `application`: it has no SteamID linked, and its Discord account applied for the whitelist with this SteamID.
 */
export type FounderTie = "identity" | "application";
export const founderTieReason = {
  identity: "already_founder",
  application: "steam_applied_by_founder",
} as const satisfies Record<FounderTie, FounderBlockedReason>;

/**
 * A founder record other than `memberId` has no SteamID linked, and its Discord account applied for the whitelist
 * with `steamId` (an application not declined or revoked). A founder recorded on a Discord account alone is one
 * person by that account, so the application is all that ties them to the SteamID. Linking that founder's SteamID
 * settles it: the plain comparison then applies. otherFounder and list() select this one expression.
 */
export const founderAppliedWithSteam = (memberId: SQL, steamId: SQL) =>
  sql`EXISTS (SELECT 1 FROM supporter_founders applied_founder
      JOIN supporter_members applied_member ON applied_member.id = applied_founder.member_id
      JOIN whitelist_applications applied ON applied.discord_user_id = applied_member.discord_id
      WHERE applied_member.id <> ${memberId} AND applied_member.steam_id IS NULL AND applied.steam_id = ${steamId}
        AND applied.status NOT IN ('declined', 'revoked'))`;

/**
 * Another supporter record that already holds a founder promise is the same person: it has the same Discord account
 * or SteamID, or it has no SteamID and its Discord account applied for the whitelist with this one.
 */
export async function otherFounder(db: Executor, member: FounderIdentity): Promise<FounderTie | null> {
  const identity = [
    member.discordId ? eq(supporterMembers.discordId, member.discordId) : undefined,
    member.steamId ? eq(supporterMembers.steamId, member.steamId) : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);
  if (!identity.length) return null;
  const [other] = await db
    .select({ memberId: supporterFounders.memberId })
    .from(supporterFounders)
    .innerJoin(supporterMembers, eq(supporterMembers.id, supporterFounders.memberId))
    .where(and(ne(supporterMembers.id, member.id), or(...identity)))
    .limit(1);
  if (other) return "identity";
  if (!member.steamId) return null;
  const applied = await db.execute<{ applied: boolean }>(
    sql`SELECT ${founderAppliedWithSteam(sql`${member.id}`, sql`${member.steamId}`)} AS applied`,
  );
  return applied.rows[0]?.applied ? "application" : null;
}

/** The founder rule for one payment of any provider; list() applies the same rule in SQL. */
export async function founderCheck(
  db: Executor,
  member: FounderIdentity,
  payment: FounderPaymentFacts & { id: string },
  policy: FounderPolicy,
) {
  // The imported copy of a receipt's own charge is not an earlier payment, but a refund of it disqualifies.
  const [copy] =
    payment.source === "manual_receipt"
      ? (
          await db.execute<{ id: string; verification_state: "verified" | "unverified" }>(
            sql`SELECT dup.id, dup.verification_state FROM supporter_payments p
                    CROSS JOIN LATERAL ${receiptCopy("p")} dup WHERE p.id = ${payment.id}`,
          )
        ).rows
      : [];
  const [earlier] = await db
    .select({ id: supporterPayments.id })
    .from(supporterPayments)
    .where(
      and(
        eq(supporterPayments.memberId, member.id),
        lt(supporterPayments.paidAt, new Date(payment.paidAt)),
        // Webhook status rows carry no amount and repeat charges the authenticated history already
        // covers, so they cannot block a verified first payment imported from the Patreon API.
        payment.source === "patreon_api" ? ne(supporterPayments.source, "signed_status") : undefined,
        copy ? ne(supporterPayments.id, copy.id) : undefined,
      ),
    )
    .limit(1);
  const tie = await otherFounder(db, member);
  return founderBlocker(payment, policy, {
    earlierPayment: Boolean(earlier),
    importedCopyUnverified: Boolean(copy && copy.verification_state !== "verified"),
    hasIdentity: founderIdentity(member),
    otherFounder: tie === "identity",
    founderAppliedWithSteam: tie === "application",
  });
}
