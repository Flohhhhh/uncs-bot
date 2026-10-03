import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { DATABASE, type Database } from "../database/database.types";
import {
  supporterActions,
  supporterFounders,
  supporterMembers,
  supporterObservations,
  supporterPayments,
} from "../database/supporters.schema";
import type { Staff } from "../admin/admin.types";
import { isPublicIndividualSteamId } from "../common/steam-id";
import type {
  FounderPolicy,
  ManualMemberInput,
  PatreonObservation,
  SupporterMutation,
  SupporterView,
} from "./supporters.types";
import { firstPaidEventId, type PatreonMemberSnapshot } from "./patreon.client";

export const PATREON_SYNC_ACTOR = { id: "system:patreon-sync", name: "Patreon sync" } as const;
export type ApiImportResult = {
  memberId: string;
  patreonMemberId: string;
  created: boolean;
  updated: boolean;
  payments: number;
  revoked: number;
  discordLinked: boolean;
  conflict: "discord-in-use" | "discord-differs" | null;
};
/** A founder promise for staff review, with the payment that is no longer verified. */
export type FounderReview = {
  supporterId: string;
  patreonMemberId: string;
  paymentId: string;
  paymentSource: string;
  reference: string;
  unverifiedPaymentId: string;
  unverifiedReference: string;
};
type MemberRow = typeof supporterMembers.$inferSelect;
type ObservedFields = Pick<PatreonObservation, "displayName" | "patronStatus" | "lastChargeStatus" | "lastChargeAt">;

// last_charge_date orders charge observations, not membership changes. An older charge never replaces
// newer state, and an undated observation preserves the last known charge.
function observedPatch(member: MemberRow, observation: ObservedFields) {
  const olderCharge = member.lastChargeAt && observation.lastChargeAt && observation.lastChargeAt < member.lastChargeAt;
  return !olderCharge
    ? {
        displayName: observation.displayName,
        patronStatus: observation.patronStatus,
        ...(observation.lastChargeAt || !member.lastChargeAt
          ? { lastChargeStatus: observation.lastChargeStatus, lastChargeAt: observation.lastChargeAt }
          : {}),
      }
    : {};
}
/**
 * Staff estimate a receipt's time from Patreon's date-only payment history, so the imported row for the same charge
 * can fall on either side of it. Monthly charges are weeks apart.
 */
const RECEIPT_COPY_TOLERANCE = "interval '36 hours'";
/**
 * Lateral subquery for the imported copy of the staff receipt aliased `receipt`: the patreon_api payment with the
 * receipt's amount and currency nearest in time to it, within the tolerance. Yields no row for other sources.
 */
const receiptCopy = (receipt: string) =>
  sql.raw(`(SELECT api.id, api.verification_state FROM supporter_payments api
      WHERE ${receipt}.source = 'manual_receipt' AND api.member_id = ${receipt}.member_id AND api.source = 'patreon_api'
      AND api.amount_cents = ${receipt}.amount_cents AND api.currency = ${receipt}.currency
      AND api.paid_at BETWEEN ${receipt}.paid_at - ${RECEIPT_COPY_TOLERANCE} AND ${receipt}.paid_at + ${RECEIPT_COPY_TOLERANCE}
      ORDER BY abs(extract(epoch FROM api.paid_at - ${receipt}.paid_at)), api.paid_at, api.id LIMIT 1)`);
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Canonical member snapshot: an unchanged Patreon record hashes the same and adds no observation. */
export function apiSnapshotHash(campaignId: string, snapshot: PatreonMemberSnapshot) {
  return sha256({
    source: "patreon-api:v1",
    campaignId,
    patreonMemberId: snapshot.patreonMemberId,
    displayName: snapshot.displayName,
    patronStatus: snapshot.patronStatus,
    lastChargeStatus: snapshot.lastChargeStatus,
    lastChargeAt: snapshot.lastChargeAt?.toISOString() ?? null,
    historyComplete: snapshot.historyComplete,
    events: [...snapshot.events]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((event) => [
        event.id,
        event.date.toISOString(),
        event.amountCents,
        event.currency,
        event.paymentStatus,
        event.type,
      ]),
  });
}

