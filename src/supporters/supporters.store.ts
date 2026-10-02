import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, lt, ne, or, sql, type SQL } from "drizzle-orm";
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
import {
  FOUNDER_PAYMENT_SOURCES,
  founderBlockedMessages,
  founderBlocker,
  founderIdentity,
  type FounderBlockedReason,
  type FounderPaymentFacts,
  type FounderPolicy,
  type ManualMemberInput,
  type PatreonObservation,
  type PaymentView,
  type PaypalInput,
  type SupporterMutation,
  type SupporterView,
} from "./supporters.types";

type Executor = Pick<Database, "select" | "execute">;
type MemberRow = typeof supporterMembers.$inferSelect;
type PaymentRow = typeof supporterPayments.$inferSelect;
type Identity = { id: string; discordId: string | null; steamId: string | null };
// Internal columns used to explain founder readiness; removed before a view leaves the store.
type StoredSupporter = Omit<SupporterView, "founderBlockedReason" | "needsDiscordLink"> & {
  founderCandidate: { payment: PaymentView; earlier: boolean } | null;
  otherFounder: boolean;
};

const qualifyingSources = sql`(${sql.join(
  FOUNDER_PAYMENT_SOURCES.map((source) => sql`${source}`),
  sql`, `,
)})`;

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
      // last_charge_date orders charge observations, not membership changes. An
      // undated/equal-date update is always pending review, never an entitlement.
      const olderCharge =
        member.lastChargeAt && observation.lastChargeAt && observation.lastChargeAt < member.lastChargeAt;
      await tx
        .update(supporterMembers)
        .set({
          ...(!olderCharge
            ? {
                displayName: observation.displayName,
                patronStatus: observation.patronStatus,
                ...(observation.lastChargeAt || !member.lastChargeAt
                  ? {
                      lastChargeStatus: observation.lastChargeStatus,
                      lastChargeAt: observation.lastChargeAt,
                    }
                  : {}),
              }
            : {}),
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
    const payment = (alias: string) =>
      sql.raw(
        `json_build_object('id', ${alias}.id, 'paidAt', ${alias}.paid_at, 'amountCents', ${alias}.amount_cents, 'currency', ${alias}.currency, 'source', ${alias}.source, 'reference', ${alias}.reference, 'verificationState', ${alias}.verification_state, 'firstSuccessfulPaymentVerified', ${alias}.first_successful_payment_verified, 'minimumConfirmed', ${alias}.minimum_confirmed, 'recordedBy', ${alias}.recorded_by)`,
      );
    const result = await this.db.execute<{ supporter: StoredSupporter }>(sql`
      SELECT json_build_object('id', m.id, 'provider', m.provider, 'patreonMemberId', m.patreon_member_id,
        'confirmKey', coalesce(m.patreon_member_id, m.id::text), 'displayName', m.display_name,
        'patronStatus', m.patron_status, 'lastChargeStatus', m.last_charge_status, 'lastChargeAt', m.last_charge_at,
        'observedAt', m.observed_at, 'reviewState', m.review_state, 'discordId', m.discord_id, 'steamId', m.steam_id,
        'identityState', CASE WHEN m.discord_id IS NOT NULL AND m.steam_id IS NOT NULL THEN 'staff_linked' ELSE 'unlinked' END,
        'version', m.version,
        'latestPayment', (SELECT ${payment("p")} FROM supporter_payments p WHERE p.member_id = m.id
          ORDER BY (p.source IN ${qualifyingSources}) DESC, p.paid_at DESC, p.recorded_at DESC LIMIT 1),
        'payments', (SELECT coalesce(json_agg(recent.payment ORDER BY recent.paid_at DESC, recent.recorded_at DESC), '[]'::json)
          FROM (SELECT ${payment("p")} AS payment, p.paid_at, p.recorded_at FROM supporter_payments p
            WHERE p.member_id = m.id ORDER BY p.paid_at DESC, p.recorded_at DESC LIMIT 20) recent),
        'founderEligiblePayment', (SELECT ${payment("p")} FROM supporter_payments p WHERE p.member_id = m.id
          AND ${policy.configured} AND p.source IN ${qualifyingSources} AND p.verification_state = 'verified'
          AND p.first_successful_payment_verified AND NOT EXISTS (SELECT 1 FROM supporter_payments earlier WHERE earlier.member_id = m.id AND earlier.paid_at < p.paid_at)
          AND p.amount_cents IS NOT NULL
          AND ((p.currency = ${policy.currency} AND p.amount_cents >= ${policy.amountCents})
            OR (p.currency IS NOT NULL AND p.currency <> ${policy.currency} AND p.minimum_confirmed))
          AND p.paid_at >= ${policy.startsAt}::timestamptz AND p.paid_at < ${policy.endsAt}::timestamptz
          ORDER BY p.paid_at DESC, p.recorded_at DESC LIMIT 1),
        'founderCandidate', (SELECT json_build_object('payment', ${payment("p")}, 'earlier',
            EXISTS (SELECT 1 FROM supporter_payments earlier WHERE earlier.member_id = m.id AND earlier.paid_at < p.paid_at))
          FROM supporter_payments p WHERE p.member_id = m.id
          ORDER BY (p.source IN ${qualifyingSources}) DESC, p.paid_at ASC, p.recorded_at ASC LIMIT 1),
        'otherFounder', EXISTS (SELECT 1 FROM supporter_founders other_founder
          JOIN supporter_members other_member ON other_member.id = other_founder.member_id
          WHERE other_member.id <> m.id AND ((m.discord_id IS NOT NULL AND other_member.discord_id = m.discord_id)
            OR (m.steam_id IS NOT NULL AND other_member.steam_id = m.steam_id))),
        'founder', (SELECT json_build_object('awardedAt', f.awarded_at, 'paymentId', f.payment_id, 'source', founder_payment.source)
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
    return result.rows.map((row) => this.view(row.supporter, policy));
  }

  private view(stored: StoredSupporter, policy: FounderPolicy): SupporterView {
    const { founderCandidate, otherFounder, ...supporter } = stored;
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
              hasIdentity: founderIdentity(supporter),
              otherFounder,
            });
    }
    return {
      ...supporter,
      payments: supporter.payments ?? [],
      founderBlockedReason,
      needsDiscordLink: Boolean(supporter.founder) && !supporter.discordId,
    };
  }

  async get(memberId: string, campaignId: string | null, policy: FounderPolicy) {
    return (await this.list(campaignId, policy, memberId))[0] ?? null;
  }

  /** Founder awards for one person serialize on each identity before the cross-record check. */
  private async lock(tx: Executor, keys: string[]) {
    for (const key of [...new Set(keys)].sort())
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  private identityKeys(prefix: string, identity: { discordId?: string | null; steamId?: string | null }) {
    return [
      ...(identity.discordId ? [`${prefix}:discord:${identity.discordId}`] : []),
      ...(identity.steamId ? [`${prefix}:steam:${identity.steamId}`] : []),
    ];
  }

  /** Another supporter record for the same Discord account or SteamID already holds a founder promise. */
  private async otherFounder(db: Executor, member: Identity) {
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

  private async founderCheck(db: Executor, member: Identity, payment: FounderPaymentFacts, policy: FounderPolicy) {
    const [earlier] = await db
      .select({ id: supporterPayments.id })
      .from(supporterPayments)
      .where(and(eq(supporterPayments.memberId, member.id), lt(supporterPayments.paidAt, new Date(payment.paidAt))))
      .limit(1);
    return founderBlocker(payment, policy, {
      earlierPayment: Boolean(earlier),
      hasIdentity: founderIdentity(member),
      otherFounder: await this.otherFounder(db, member),
    });
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
        const discordId = input.discordId ?? member.discordId,
          steamId = input.steamId ?? member.steamId;
        details.previousDiscordId = member.discordId;
        details.previousSteamId = member.steamId;
        details.discordId = discordId;
        details.steamId = steamId;
        await tx.update(supporterMembers).set({ discordId, steamId }).where(eq(supporterMembers.id, memberId));
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
        await this.lock(tx, this.identityKeys("founder", member));
        const blocked = await this.founderCheck(tx, member, payment, policy);
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
      await this.lock(tx, [`paypal:${input.transactionId}`]);
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
      await this.lock(tx, this.identityKeys("paypal-member", input));
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
            steamId: input.steamId ?? null,
            observedAt: now,
            reviewState: "verified",
            version: 1,
          })
          .returning();
      }
      const identity: Identity = {
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
        await this.lock(tx, this.identityKeys("founder", identity));
        const [existing] = await tx
          .select({ memberId: supporterFounders.memberId })
          .from(supporterFounders)
          .where(eq(supporterFounders.memberId, member.id));
        const blocked = existing ? "already_founder" : await this.founderCheck(tx, identity, payment, policy);
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
          .set({ discordId: identity.discordId, steamId: identity.steamId, version: member.version + 1 })
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
        : await this.founderCheck(this.db, supporter, payment, policy);
    return {
      ok: true,
      replayed: result.replayed,
      supporter,
      payment: paymentView(payment),
      founder: { awarded, eligible: awarded || blockedReason === null, blockedReason },
    };
  }
}
