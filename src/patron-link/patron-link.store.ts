import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { DATABASE, type Database } from "../database/database.types";
import {
  supporterActions,
  supporterFounders,
  supporterMembers,
  supporterPayments,
} from "../database/supporters.schema";
import { identityKeys, lockKeys, otherFounder } from "../supporters/founder-rules";
import { patronLinkConflictSettled } from "../supporters/patron-link-conflict";
import type { PatronLinkConflictReason } from "../supporters/supporter-match.rules";
import { FOUNDER_PAYMENT_SOURCES, supportActive } from "../supporters/supporters.types";

export const PATRON_LINK_ACTOR = { id: "system:patron-link", name: "Linked by patron" } as const;
/** A refused sign-in for the same record, Discord account and reason is recorded once a day while staff have not settled it. */
export const PATRON_LINK_CONFLICT_REPEAT_MS = 24 * 3_600_000;
/** Enough recent payments to judge support, as the Supporter role reads them. */
const SUPPORT_PAYMENTS_READ = 10;

export type PatronLinkInput = {
  campaignId: string;
  /** The membership Patreon named for the patron who signed in. */
  patreonMemberId: string;
  /** The Discord account that asked for the link and signed in. */
  discordId: string;
  now: Date;
};
export type PatronLinkResult =
  | { outcome: "linked" | "pending" | "already"; memberId: string }
  | { outcome: "conflict"; conflict: PatronLinkConflictReason; memberId: string };

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type MemberRow = typeof supporterMembers.$inferSelect;

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uniqueViolation = (error: unknown) => {
  let cause: unknown = error;
  for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && cause.code === "23505") return true;
    cause = "cause" in cause ? cause.cause : null;
  }
  return false;
};

/**
 * Links a patron's Discord account to their Patreon membership after they signed in to both ("Link Patreon"). It
 * fills an empty link only: it never replaces one, never takes a Discord account another record of the campaign
 * holds, and never gives a founder a Discord account another founder holds. A refusal is recorded for staff instead.
 * The member row lock and the campaign's unique Discord index settle concurrent sign-ins.
 */
