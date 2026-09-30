import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";
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
import type { FounderPolicy, PatreonObservation, SupporterMutation, SupporterView } from "./supporters.types";

@Injectable()
export class SupportersStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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

  async list(campaignId: string, policy: FounderPolicy, memberId?: string): Promise<SupporterView[]> {
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
          ORDER BY (p.source = 'manual_receipt') DESC, p.paid_at DESC, p.recorded_at DESC LIMIT 1),
        'founderEligiblePayment', (SELECT ${payment("p")} FROM supporter_payments p WHERE p.member_id = m.id
          AND ${policy.configured} AND p.source = 'manual_receipt' AND p.verification_state = 'verified'
          AND p.first_successful_payment_verified AND NOT EXISTS (SELECT 1 FROM supporter_payments earlier WHERE earlier.member_id = m.id AND earlier.paid_at < p.paid_at)
          AND p.amount_cents >= ${policy.amountCents} AND p.currency = ${policy.currency}
          AND p.paid_at >= ${policy.startsAt}::timestamptz AND p.paid_at < ${policy.endsAt}::timestamptz
          ORDER BY p.paid_at DESC, p.recorded_at DESC LIMIT 1),
        'founder', (SELECT json_build_object('awardedAt', f.awarded_at, 'paymentId', f.payment_id) FROM supporter_founders f WHERE f.member_id = m.id)
      ) AS supporter FROM supporter_members m WHERE m.campaign_id = ${campaignId}
      ${memberId ? sql`AND m.id = ${memberId}` : sql``}
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
          !member.steamId ||
          !payment ||
          payment.source !== "manual_receipt" ||
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
        const [earlier] = await tx
          .select({ id: supporterPayments.id })
          .from(supporterPayments)
          .where(and(eq(supporterPayments.memberId, memberId), lt(supporterPayments.paidAt, payment.paidAt)))
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
