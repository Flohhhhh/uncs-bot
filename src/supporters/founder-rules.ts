import { and, eq, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../database/database.types";
import { supporterFounders, supporterMembers, supporterPayments } from "../database/supporters.schema";
import {
  FOUNDER_PAYMENT_SOURCES,
  founderBlocker,
  founderIdentity,
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

/** Founder awards for one person serialize on each identity before the cross-record check. */
export async function lockKeys(tx: Executor, keys: string[]) {
  for (const key of [...new Set(keys)].sort())
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export function identityKeys(prefix: string, identity: { discordId?: string | null; steamId?: string | null }) {
  return [
    ...(identity.discordId ? [`${prefix}:discord:${identity.discordId}`] : []),
    ...(identity.steamId ? [`${prefix}:steam:${identity.steamId}`] : []),
  ];
}

/** Another supporter record for the same Discord account or SteamID already holds a founder promise. */
export async function otherFounder(db: Executor, member: FounderIdentity) {
  const identity = [
    member.discordId ? eq(supporterMembers.discordId, member.discordId) : undefined,
    member.steamId ? eq(supporterMembers.steamId, member.steamId) : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);
  if (!identity.length) return false;
  const [other] = await db
    .select({ memberId: supporterFounders.memberId })
    .from(supporterFounders)
    .innerJoin(supporterMembers, eq(supporterMembers.id, supporterFounders.memberId))
    .where(and(ne(supporterMembers.id, member.id), or(...identity)))
    .limit(1);
  return Boolean(other);
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
  return founderBlocker(payment, policy, {
    earlierPayment: Boolean(earlier),
    importedCopyUnverified: Boolean(copy && copy.verification_state !== "verified"),
    hasIdentity: founderIdentity(member),
    otherFounder: await otherFounder(db, member),
  });
}