@Injectable()
export class SupportersStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async register(input: ManualMemberInput, staff: Staff, campaignId: string, policy: FounderPolicy) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind: "manual-member", campaignId, ...input }))
      .digest("hex");
    const result = await this.db.transaction(async (tx) => {
      const now = new Date();
      const [inserted] = await tx
        .insert(supporterMembers)
        .values({
          id: randomUUID(),
          campaignId,
          patreonMemberId: input.patreonMemberId,
          displayName: input.displayName,
          observedAt: now,
          reviewState: "unverified",
        })
        .onConflictDoNothing({ target: [supporterMembers.campaignId, supporterMembers.patreonMemberId] })
        .returning({ id: supporterMembers.id });
      const [member] = await tx
        .select()
        .from(supporterMembers)
        .where(
          and(eq(supporterMembers.campaignId, campaignId), eq(supporterMembers.patreonMemberId, input.patreonMemberId)),
        )
        .for("update");
      // The provider uniqueness check serializes concurrent copies before the
      // receipt is read, including retries after a response was lost.
      const [previous] = await tx.select().from(supporterActions).where(eq(supporterActions.id, input.id));
      if (previous) {
        if (previous.memberId !== member.id || previous.actorId !== staff.id || previous.fingerprint !== fingerprint)
          throw new ConflictException("This action ID was already used for another review.");
        return { replayed: true, memberId: member.id };
      }
      if (!inserted)
        throw new ConflictException(
          "This Patreon membership is already recorded. Search its membership ID before reviewing.",
        );
      await tx.insert(supporterActions).values({
        id: input.id,
        memberId: member.id,
        actorId: staff.id,
        actorName: staff.name,
        kind: "manual-member",
        reason: input.reason,
        fingerprint,
        details: { patreonMemberId: input.patreonMemberId, campaignMembershipVerified: 1 },
        createdAt: now,
      });
      return { replayed: false, memberId: member.id };
    });
    return { ok: true, replayed: result.replayed, supporter: await this.get(result.memberId, campaignId, policy) };
  }

  async ingest(observation: PatreonObservation) {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(supporterMembers)
        .values({
          id: randomUUID(),
          campaignId: observation.campaignId,
          patreonMemberId: observation.patreonMemberId,
          observedAt: observation.receivedAt,
        })
        .onConflictDoNothing();
      const [member] = await tx
        .select()
        .from(supporterMembers)
        .where(
          and(
            eq(supporterMembers.campaignId, observation.campaignId),
            eq(supporterMembers.patreonMemberId, observation.patreonMemberId),
          ),
        )
        .for("update");
      const [inserted] = await tx
        .insert(supporterObservations)
        .values({
          hash: observation.hash,
          memberId: member.id,
          receivedAt: observation.receivedAt,
          trigger: observation.trigger,
          patronStatus: observation.patronStatus,
          lastChargeStatus: observation.lastChargeStatus,
          lastChargeAt: observation.lastChargeAt,
        })
        .onConflictDoNothing()
        .returning({ hash: supporterObservations.hash });
      if (!inserted) return { duplicate: true };
      // An undated/equal-date update is always pending review, never an entitlement.
      await tx
        .update(supporterMembers)
        .set({
          ...observedPatch(member, observation),
          observedAt: observation.receivedAt,
          reviewState: "pending",
          version: member.version + 1,
        })
        .where(eq(supporterMembers.id, member.id));
      if (observation.lastChargeStatus === "Paid" && observation.lastChargeAt) {
        await tx
          .insert(supporterPayments)
          .values({
            id: randomUUID(),
            memberId: member.id,
            campaignId: observation.campaignId,
            paidAt: observation.lastChargeAt,
            amountCents: null,
            currency: null,
            source: "signed_status",
            verificationState: "unverified",
            reference: observation.hash,
            recordedAt: observation.receivedAt,
          })
          .onConflictDoNothing();
      }
      return { duplicate: false };
    });
  }

  /**
   * Imports one authenticated Patreon API member. Each Paid pledge event becomes one verified
   * patreon_api payment keyed by its event ID; a later non-Paid status marks that payment unverified.
   * Founder records are never touched here.
   */
  async importApiMember(campaignId: string, snapshot: PatreonMemberSnapshot, receivedAt: Date) {
    const hash = apiSnapshotHash(campaignId, snapshot);
    const firstId = firstPaidEventId(snapshot.events, snapshot.historyComplete);
    return this.db.transaction(async (tx): Promise<ApiImportResult> => {
      const [created] = await tx
        .insert(supporterMembers)
        .values({ id: randomUUID(), campaignId, patreonMemberId: snapshot.patreonMemberId, observedAt: receivedAt })
        .onConflictDoNothing()
        .returning({ id: supporterMembers.id });
      const [member] = await tx
        .select()
        .from(supporterMembers)
        .where(
          and(
            eq(supporterMembers.campaignId, campaignId),
            eq(supporterMembers.patreonMemberId, snapshot.patreonMemberId),
          ),
        )
        .for("update");
      const [observed] = await tx
        .insert(supporterObservations)
        .values({
          hash,
          memberId: member.id,
          receivedAt,
          trigger: "api:sync",
          patronStatus: snapshot.patronStatus,
          lastChargeStatus: snapshot.lastChargeStatus,
          lastChargeAt: snapshot.lastChargeAt,
        })
        .onConflictDoNothing()
        .returning({ hash: supporterObservations.hash });
      // An already-seen snapshot still corrects fields a late webhook overwrote, within the older-charge guard.
      const fields = observedPatch(member, snapshot);
      const stale = Object.entries(fields).some(([key, value]) => {
        const current = member[key as keyof MemberRow];
        return current instanceof Date && value instanceof Date
          ? current.getTime() !== value.getTime()
          : current !== value;
      });
      const result: ApiImportResult = {
        memberId: member.id,
        patreonMemberId: member.patreonMemberId,
        created: !!created,
        updated: (!!observed || stale) && !created,
        payments: 0,
        revoked: 0,
        discordLinked: false,
        conflict: null,
      };
      // An unchanged snapshot keeps the member's review state; a changed or corrected one needs review like a webhook.
      const patch: Partial<typeof supporterMembers.$inferInsert> =
        observed || stale ? { ...fields, observedAt: receivedAt, reviewState: "pending" } : {};
      const actions: (typeof supporterActions.$inferInsert)[] = [];
      let paymentsChanged = false;
      const existing = new Map(
        (
          await tx
            .select()
            .from(supporterPayments)
            .where(and(eq(supporterPayments.memberId, member.id), eq(supporterPayments.source, "patreon_api")))
        ).map((row) => [row.reference, row]),
      );
      for (const event of [...snapshot.events].sort((a, b) => a.date.getTime() - b.date.getTime())) {
        const row = existing.get(event.id);
        const paid = event.paymentStatus === "Paid";
        if (paid && !row) {
          const [inserted] = await tx
            .insert(supporterPayments)
            .values({
              id: randomUUID(),
              memberId: member.id,
              campaignId,
              paidAt: event.date,
              amountCents: event.amountCents,
              currency: event.currency,
              source: "patreon_api",
              reference: event.id,
              verificationState: "verified",
              firstSuccessfulPaymentVerified: event.id === firstId,
              verifiedBy: PATREON_SYNC_ACTOR.id,
              recordedAt: receivedAt,
            })
            .onConflictDoNothing()
            .returning({ id: supporterPayments.id });
          if (inserted) result.payments++;
          continue;
        }
        if (!row) continue;
        // A truncated history cannot prove or disprove the first payment, so it keeps the earlier answer.
        const first = paid && (snapshot.historyComplete ? event.id === firstId : row.firstSuccessfulPaymentVerified);
        const state = paid ? "verified" : "unverified";
        if (row.verificationState === state && row.firstSuccessfulPaymentVerified === first) continue;
        await tx
          .update(supporterPayments)
          .set({ verificationState: state, firstSuccessfulPaymentVerified: first })
          .where(eq(supporterPayments.id, row.id));
        paymentsChanged = true;
        if (row.verificationState === state) continue;
        if (!paid) result.revoked++;
        actions.push({
          id: randomUUID(),
          memberId: member.id,
          actorId: PATREON_SYNC_ACTOR.id,
          actorName: PATREON_SYNC_ACTOR.name,
          kind: "patreon-payment-status",
          reason: `Patreon reported this payment as ${event.paymentStatus ?? "unknown"}.`,
          fingerprint: sha256({ kind: "patreon-payment-status", paymentId: row.id, state, hash }),
          details: {
            paymentId: row.id,
            reference: row.reference,
            previousVerificationState: row.verificationState,
            verificationState: state,
            paymentStatus: event.paymentStatus,
          },
          createdAt: receivedAt,
        });
      }
      if (snapshot.discordId && member.discordId !== snapshot.discordId) {
        if (member.discordId) result.conflict = "discord-differs";
        else {
          const [other] = await tx
            .select({ id: supporterMembers.id })
            .from(supporterMembers)
            .where(
              and(
                eq(supporterMembers.campaignId, campaignId),
                eq(supporterMembers.discordId, snapshot.discordId),
                ne(supporterMembers.id, member.id),
              ),
            )
            .limit(1);
          if (other) result.conflict = "discord-in-use";
          else {
            patch.discordId = snapshot.discordId;
            result.discordLinked = true;
            actions.push({
              id: randomUUID(),
              memberId: member.id,
              actorId: PATREON_SYNC_ACTOR.id,
              actorName: PATREON_SYNC_ACTOR.name,
              kind: "patreon-discord-link",
              reason: "Patreon reported the Discord account this patron connected.",
              fingerprint: sha256({ kind: "patreon-discord-link", memberId: member.id, discordId: snapshot.discordId }),
              details: {
                discordId: snapshot.discordId,
                previousDiscordId: null,
                patreonMemberId: member.patreonMemberId,
              },
              createdAt: receivedAt,
            });
          }
        }
      }
      if (observed || stale || result.payments || paymentsChanged || result.discordLinked)
        await tx
          .update(supporterMembers)
          .set({ ...patch, version: member.version + 1 })
          .where(eq(supporterMembers.id, member.id));
      for (const action of actions) await tx.insert(supporterActions).values(action);
      return result;
    });
  }

  /**
   * Permanent founder promises for staff review: the founder's own payment, or an imported payment dated inside the
   * founder window (widened by the receipt-copy tolerance), is no longer verified. This also covers a founder awarded
   * on a staff receipt whose charge Patreon later reports as refunded, declined or fraudulent.
   */
  async founderReviews(campaignId: string): Promise<FounderReview[]> {
    const tolerance = sql.raw(RECEIPT_COPY_TOLERANCE);
    const result = await this.db.execute<FounderReview>(sql`
      SELECT f.member_id AS "supporterId", m.patreon_member_id AS "patreonMemberId", f.payment_id AS "paymentId",
        q.source AS "paymentSource", q.reference,
        unverified.id AS "unverifiedPaymentId", unverified.reference AS "unverifiedReference"
      FROM supporter_founders f
      JOIN supporter_members m ON m.id = f.member_id
      JOIN supporter_payments q ON q.id = f.payment_id
      JOIN LATERAL (SELECT x.id, x.reference FROM supporter_payments x
        WHERE x.member_id = f.member_id AND x.verification_state <> 'verified'
        AND (x.id = f.payment_id OR (x.source = 'patreon_api'
          AND x.paid_at >= f.window_start - ${tolerance} AND x.paid_at < f.window_end + ${tolerance}))
        ORDER BY (x.id = f.payment_id) DESC, x.paid_at, x.id LIMIT 1) unverified ON true
      WHERE m.campaign_id = ${campaignId}
      ORDER BY f.awarded_at, f.member_id LIMIT 50
    `);
    return result.rows;
  }

  async list(campaignId: string, policy: FounderPolicy, memberId?: string, search = ""): Promise<SupporterView[]> {
    const payment = (alias: string) =>
      sql.raw(
        `json_build_object('id', ${alias}.id, 'paidAt', ${alias}.paid_at, 'amountCents', ${alias}.amount_cents, 'currency', ${alias}.currency, 'source', ${alias}.source, 'reference', ${alias}.reference, 'verificationState', ${alias}.verification_state, 'firstSuccessfulPaymentVerified', ${alias}.first_successful_payment_verified)`,
      );
    const result = await this.db.execute<{ supporter: SupporterView }>(sql`
      SELECT json_build_object('id', m.id, 'patreonMemberId', m.patreon_member_id, 'displayName', m.display_name,
        'patronStatus', m.patron_status, 'lastChargeStatus', m.last_charge_status, 'lastChargeAt', m.last_charge_at,
        'observedAt', m.observed_at, 'reviewState', m.review_state, 'discordId', m.discord_id, 'steamId', m.steam_id,
        'identityState', CASE WHEN m.discord_id IS NOT NULL AND m.steam_id IS NOT NULL THEN 'staff_linked' ELSE 'unlinked' END,
        'version', m.version,
        'latestPayment', (SELECT ${payment("p")} FROM supporter_payments p WHERE p.member_id = m.id
          ORDER BY (p.verification_state = 'verified') DESC, p.paid_at DESC, (p.source = 'manual_receipt') DESC,
            p.recorded_at DESC LIMIT 1),
        'founderEligiblePayment', (SELECT ${payment("p")} FROM supporter_payments p
          LEFT JOIN LATERAL ${receiptCopy("p")} dup ON true
          WHERE p.member_id = m.id
          AND ${policy.configured} AND p.source IN ('manual_receipt', 'patreon_api') AND p.verification_state = 'verified'
          AND p.first_successful_payment_verified AND NOT EXISTS (SELECT 1 FROM supporter_payments earlier
            WHERE earlier.member_id = m.id AND earlier.paid_at < p.paid_at AND earlier.id IS DISTINCT FROM dup.id
            AND (p.source = 'manual_receipt' OR earlier.source <> 'signed_status'))
          AND (dup.id IS NULL OR dup.verification_state = 'verified')
          AND p.amount_cents >= ${policy.amountCents} AND p.currency = ${policy.currency}
          AND p.paid_at >= ${policy.startsAt}::timestamptz AND p.paid_at < ${policy.endsAt}::timestamptz
          ORDER BY (p.source = 'manual_receipt') DESC, p.paid_at DESC, p.recorded_at DESC LIMIT 1),
        'founder', (SELECT json_build_object('awardedAt', f.awarded_at, 'paymentId', f.payment_id) FROM supporter_founders f WHERE f.member_id = m.id)
      ) AS supporter FROM supporter_members m WHERE m.campaign_id = ${campaignId}
      ${memberId ? sql`AND m.id = ${memberId}` : sql``}
      ${
        search
          ? sql`AND (
        strpos(lower(coalesce(m.display_name, '')), lower(${search})) > 0
        OR strpos(lower(m.patreon_member_id), lower(${search})) > 0
        OR strpos(coalesce(m.discord_id, ''), ${search}) > 0
        OR strpos(coalesce(m.steam_id, ''), ${search}) > 0
      )`
          : sql``
      }
      ORDER BY m.observed_at DESC, m.id LIMIT 100
    `);
    return result.rows.map((row) => row.supporter);
  }

  async get(memberId: string, campaignId: string, policy: FounderPolicy) {
    return (await this.list(campaignId, policy, memberId))[0] ?? null;
  }

  async mutate(memberId: string, input: SupporterMutation, staff: Staff, campaignId: string, policy: FounderPolicy) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ memberId, ...input }))
      .digest("hex");
    const result = await this.db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(supporterMembers)
        .where(and(eq(supporterMembers.id, memberId), eq(supporterMembers.campaignId, campaignId)))
        .for("update");
      if (!member) throw new NotFoundException("Supporter record not found.");
      const [previous] = await tx.select().from(supporterActions).where(eq(supporterActions.id, input.id));
      if (previous) {
        if (previous.memberId !== memberId || previous.actorId !== staff.id || previous.fingerprint !== fingerprint)
          throw new ConflictException("This action ID was already used for another review.");
        return { replayed: true };
      }
      if (input.version !== member.version || input.confirm !== member.patreonMemberId)
        throw new ConflictException("The record changed or confirmation did not match. Refresh before reviewing.");
      const now = new Date();
      const details: Record<string, string | number | null> = {};
      if (input.kind === "link") {
        details.previousDiscordId = member.discordId;
        details.previousSteamId = member.steamId;
        details.discordId = input.discordId;
        details.steamId = input.steamId;
        await tx
          .update(supporterMembers)
          .set({ discordId: input.discordId, steamId: input.steamId })
          .where(eq(supporterMembers.id, memberId));
      }
      if (input.kind === "payment") {
        const paymentId = randomUUID();
        await tx.insert(supporterPayments).values({
          id: paymentId,
          memberId,
          campaignId,
          paidAt: input.paidAt,
          amountCents: input.amountCents,
          currency: input.currency,
          source: "manual_receipt",
          reference: input.reference.toLowerCase(),
          verificationState: "verified",
          firstSuccessfulPaymentVerified: input.firstSuccessfulPaymentVerified,
          verifiedBy: staff.id,
          recordedAt: now,
        });
        details.paymentId = paymentId;
        details.reference = input.reference;
        details.amountCents = input.amountCents;
        details.currency = input.currency;
        details.paidAt = input.paidAt.toISOString();
        details.firstSuccessfulPaymentVerified = input.firstSuccessfulPaymentVerified ? 1 : 0;
      }
      if (input.kind === "founder") {
        const [payment] = await tx
          .select()
          .from(supporterPayments)
          .where(and(eq(supporterPayments.id, input.paymentId), eq(supporterPayments.memberId, memberId)));
        if (
          !policy.configured ||
          !member.discordId ||
          !isPublicIndividualSteamId(member.steamId) ||
          !payment ||
          (payment.source !== "manual_receipt" && payment.source !== "patreon_api") ||
          payment.verificationState !== "verified" ||
          !payment.firstSuccessfulPaymentVerified ||
          payment.currency !== policy.currency ||
          payment.amountCents === null ||
          payment.amountCents < policy.amountCents ||
          payment.paidAt < new Date(policy.startsAt!) ||
          payment.paidAt >= new Date(policy.endsAt!)
        )
          throw new ConflictException(
            "A linked identity and checked qualifying payment inside the founder window are required.",
          );
        // The imported copy of a receipt's own charge is not an earlier payment, but a refund of it disqualifies.
        const [copy] =
          payment.source === "manual_receipt"
            ? (
                await tx.execute<{ id: string; verification_state: "verified" | "unverified" }>(
                  sql`SELECT dup.id, dup.verification_state FROM supporter_payments p
                    CROSS JOIN LATERAL ${receiptCopy("p")} dup WHERE p.id = ${payment.id}`,
                )
              ).rows
            : [];
        if (copy && copy.verification_state !== "verified")
          throw new ConflictException(
            "Patreon no longer reports this receipt's charge as paid. Review the payment before recording a founder promise.",
          );
        const [earlier] = await tx
          .select({ id: supporterPayments.id })
          .from(supporterPayments)
          .where(
            and(
              eq(supporterPayments.memberId, memberId),
              lt(supporterPayments.paidAt, payment.paidAt),
              // Webhook status rows carry no amount and repeat charges the authenticated history already
              // covers, so they cannot block a verified first payment imported from the Patreon API.
              payment.source === "patreon_api" ? ne(supporterPayments.source, "signed_status") : undefined,
              copy ? ne(supporterPayments.id, copy.id) : undefined,
            ),
          )
          .limit(1);
        if (earlier)
          throw new ConflictException(
            "An earlier payment is recorded. Review the first successful payment before recording a founder promise.",
          );
        await tx.insert(supporterFounders).values({
          memberId,
          paymentId: payment.id,
          awardedAt: now,
          awardedBy: staff.id,
          reason: input.reason,
          windowStart: new Date(policy.startsAt!),
          windowEnd: new Date(policy.endsAt!),
        });
        details.paymentId = payment.id;
        details.windowStart = policy.startsAt;
        details.windowEnd = policy.endsAt;
      }
      await tx
        .update(supporterMembers)
        .set({ version: member.version + 1, ...(input.kind === "review" ? { reviewState: "verified" as const } : {}) })
        .where(eq(supporterMembers.id, memberId));
      await tx.insert(supporterActions).values({
        id: input.id,
        memberId,
        actorId: staff.id,
        actorName: staff.name,
        kind: input.kind,
        reason: input.reason,
        fingerprint,
        details,
        createdAt: now,
      });
      return { replayed: false };
    });
    return { ok: true, ...result, supporter: await this.get(memberId, campaignId, policy) };
  }
}
