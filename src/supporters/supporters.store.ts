import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { DATABASE, type Database } from "../database/database.types";
import {
  supporterActions,
  supporterFounders,
  supporterMembers,
  supporterObservations,
  supporterPayments,
  type SupporterProvider,
} from "../database/supporters.schema";
import type { Staff } from "../admin/admin.types";
import { firstPaidEventId, type PatreonMemberSnapshot } from "./patreon.client";
import {
  earlierPayment,
  type Executor,
  founderCheck,
  type FounderIdentity,
  identityKeys,
  lockKeys,
  matchFactsSql,
  otherFounder,
  paymentJson,
  qualifyingSources,
  RECEIPT_COPY_TOLERANCE,
  receiptCopy,
  supporterSteamKeys,
} from "./founder-rules";
import {
  applicationSteamMatch,
  AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
  automaticBlockedMessages,
  automaticFounderBlocker,
  type MatchFacts,
  sourceApplicationRevoked,
} from "./supporter-match.rules";
import {
  founderBlockedMessages,
  founderBlocker,
  founderIdentity,
  type FounderBlockedReason,
  type FounderPolicy,
  type ManualMemberInput,
  type PatreonObservation,
  type PaymentView,
  type PaypalInput,
  type SupporterMutation,
  type SupporterView,
} from "./supporters.types";

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
  /** The record's Discord account after the import, or null; used only to queue a Discord role check. */
  discordId: string | null;
  /** Patreon now reports a different Discord account (or none) for this membership than it did before. */
  patreonDiscordChanged: boolean;
};
/** A founder promise for staff review, with the payment that is no longer verified or no longer the first one. */
export type FounderReview = {
  supporterId: string;
  patreonMemberId: string;
  paymentId: string;
  paymentSource: string;
  reference: string;
  unverifiedPaymentId: string;
  unverifiedReference: string;
  /** `unverified`: the payment is no longer verified. `not_first_payment`: the founder's own payment lost its first-payment flag. */
  reviewReason: "unverified" | "not_first_payment";
};

type MemberRow = typeof supporterMembers.$inferSelect;
type PaymentRow = typeof supporterPayments.$inferSelect;
// Internal columns used to explain founder readiness; removed before a view leaves the store.
type StoredSupporter = Omit<
  SupporterView,
  | "founderBlockedReason"
  | "founderBlockedMessage"
  | "needsDiscordLink"
  | "match"
  | "automaticPayment"
  | "automaticBlockedReason"
  | "automaticBlockedMessage"
> & {
  founderCandidate: { payment: PaymentView; earlier: boolean; copyUnverified: boolean } | null;
  otherFounder: boolean;
  matchFacts: MatchFacts;
};
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

export function paymentView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    paidAt: row.paidAt.toISOString(),
    amountCents: row.amountCents,
    currency: row.currency,
    source: row.source,
    reference: row.reference,
    verificationState: row.verificationState,
    firstSuccessfulPaymentVerified: row.firstSuccessfulPaymentVerified,
    minimumConfirmed: row.minimumConfirmed,
    recordedBy: row.recordedBy,
  };
}

const STEAM_FROM_APPLICATION =
  "This SteamID was copied from the previous Discord account's whitelist application. Enter the SteamID again, or confirm it belongs to the new Discord account, to change the Discord account.";
const STEAM_FROM_PREVIOUS_ACCOUNT =
  "The previous Discord account applied for the whitelist with this SteamID. Confirm it belongs to the new Discord account too, or enter the right SteamID64.";

