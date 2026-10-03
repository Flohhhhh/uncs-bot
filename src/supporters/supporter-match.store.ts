import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { DATABASE, type Database } from "../database/database.types";
import { supporterActions, supporterFounders, supporterMembers } from "../database/supporters.schema";
import {
  type Executor,
  founderCheck,
  identityKeys,
  lockKeys,
  matchFactsSql,
  otherFounder,
  supporterSteamKeys,
} from "./founder-rules";
import {
  applicationSteamMatch,
  AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
  AUTO_FOUNDER_REASON,
  automaticFounderBlocker,
  SUPPORTER_MATCH_ACTOR,
  type AutomaticFounderBlockedReason,
  type MatchFacts,
} from "./supporter-match.rules";
import type { FounderPolicy } from "./supporters.types";

export type AutoMatchOptions = {
  campaignId: string;
  policy: FounderPolicy;
  /** Copy an empty SteamID from the approved application. */
  fillSteam: boolean;
  /** Record a founder promise when the automatic rule and the staff rule both allow it. */
  recordFounder: boolean;
  now: Date;
};
export type AutoMatchResult = {
  memberId: string;
  /** The record's Discord account, for the Founder role check. */
  discordId: string | null;
  /** The record is not a Patreon record of the configured campaign, so nothing was read or written. */
  skipped: boolean;
  steamFilled: boolean;
  founderRecorded: boolean;
  /** Why a step that was asked for did not write anything. */
  blocked: AutomaticFounderBlockedReason[];
};

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Automatic supporter matching's database work. Every write is conditional on the state it changes, made under the
 * member's row lock, and audited in the same transaction, so a repeated run writes nothing. Lock order: the member
 * row, then that Discord account's applications (FOR SHARE), then the SteamID being copied, then the sorted founder
 * advisory locks, the same order staff links and founder awards use.
 */