@Injectable()
export class PatronLinkStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Whether this Discord account is linked to a Patreon record of the campaign, by anyone. */
  async linked(campaignId: string, discordId: string) {
    const [row] = await this.db
      .select({ id: supporterMembers.id })
      .from(supporterMembers)
      .where(
        and(
          eq(supporterMembers.provider, "patreon"),
          eq(supporterMembers.campaignId, campaignId),
          eq(supporterMembers.discordId, discordId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async link(input: PatronLinkInput): Promise<PatronLinkResult> {
    try {
      return await this.db.transaction(async (tx): Promise<PatronLinkResult> => {
        const { member, created } = await this.member(tx, input);
        if (member.discordId === input.discordId) return { outcome: "already", memberId: member.id };
        const conflict = await this.conflict(tx, member, input);
        if (conflict) {
          await this.refuse(tx, member, input, conflict);
          return { outcome: "conflict", conflict, memberId: member.id };
        }
        const [updated] = await tx
          .update(supporterMembers)
          .set({ discordId: input.discordId, discordSource: "patron_signin", version: member.version + 1 })
          .where(and(eq(supporterMembers.id, member.id), isNull(supporterMembers.discordId)))
          .returning({ id: supporterMembers.id });
        // The row lock makes this unreachable; if it ever happens, nothing is reported as linked.
        if (!updated) throw new Error("The supporter record changed while it was locked.");
        await tx.insert(supporterActions).values({
          id: randomUUID(),
          memberId: member.id,
          actorId: PATRON_LINK_ACTOR.id,
          actorName: PATRON_LINK_ACTOR.name,
          kind: "patron-discord-link",
          reason: "The patron signed in to Discord and Patreon to link this membership.",
          fingerprint: sha256({ kind: "patron-discord-link", memberId: member.id, discordId: input.discordId }),
          details: {
            discordId: input.discordId,
            previousDiscordId: null,
            patreonMemberId: input.patreonMemberId,
            patreonDiscordId: member.patreonDiscordId,
            memberCreated: created ? 1 : 0,
          },
          createdAt: input.now,
        });
        return { outcome: (await this.active(tx, member, input.now)) ? "linked" : "pending", memberId: member.id };
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      // Another record of the campaign took this Discord account after the check above, and everything rolled back.
      // The refusal is recorded on its own.
      return this.db.transaction(async (tx): Promise<PatronLinkResult> => {
        const { member } = await this.member(tx, input);
        await this.refuse(tx, member, input, "discord_linked");
        return { outcome: "conflict", conflict: "discord_linked", memberId: member.id };
      });
    }
  }

  /** The membership's record, locked. A membership the import has not seen yet gets the import's minimal row. */
  private async member(tx: Transaction, input: PatronLinkInput): Promise<{ member: MemberRow; created: boolean }> {
    const [created] = await tx
      .insert(supporterMembers)
      .values({
        id: randomUUID(),
        campaignId: input.campaignId,
        patreonMemberId: input.patreonMemberId,
        observedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: supporterMembers.id });
    const [member] = await tx
      .select()
      .from(supporterMembers)
      .where(
        and(
          eq(supporterMembers.campaignId, input.campaignId),
          eq(supporterMembers.patreonMemberId, input.patreonMemberId),
        ),
      )
      .for("update");
    return { member, created: Boolean(created) };
  }

  private async conflict(
    tx: Transaction,
    member: MemberRow,
    input: PatronLinkInput,
  ): Promise<PatronLinkConflictReason | null> {
    if (member.discordId) return "membership_linked";
    // A PayPal record with this Discord account is the same person giving another way, so it does not block.
    const [holder] = await tx
      .select({ id: supporterMembers.id })
      .from(supporterMembers)
      .where(
        and(
          eq(supporterMembers.provider, "patreon"),
          eq(supporterMembers.campaignId, input.campaignId),
          eq(supporterMembers.discordId, input.discordId),
          ne(supporterMembers.id, member.id),
        ),
      )
      .limit(1);
    if (holder) return "discord_linked";
    // A founder record must not take a Discord account another founder holds, as a staff Link would refuse.
    const [founder] = await tx
      .select({ memberId: supporterFounders.memberId })
      .from(supporterFounders)
      .where(eq(supporterFounders.memberId, member.id));
    if (!founder) return null;
    const added = { id: member.id, discordId: input.discordId, steamId: null };
    await lockKeys(tx, identityKeys("founder", added));
    return (await otherFounder(tx, added)) ? "founder_tie" : null;
  }

  /** Records a refused sign-in for staff, unless the same refusal is already waiting from the last 24 hours. */
  private async refuse(tx: Transaction, member: MemberRow, input: PatronLinkInput, conflict: PatronLinkConflictReason) {
    const [waiting] = await tx
      .select({ id: supporterActions.id })
      .from(supporterActions)
      .where(
        and(
          eq(supporterActions.memberId, member.id),
          eq(supporterActions.kind, "patron-link-conflict"),
          sql`${supporterActions.details}->>'discordId' = ${input.discordId}`,
          sql`${supporterActions.details}->>'conflict' = ${conflict}`,
          gt(supporterActions.createdAt, new Date(input.now.getTime() - PATRON_LINK_CONFLICT_REPEAT_MS)),
          sql`NOT ${patronLinkConflictSettled(sql`${member.id}`, sql`${supporterActions.createdAt}`)}`,
        ),
      )
      .limit(1);
    if (waiting) return;
    await tx.insert(supporterActions).values({
      id: randomUUID(),
      memberId: member.id,
      actorId: PATRON_LINK_ACTOR.id,
      actorName: PATRON_LINK_ACTOR.name,
      kind: "patron-link-conflict",
      reason: "A patron sign-in matched this membership, but the link was refused.",
      fingerprint: sha256({ kind: "patron-link-conflict", memberId: member.id, discordId: input.discordId, conflict }),
      details: {
        discordId: input.discordId,
        conflict,
        linkedDiscordId: member.discordId,
        patreonMemberId: input.patreonMemberId,
      },
      createdAt: input.now,
    });
  }

  /** Whether the record supports right now, by the Supporter role's own rule. */
  private async active(tx: Transaction, member: MemberRow, now: Date) {
    const payments = await tx
      .select({
        source: supporterPayments.source,
        paidAt: supporterPayments.paidAt,
        amountCents: supporterPayments.amountCents,
        currency: supporterPayments.currency,
        minimumConfirmed: supporterPayments.minimumConfirmed,
      })
      .from(supporterPayments)
      .where(
        and(
          eq(supporterPayments.memberId, member.id),
          eq(supporterPayments.verificationState, "verified"),
          isNotNull(supporterPayments.amountCents),
          inArray(supporterPayments.source, [...FOUNDER_PAYMENT_SOURCES]),
        ),
      )
      .orderBy(desc(supporterPayments.paidAt), desc(supporterPayments.recordedAt))
      .limit(SUPPORT_PAYMENTS_READ);
    return supportActive(
      {
        provider: member.provider,
        patronStatus: member.patronStatus,
        lastChargeStatus: member.lastChargeStatus,
        lastChargeAt: member.lastChargeAt,
        payments,
      },
      now,
    );
  }
}