/** A founder refusal names its rule so staff see why nothing was recorded. */
function founderConflict(reason: FounderBlockedReason, suffix = "") {
  return new ConflictException({ message: `${founderBlockedMessages[reason]}${suffix}`, blockedReason: reason });
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

  /** Records one signed observation. A new one reports the record's Discord account so its roles can be checked. */
  async ingest(
    observation: PatreonObservation,
  ): Promise<{ duplicate: true } | { duplicate: false; memberId: string; discordId: string | null }> {
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
      if (!inserted) return { duplicate: true as const };
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
      return { duplicate: false as const, memberId: member.id, discordId: member.discordId };
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
        patreonMemberId: snapshot.patreonMemberId,
        created: !!created,
        updated: (!!observed || stale) && !created,
        payments: 0,
        revoked: 0,
        discordLinked: false,
        conflict: null,
        discordId: member.discordId,
        patreonDiscordChanged: false,
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
              recordedBy: PATREON_SYNC_ACTOR.id,
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
            patch.discordSource = "patreon";
            result.discordLinked = true;
            result.discordId = snapshot.discordId;
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
                patreonMemberId: snapshot.patreonMemberId,
              },
              createdAt: receivedAt,
            });
          }
        }
      }
      // What Patreon reports is kept even when it is not linked, so staff and automatic matching can compare it with
      // the link. An unreadable answer is not a disconnection and changes nothing.
      if (snapshot.discordKnown && snapshot.discordId !== member.patreonDiscordId) {
        patch.patreonDiscordId = snapshot.discordId;
        result.patreonDiscordChanged = true;
      }
      if (
        observed ||
        stale ||
        result.payments ||
        paymentsChanged ||
        result.discordLinked ||
        result.patreonDiscordChanged
      )
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
   * on a staff receipt whose charge Patreon later reports as refunded, declined or fraudulent, and a founder whose own
   * payment is no longer marked as the first successful payment (for example after the import saw an earlier charge).
   */
  async founderReviews(campaignId: string): Promise<FounderReview[]> {
    const tolerance = sql.raw(RECEIPT_COPY_TOLERANCE);
    const result = await this.db.execute<FounderReview>(sql`
      SELECT f.member_id AS "supporterId", m.patreon_member_id AS "patreonMemberId", f.payment_id AS "paymentId",
        q.source AS "paymentSource", q.reference,
        unverified.id AS "unverifiedPaymentId", unverified.reference AS "unverifiedReference",
        unverified.review_reason AS "reviewReason"
      FROM supporter_founders f
      JOIN supporter_members m ON m.id = f.member_id
      JOIN supporter_payments q ON q.id = f.payment_id
      JOIN LATERAL (SELECT x.id, x.reference,
          CASE WHEN x.verification_state <> 'verified' THEN 'unverified' ELSE 'not_first_payment' END AS review_reason
        FROM supporter_payments x
        WHERE x.member_id = f.member_id AND ((x.verification_state <> 'verified'
          AND (x.id = f.payment_id OR (x.source = 'patreon_api'
            AND x.paid_at >= f.window_start - ${tolerance} AND x.paid_at < f.window_end + ${tolerance})))
          OR (x.id = f.payment_id AND NOT x.first_successful_payment_verified))
        ORDER BY (x.id = f.payment_id) DESC, x.paid_at, x.id LIMIT 1) unverified ON true
      WHERE m.campaign_id = ${campaignId}
      ORDER BY f.awarded_at, f.member_id LIMIT 50
    `);
    return result.rows;
  }

  /**
   * PayPal supporters are always listed. Patreon supporters are listed only for the configured
   * campaign, so a null campaign (Patreon not configured) returns the PayPal ledger alone.
   */
  async list(
    campaignId: string | null,
    policy: FounderPolicy,
    memberId?: string,
    search = "",
    provider?: SupporterProvider,
  ): Promise<SupporterView[]> {
    const payment = paymentJson;
    // The founder-eligible payment prefers a staff receipt over the imported copy of the same charge, because the
    // current dashboard awards only on a receipt.
    const result = await this.db.execute<{ supporter: StoredSupporter }>(sql`
      SELECT json_build_object('id', m.id, 'provider', m.provider, 'patreonMemberId', m.patreon_member_id,
        'confirmKey', coalesce(m.patreon_member_id, m.id::text), 'displayName', m.display_name,
        'patronStatus', m.patron_status, 'lastChargeStatus', m.last_charge_status, 'lastChargeAt', m.last_charge_at,
        'observedAt', m.observed_at, 'reviewState', m.review_state, 'discordId', m.discord_id, 'steamId', m.steam_id,
        'discordSource', m.discord_source, 'patreonDiscordId', m.patreon_discord_id, 'steamSource', m.steam_source,
        'steamApplicationId', m.steam_application_id,
        'identityState', CASE WHEN m.discord_id IS NULL AND m.steam_id IS NULL THEN 'unlinked'
          WHEN m.discord_id IS NULL OR m.steam_id IS NULL THEN 'partial'
          WHEN m.discord_source = 'patreon' THEN 'patreon_linked' ELSE 'staff_linked' END,
        'version', m.version,
        'latestPayment', (SELECT ${payment("p")} FROM supporter_payments p WHERE p.member_id = m.id
          ORDER BY (p.verification_state = 'verified') DESC, (p.source IN ${qualifyingSources}) DESC, p.paid_at DESC,
            (p.source = 'manual_receipt') DESC, p.recorded_at DESC LIMIT 1),
        'payments', (SELECT coalesce(json_agg(recent.payment ORDER BY recent.paid_at DESC, recent.recorded_at DESC), '[]'::json)
          FROM (SELECT ${payment("p")} AS payment, p.paid_at, p.recorded_at FROM supporter_payments p
            WHERE p.member_id = m.id ORDER BY p.paid_at DESC, p.recorded_at DESC LIMIT 20) recent),
        'founderEligiblePayment', (SELECT ${payment("p")} FROM supporter_payments p
          LEFT JOIN LATERAL ${receiptCopy("p")} dup ON true
          WHERE p.member_id = m.id
          AND ${policy.configured} AND p.source IN ${qualifyingSources} AND p.verification_state = 'verified'
          AND p.first_successful_payment_verified AND NOT ${earlierPayment}
          AND (dup.id IS NULL OR dup.verification_state = 'verified')
          AND p.amount_cents IS NOT NULL
          AND ((p.currency = ${policy.currency} AND p.amount_cents >= ${policy.amountCents})
            OR (p.currency IS NOT NULL AND p.currency <> ${policy.currency} AND p.minimum_confirmed))
          AND p.paid_at >= ${policy.startsAt}::timestamptz AND p.paid_at < ${policy.endsAt}::timestamptz
          ORDER BY (p.source = 'manual_receipt') DESC, p.paid_at DESC, p.recorded_at DESC LIMIT 1),
        'founderCandidate', (SELECT json_build_object('payment', ${payment("p")}, 'earlier', ${earlierPayment},
            'copyUnverified', coalesce(dup.verification_state <> 'verified', false))
          FROM supporter_payments p LEFT JOIN LATERAL ${receiptCopy("p")} dup ON true WHERE p.member_id = m.id
          ORDER BY (p.source IN ${qualifyingSources}) DESC, p.paid_at ASC, p.recorded_at ASC LIMIT 1),
        'otherFounder', EXISTS (SELECT 1 FROM supporter_founders other_founder
          JOIN supporter_members other_member ON other_member.id = other_founder.member_id
          WHERE other_member.id <> m.id AND ((m.discord_id IS NOT NULL AND other_member.discord_id = m.discord_id)
            OR (m.steam_id IS NOT NULL AND other_member.steam_id = m.steam_id))),
        'matchFacts', ${matchFactsSql(campaignId)},
        'founder', (SELECT json_build_object('awardedAt', f.awarded_at, 'paymentId', f.payment_id, 'source', founder_payment.source,
            'automatic', f.awarded_by LIKE 'system:%')
          FROM supporter_founders f LEFT JOIN supporter_payments founder_payment ON founder_payment.id = f.payment_id
          WHERE f.member_id = m.id)
      ) AS supporter FROM supporter_members m
      WHERE (m.provider = 'paypal' OR (m.provider = 'patreon' AND m.campaign_id = ${campaignId}))
      ${provider ? sql`AND m.provider = ${provider}` : sql``}
      ${memberId ? sql`AND m.id = ${memberId}` : sql``}
      ${
        search
          ? sql`AND (
        strpos(lower(coalesce(m.display_name, '')), lower(${search})) > 0
        OR strpos(lower(coalesce(m.patreon_member_id, '')), lower(${search})) > 0
        OR strpos(coalesce(m.discord_id, ''), ${search}) > 0
        OR strpos(coalesce(m.steam_id, ''), ${search}) > 0
        OR EXISTS (SELECT 1 FROM supporter_payments paypal_payment WHERE paypal_payment.member_id = m.id
          AND paypal_payment.source = 'paypal' AND strpos(lower(paypal_payment.reference), lower(${search})) > 0)
      )`
          : sql``
      }
      ORDER BY m.observed_at DESC, m.id LIMIT 100
    `);
    const now = Date.now();
    return result.rows.map((row) => this.view(row.supporter, policy, now));
  }

  private view(stored: StoredSupporter, policy: FounderPolicy, now: number): SupporterView {
    const { founderCandidate, otherFounder, matchFacts, ...supporter } = stored;
    const facts: MatchFacts = {
      applications: matchFacts?.applications ?? [],
      automatic: matchFacts?.automatic ?? null,
      discordReportedForOtherPatron: Boolean(matchFacts?.discordReportedForOtherPatron),
      patreonDiscordElsewhere: Boolean(matchFacts?.patreonDiscordElsewhere),
      linkedSteamShared: Boolean(matchFacts?.linkedSteamShared),
    };
    let founderBlockedReason: SupporterView["founderBlockedReason"] = null;
    if (!supporter.founder) {
      const eligible = supporter.founderEligiblePayment;
      const candidate = eligible ?? founderCandidate?.payment ?? null;
      founderBlockedReason = !policy.configured
        ? "window_not_configured"
        : !candidate
          ? "no_payment"
          : founderBlocker(candidate, policy, {
              earlierPayment: eligible ? false : Boolean(founderCandidate?.earlier),
              importedCopyUnverified: eligible ? false : Boolean(founderCandidate?.copyUnverified),
              hasIdentity: founderIdentity(supporter),
              otherFounder,
            });
    }
    // The same verdict automatic matching reaches: its own rules, then the staff founder rule on its payment.
    const automaticBlockedReason = supporter.founder
      ? null
      : (automaticFounderBlocker(supporter, facts, {
          now,
          holdHours: policy.automaticHoldHours ?? AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
        }) ??
        founderBlocker(facts.automatic!.payment, policy, {
          earlierPayment: facts.automatic!.earlier,
          hasIdentity: founderIdentity(supporter),
          otherFounder,
        }));
    const source = supporter.steamApplicationId
      ? facts.applications.find((application) => application.id === supporter.steamApplicationId)
      : undefined;
    return {
      ...supporter,
      payments: supporter.payments ?? [],
      founderBlockedReason,
      founderBlockedMessage: founderBlockedReason ? founderBlockedMessages[founderBlockedReason] : null,
      needsDiscordLink: Boolean(supporter.founder) && !supporter.discordId,
      match: {
        steam: supporter.discordId ? applicationSteamMatch(facts.applications) : null,
        sourceApplication: source ? { id: source.id, serverId: source.serverId, status: source.status } : null,
        sourceApplicationRevoked: sourceApplicationRevoked(supporter, facts),
        patreonDiscordElsewhere: facts.patreonDiscordElsewhere,
        discordReportedForOtherPatron: facts.discordReportedForOtherPatron,
        linkedSteamShared: facts.linkedSteamShared,
      },
      automaticPayment: facts.automatic?.payment ?? null,
      automaticBlockedReason,
      automaticBlockedMessage: automaticBlockedReason ? automaticBlockedMessages[automaticBlockedReason] : null,
    };
  }

  async get(memberId: string, campaignId: string | null, policy: FounderPolicy) {
    return (await this.list(campaignId, policy, memberId))[0] ?? null;
  }

  async mutate(
    memberId: string,
    input: SupporterMutation,
    staff: Staff,
    campaignId: string | null,
    policy: FounderPolicy,
  ) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ memberId, ...input }))
      .digest("hex");
    const result = await this.db.transaction(async (tx) => {
      const [member] = await tx.select().from(supporterMembers).where(eq(supporterMembers.id, memberId)).for("update");
      if (!member) throw new NotFoundException("Supporter record not found.");
      // PayPal records need no Patreon configuration; Patreon records stay scoped to the configured campaign.
      if (member.provider === "patreon") {
        if (campaignId === null) throw new ServiceUnavailableException("Patreon integration is not configured.");
        if (member.campaignId !== campaignId) throw new NotFoundException("Supporter record not found.");
      }
      const [previous] = await tx.select().from(supporterActions).where(eq(supporterActions.id, input.id));
      if (previous) {
        if (previous.memberId !== memberId || previous.actorId !== staff.id || previous.fingerprint !== fingerprint)
          throw new ConflictException("This action ID was already used for another review.");
        return { replayed: true };
      }
      if (input.version !== member.version || input.confirm !== (member.patreonMemberId ?? member.id))
        throw new ConflictException("The record changed or confirmation did not match. Refresh before reviewing.");
      if (input.kind === "payment" && member.provider === "paypal")
        throw new ConflictException("Use the PayPal payment record for PayPal supporters.");
      const now = new Date();
      const details: Record<string, string | number | null> = {};
      if (input.kind === "link") {
        // Only a value that changes becomes a staff link; resending the current value keeps where it came from.
        const discordChanged = input.discordId !== undefined && input.discordId !== member.discordId;
        const steamChanged = input.steamId !== undefined && input.steamId !== member.steamId;
        // A SteamID copied from the old Discord account's application must not silently follow a new account.
        if (discordChanged && member.steamSource === "application" && !steamChanged && input.steamConfirmed !== true)
          throw new ConflictException({ message: STEAM_FROM_APPLICATION, blockedReason: "steam_from_application" });
        // Nor may a SteamID the previous Discord account applied with arrive together with a new Discord account
        // unconfirmed: the dashboard shows that application's SteamID for the account the record had.
        if (discordChanged && steamChanged && member.discordId && input.steamConfirmed !== true) {
          const previous = await tx.execute(sql`SELECT 1 FROM whitelist_applications
            WHERE discord_user_id = ${member.discordId} AND steam_id = ${input.steamId}
            AND status NOT IN ('declined', 'revoked') LIMIT 1`);
          if (previous.rows.length)
            throw new ConflictException({
              message: STEAM_FROM_PREVIOUS_ACCOUNT,
              blockedReason: "steam_from_application",
            });
        }
        const steamRestated = !steamChanged && input.steamConfirmed === true && member.steamId !== null;
        const discordId = discordChanged ? input.discordId! : member.discordId,
          steamId = steamChanged ? input.steamId! : member.steamId;
        const discordSource = discordChanged ? "staff" : member.discordSource,
          steamSource = steamChanged || steamRestated ? "staff" : member.steamSource,
          steamApplicationId = steamChanged || steamRestated ? null : member.steamApplicationId;
        if (discordChanged || steamChanged) {
          // A new SteamID is locked before any founder lock, as automatic matching does, so its fill sees this link.
          if (steamChanged) await lockKeys(tx, supporterSteamKeys(steamId));
          // A founder moved onto an identity another founder already holds would make one person a founder twice.
          const [founder] = await tx
            .select({ memberId: supporterFounders.memberId })
            .from(supporterFounders)
            .where(eq(supporterFounders.memberId, memberId));
          const added = {
            id: memberId,
            discordId: discordChanged ? discordId : null,
            steamId: steamChanged ? steamId : null,
          };
          if (founder) {
            await lockKeys(tx, identityKeys("founder", added));
            if (await otherFounder(tx, added)) throw founderConflict("already_founder");
          }
        }
        details.previousDiscordId = member.discordId;
        details.previousSteamId = member.steamId;
        details.discordId = discordId;
        details.steamId = steamId;
        details.previousDiscordSource = member.discordSource;
        details.discordSource = discordSource;
        details.previousSteamSource = member.steamSource;
        details.steamSource = steamSource;
        details.previousSteamApplicationId = member.steamApplicationId;
        if (input.steamConfirmed) details.steamConfirmed = 1;
        await tx
          .update(supporterMembers)
          .set({ discordId, discordSource, steamId, steamSource, steamApplicationId })
          .where(eq(supporterMembers.id, memberId));
      }
      if (input.kind === "payment") {
        const paymentId = randomUUID();
        await tx.insert(supporterPayments).values({
          id: paymentId,
          memberId,
          campaignId: member.campaignId,
          paidAt: input.paidAt,
          amountCents: input.amountCents,
          currency: input.currency,
          source: "manual_receipt",
          reference: input.reference.toLowerCase(),
          verificationState: "verified",
          firstSuccessfulPaymentVerified: input.firstSuccessfulPaymentVerified,
          verifiedBy: staff.id,
          recordedBy: staff.id,
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
        if (!payment) throw new ConflictException("Choose a payment recorded for this supporter.");
        // Automatic matching can record this member's promise meanwhile; say so instead of failing on the key.
        const [existing] = await tx
          .select({ memberId: supporterFounders.memberId })
          .from(supporterFounders)
          .where(eq(supporterFounders.memberId, memberId));
        if (existing) throw founderConflict("already_founder");
        await lockKeys(tx, identityKeys("founder", member));
        const blocked = await founderCheck(tx, member, payment, policy);
        if (blocked) throw founderConflict(blocked);
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
        details.paymentSource = payment.source;
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

  private async findPaypalMember(db: Executor, identity: { discordId?: string; steamId?: string }, lock: boolean) {
    for (const [column, value] of [
      [supporterMembers.discordId, identity.discordId],
      [supporterMembers.steamId, identity.steamId],
    ] as const) {
      if (!value) continue;
      const query = db
        .select()
        .from(supporterMembers)
        .where(and(eq(supporterMembers.provider, "paypal"), eq(column, value)));
      const [member] = lock ? await query.for("update") : await query;
      if (member) return member;
    }
    return undefined;
  }

  /**
   * Records one staff-checked PayPal payment, creating or attaching its PayPal supporter and, when asked
   * and eligible, the founder promise. Everything commits together or nothing is recorded.
   */
  async recordPaypal(input: PaypalInput, staff: Staff, campaignId: string | null, policy: FounderPolicy) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind: "paypal-payment", ...input }))
      .digest("hex");
    const result = await this.db.transaction(async (tx) => {
      // One transaction ID is processed at a time, so a retry sees the first request's committed records.
      await lockKeys(tx, [`paypal:${input.transactionId}`]);
      const [previous] = await tx.select().from(supporterActions).where(eq(supporterActions.id, input.id));
      if (previous) {
        if (
          previous.kind !== "paypal-payment" ||
          previous.actorId !== staff.id ||
          previous.fingerprint !== fingerprint ||
          typeof previous.details.paymentId !== "string"
        )
          throw new ConflictException("This action ID was already used for another review.");
        return { replayed: true, memberId: previous.memberId, paymentId: previous.details.paymentId };
      }
      // Two transactions for the same donor attach to one PayPal supporter instead of racing to create two.
      await lockKeys(tx, identityKeys("paypal-member", input));
      const [recorded] = await tx
        .select()
        .from(supporterPayments)
        .where(and(eq(supporterPayments.source, "paypal"), eq(supporterPayments.reference, input.transactionId)));
      if (recorded) {
        const resolved = input.memberId ?? (await this.findPaypalMember(tx, input, false))?.id ?? null;
        if (
          resolved !== recorded.memberId ||
          recorded.amountCents !== input.amountCents ||
          recorded.currency !== input.currency ||
          recorded.paidAt.getTime() !== input.paidAt.getTime()
        )
          throw new ConflictException(
            "This PayPal transaction is already recorded with different details. Search the transaction ID.",
          );
        if (input.awardFounder) {
          const [founder] = await tx
            .select({ memberId: supporterFounders.memberId })
            .from(supporterFounders)
            .where(eq(supporterFounders.memberId, recorded.memberId));
          if (!founder) throw new ConflictException("Already recorded; use the founder action.");
        }
        return { replayed: true, memberId: recorded.memberId, paymentId: recorded.id };
      }
      const now = new Date();
      let member: MemberRow | undefined;
      if (input.memberId) {
        [member] = await tx
          .select()
          .from(supporterMembers)
          .where(eq(supporterMembers.id, input.memberId))
          .for("update");
        if (!member || member.provider !== "paypal") throw new NotFoundException("PayPal supporter record not found.");
        if (member.version !== input.version)
          throw new ConflictException("The record changed. Refresh before recording this payment.");
      } else member = await this.findPaypalMember(tx, input, true);
      if (
        member &&
        ((input.discordId && member.discordId && member.discordId !== input.discordId) ||
          (input.steamId && member.steamId && member.steamId !== input.steamId))
      )
        throw new ConflictException(
          "This PayPal supporter is linked to a different Discord account or SteamID. Use Link to change it.",
        );
      const created = !member;
      // A SteamID this payment links is locked before it is written, like a staff Link, so automatic matching sees it.
      if (input.steamId && !member?.steamId) await lockKeys(tx, supporterSteamKeys(input.steamId));
      if (!member) {
        [member] = await tx
          .insert(supporterMembers)
          .values({
            id: randomUUID(),
            provider: "paypal",
            campaignId: null,
            patreonMemberId: null,
            displayName: input.displayName,
            discordId: input.discordId ?? null,
            discordSource: input.discordId ? "staff" : null,
            steamId: input.steamId ?? null,
            steamSource: input.steamId ? "staff" : null,
            observedAt: now,
            reviewState: "verified",
            version: 1,
          })
          .returning();
      }
      const identity: FounderIdentity = {
        id: member.id,
        discordId: member.discordId ?? input.discordId ?? null,
        steamId: member.steamId ?? input.steamId ?? null,
      };
      const [payment] = await tx
        .insert(supporterPayments)
        .values({
          id: randomUUID(),
          memberId: member.id,
          campaignId: null,
          paidAt: input.paidAt,
          amountCents: input.amountCents,
          currency: input.currency,
          source: "paypal",
          reference: input.transactionId,
          verificationState: "verified",
          firstSuccessfulPaymentVerified: input.firstSuccessfulPaymentVerified,
          minimumConfirmed: input.minimumConfirmed,
          verifiedBy: staff.id,
          recordedBy: staff.id,
          recordedAt: now,
        })
        .returning();
      let founderAwarded = false;
      if (input.awardFounder) {
        await lockKeys(tx, identityKeys("founder", identity));
        const [existing] = await tx
          .select({ memberId: supporterFounders.memberId })
          .from(supporterFounders)
          .where(eq(supporterFounders.memberId, member.id));
        const blocked = existing ? "already_founder" : await founderCheck(tx, identity, payment, policy);
        if (blocked) throw founderConflict(blocked, " Nothing was recorded.");
        await tx.insert(supporterFounders).values({
          memberId: member.id,
          paymentId: payment.id,
          awardedAt: now,
          awardedBy: staff.id,
          reason: input.reason,
          windowStart: new Date(policy.startsAt!),
          windowEnd: new Date(policy.endsAt!),
        });
        founderAwarded = true;
      }
      if (!created)
        await tx
          .update(supporterMembers)
          .set({
            discordId: identity.discordId,
            steamId: identity.steamId,
            // Only an identity this payment fills in becomes a staff link; existing links keep their source.
            ...(member.discordId === null && identity.discordId ? { discordSource: "staff" as const } : {}),
            ...(member.steamId === null && identity.steamId ? { steamSource: "staff" as const } : {}),
            version: member.version + 1,
          })
          .where(eq(supporterMembers.id, member.id));
      await tx.insert(supporterActions).values({
        id: input.id,
        memberId: member.id,
        actorId: staff.id,
        actorName: staff.name,
        kind: "paypal-payment",
        reason: input.reason,
        fingerprint,
        details: {
          transactionId: input.transactionId,
          paymentId: payment.id,
          amountCents: input.amountCents,
          currency: input.currency,
          paidAt: input.paidAt.toISOString(),
          createdMember: created ? 1 : 0,
          founderAwarded: founderAwarded ? 1 : 0,
          discordId: identity.discordId,
          steamId: identity.steamId,
          firstSuccessfulPaymentVerified: input.firstSuccessfulPaymentVerified ? 1 : 0,
          minimumConfirmed: input.minimumConfirmed ? 1 : 0,
        },
        createdAt: now,
      });
      return { replayed: false, memberId: member.id, paymentId: payment.id };
    });
    const supporter = await this.get(result.memberId, campaignId, policy);
    const [payment] = await this.db.select().from(supporterPayments).where(eq(supporterPayments.id, result.paymentId));
    if (!supporter || !payment) throw new NotFoundException("The PayPal record could not be read back. Refresh.");
    const awarded = supporter.founder?.paymentId === payment.id;
    const blockedReason: FounderBlockedReason | null = awarded
      ? null
      : supporter.founder
        ? "already_founder"
        : await founderCheck(this.db, supporter, payment, policy);
    return {
      ok: true,
      replayed: result.replayed,
      supporter,
      payment: paymentView(payment),
      founder: { awarded, eligible: awarded || blockedReason === null, blockedReason },
    };
  }
}