@Injectable()
export class SupporterMatchStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async facts(tx: Executor, memberId: string, campaignId: string) {
    const result = await tx.execute<{ facts: MatchFacts }>(
      sql`SELECT ${matchFactsSql(campaignId)} AS facts FROM supporter_members m WHERE m.id = ${memberId}`,
    );
    const facts = result.rows[0]?.facts;
    return {
      applications: facts?.applications ?? [],
      automatic: facts?.automatic ?? null,
      discordReportedForOtherPatron: Boolean(facts?.discordReportedForOtherPatron),
      patreonDiscordElsewhere: Boolean(facts?.patreonDiscordElsewhere),
      linkedSteamShared: Boolean(facts?.linkedSteamShared),
    } satisfies MatchFacts;
  }

  /** Another supporter record (any PayPal record, or a Patreon record of the campaign) holds this SteamID. */
  private async otherHolder(tx: Executor, memberId: string, steamId: string, campaignId: string) {
    const [holder] = await tx
      .select({ id: supporterMembers.id })
      .from(supporterMembers)
      .where(
        and(
          ne(supporterMembers.id, memberId),
          eq(supporterMembers.steamId, steamId),
          or(
            eq(supporterMembers.provider, "paypal"),
            and(eq(supporterMembers.provider, "patreon"), eq(supporterMembers.campaignId, campaignId)),
          ),
        ),
      )
      .limit(1);
    return Boolean(holder);
  }

  async autoMatch(memberId: string, options: AutoMatchOptions): Promise<AutoMatchResult> {
    return this.db.transaction(async (tx) => {
      const [member] = await tx.select().from(supporterMembers).where(eq(supporterMembers.id, memberId)).for("update");
      const result: AutoMatchResult = {
        memberId,
        discordId: member?.discordId ?? null,
        skipped: false,
        steamFilled: false,
        founderRecorded: false,
        blocked: [],
      };
      if (!member || member.provider !== "patreon" || member.campaignId !== options.campaignId)
        return { ...result, skipped: true };
      if (!member.discordId) return { ...result, blocked: ["no_discord"] };
      // An approval or revocation of this Discord account's applications waits for this transaction, and one already
      // claimed shows as in progress, so a SteamID is never copied from an application that is being revoked.
      await tx.execute(
        sql`SELECT id FROM whitelist_applications WHERE discord_user_id = ${member.discordId} ORDER BY id FOR SHARE`,
      );
      let facts = await this.facts(tx, memberId, options.campaignId);
      const [founder] = await tx
        .select({ memberId: supporterFounders.memberId })
        .from(supporterFounders)
        .where(eq(supporterFounders.memberId, memberId));
      const actions: (typeof supporterActions.$inferInsert)[] = [];
      let current = member;
      if (!member.steamId && options.fillSteam) {
        const steam = applicationSteamMatch(facts.applications);
        const application = facts.applications.find((item) => item.id === steam.applicationId);
        let refused: AutomaticFounderBlockedReason | null = steam.reason;
        // The facts were read before any lock on the SteamID. A staff Link or PayPal record of it takes the same lock,
        // so once it is held, every committed holder is visible here.
        if (!refused) {
          await lockKeys(tx, supporterSteamKeys(steam.steamId));
          if (await this.otherHolder(tx, memberId, steam.steamId!, options.campaignId))
            refused = "steam_on_another_record";
        }
        // A founder's new SteamID must not be one another founder already holds.
        if (!refused && founder) {
          const added = { id: memberId, discordId: null, steamId: steam.steamId };
          await lockKeys(tx, identityKeys("founder", added));
          if (await otherFounder(tx, added)) refused = "already_founder";
        }
        if (refused) result.blocked.push(refused);
        else {
          const [filled] = await tx
            .update(supporterMembers)
            .set({ steamId: steam.steamId, steamSource: "application", steamApplicationId: steam.applicationId })
            .where(and(eq(supporterMembers.id, memberId), isNull(supporterMembers.steamId)))
            .returning();
          if (filled) {
            current = filled;
            result.steamFilled = true;
            actions.push({
              id: randomUUID(),
              memberId,
              actorId: SUPPORTER_MATCH_ACTOR.id,
              actorName: SUPPORTER_MATCH_ACTOR.name,
              kind: "application-steam-link",
              reason: "Copied the SteamID from the same Discord account's approved whitelist application.",
              fingerprint: sha256({
                kind: "application-steam-link",
                memberId,
                steamId: steam.steamId,
                applicationId: steam.applicationId,
              }),
              details: {
                steamId: steam.steamId,
                applicationId: steam.applicationId,
                applicationServerId: steam.serverId,
                discordId: member.discordId,
                discordSource: member.discordSource,
                whitelistGrant: application?.whitelistGrant ?? null,
                previousSteamId: null,
              },
              createdAt: options.now,
            });
            // The founder check below reads the facts for the record as it is now.
            facts = await this.facts(tx, memberId, options.campaignId);
          }
        }
      }
      if (options.recordFounder && !founder) {
        const reason = automaticFounderBlocker(current, facts, {
          now: options.now,
          holdHours: options.policy.automaticHoldHours ?? AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
        });
        if (reason) result.blocked.push(reason);
        else {
          const payment = facts.automatic!.payment;
          // The identity after any SteamID fill, so the steam lock and the cross-record check cover the new SteamID.
          const identity = { id: memberId, discordId: current.discordId, steamId: current.steamId };
          await lockKeys(tx, identityKeys("founder", identity));
          const staffRule = await founderCheck(tx, identity, payment, options.policy);
          if (staffRule) result.blocked.push(staffRule);
          else {
            await tx.insert(supporterFounders).values({
              memberId,
              paymentId: payment.id,
              awardedAt: options.now,
              awardedBy: SUPPORTER_MATCH_ACTOR.id,
              reason: AUTO_FOUNDER_REASON,
              windowStart: new Date(options.policy.startsAt!),
              windowEnd: new Date(options.policy.endsAt!),
            });
            result.founderRecorded = true;
            actions.push({
              id: randomUUID(),
              memberId,
              actorId: SUPPORTER_MATCH_ACTOR.id,
              actorName: SUPPORTER_MATCH_ACTOR.name,
              kind: "founder",
              reason: AUTO_FOUNDER_REASON,
              fingerprint: sha256({ kind: "automatic-founder", memberId, paymentId: payment.id }),
              details: {
                paymentId: payment.id,
                paymentSource: payment.source,
                reference: payment.reference,
                windowStart: options.policy.startsAt,
                windowEnd: options.policy.endsAt,
                discordId: current.discordId,
                steamId: current.steamId,
                discordSource: current.discordSource,
                steamSource: current.steamSource,
                automatic: 1,
              },
              createdAt: options.now,
            });
          }
        }
      }
      if (actions.length) {
        await tx
          .update(supporterMembers)
          .set({ version: member.version + 1 })
          .where(eq(supporterMembers.id, memberId));
        for (const action of actions) await tx.insert(supporterActions).values(action);
      }
      return result;
    });
  }

  /**
   * Patreon records of the campaign with a Discord account that automation could still change: an empty SteamID with
   * an approved application, or no founder promise and a verified first imported payment inside the window. Ordered by
   * ID from just after `after`, wrapping around, so a capped sweep continues where the last one stopped.
   */
  async candidates(
    campaignId: string,
    policy: FounderPolicy,
    steps: { fillSteam: boolean; recordFounder: boolean },
    after: string | null,
    limit: number,
  ) {
    const wanted = [
      steps.fillSteam
        ? sql`(m.steam_id IS NULL AND EXISTS (SELECT 1 FROM whitelist_applications a
            WHERE a.discord_user_id = m.discord_id AND a.status = 'approved'))`
        : undefined,
      steps.recordFounder && policy.configured
        ? sql`(NOT EXISTS (SELECT 1 FROM supporter_founders f WHERE f.member_id = m.id)
            AND EXISTS (SELECT 1 FROM supporter_payments p WHERE p.member_id = m.id AND p.source = 'patreon_api'
              AND p.verification_state = 'verified' AND p.first_successful_payment_verified
              AND p.paid_at >= ${policy.startsAt}::timestamptz AND p.paid_at < ${policy.endsAt}::timestamptz))`
        : undefined,
    ].filter((condition) => condition !== undefined);
    if (!wanted.length || limit < 1) return [];
    const page = async (range: ReturnType<typeof sql>, count: number) =>
      (
        await this.db.execute<{ id: string }>(sql`SELECT m.id FROM supporter_members m
          WHERE m.provider = 'patreon' AND m.campaign_id = ${campaignId} AND m.discord_id IS NOT NULL
          AND (${sql.join(wanted, sql` OR `)}) ${range}
          ORDER BY m.id LIMIT ${count}`)
      ).rows.map((row) => row.id);
    const first = await page(after ? sql`AND m.id > ${after}` : sql``, limit);
    if (!after || first.length >= limit) return first;
    return [...first, ...(await page(sql`AND m.id <= ${after}`, limit - first.length))];
  }

  /** The campaign's Patreon records linked to this Discord account (at most one, by the unique index). */
  async patreonMembersForDiscord(campaignId: string, discordId: string) {
    const rows = await this.db
      .select({ id: supporterMembers.id })
      .from(supporterMembers)
      .where(
        and(
          eq(supporterMembers.provider, "patreon"),
          eq(supporterMembers.campaignId, campaignId),
          eq(supporterMembers.discordId, discordId),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Labels links made before sources were recorded. A Patreon record's Discord account is a Patreon link when the
   * latest action that set the current account was the import's patreon-discord-link; a staff Link counts only when it
   * changed the Discord account (older dashboards resent it unchanged). Everything else is a staff link, and every
   * unlabelled SteamID was entered by staff. Only unlabelled rows change, so it is safe to repeat; the version is not
   * bumped and no audit row is written, because no link changes.
   */
  async backfillSources() {
    const discord = await this.db.execute(sql`UPDATE supporter_members m SET discord_source = CASE
        WHEN m.provider = 'patreon' AND (SELECT a.kind FROM supporter_actions a
          WHERE a.member_id = m.id AND a.details->>'discordId' = m.discord_id
            AND (a.kind IN ('patreon-discord-link', 'paypal-payment')
              OR (a.kind = 'link' AND a.details->>'previousDiscordId' IS DISTINCT FROM a.details->>'discordId'))
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1) = 'patreon-discord-link' THEN 'patreon'
        ELSE 'staff' END
      WHERE m.discord_id IS NOT NULL AND m.discord_source IS NULL`);
    const steam = await this.db.execute(sql`UPDATE supporter_members SET steam_source = 'staff'
      WHERE steam_id IS NOT NULL AND steam_source IS NULL`);
    return { discord: discord.rowCount ?? 0, steam: steam.rowCount ?? 0 };
  }
}
