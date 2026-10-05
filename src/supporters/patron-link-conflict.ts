import { sql, type SQL } from "drizzle-orm";

/**
 * The actions that settle a refused patron sign-in ("Link Patreon") on the same record: a staff link, a staff "Keep
 * accounts" review, the patron's own link, and the import linking an account to the record or moving its account to
 * another record.
 */
export const PATRON_LINK_CONFLICT_SETTLED_BY = [
  "link",
  "review",
  "patron-discord-link",
  "patreon-discord-link",
  "patreon-discord-moved",
] as const;

/**
 * SQL: an action on record `memberId` after `refusedAt` settled a refused patron sign-in. The Supporters page and the
 * once-a-day refusal record share it, so a sign-in refused again after a settled refusal is recorded at once.
 */
export function patronLinkConflictSettled(memberId: SQL, refusedAt: SQL) {
  const kinds = sql.raw(PATRON_LINK_CONFLICT_SETTLED_BY.map((kind) => `'${kind}'`).join(", "));
  return sql`EXISTS (SELECT 1 FROM supporter_actions settled WHERE settled.member_id = ${memberId}
            AND settled.kind IN (${kinds}) AND settled.created_at > ${refusedAt})`;
}

/**
 * SQL: refusal `latest` (its `discord_id` and `conflict`) still holds for record `m`, judged as the sign-in judged it
 * (PatronLinkStore). `membership_linked`: the record still links another account. `discord_linked`: the record still
 * has none, and another Patreon record of the campaign still links the account. `founder_tie`: the record still has
 * none, and another founder still holds the account. A refusal that no longer holds leaves the page by itself, and the
 * patron can sign in again.
 */
export const patronLinkConflictHolds = sql.raw(`CASE latest.conflict
            WHEN 'membership_linked' THEN m.discord_id IS NOT NULL AND m.discord_id <> latest.discord_id
            WHEN 'discord_linked' THEN m.discord_id IS NULL AND EXISTS (SELECT 1 FROM supporter_members holder
              WHERE holder.provider = 'patreon' AND holder.campaign_id = m.campaign_id AND holder.id <> m.id
              AND holder.discord_id = latest.discord_id)
            WHEN 'founder_tie' THEN m.discord_id IS NULL AND EXISTS (SELECT 1 FROM supporter_founders tie
              JOIN supporter_members tie_member ON tie_member.id = tie.member_id
              WHERE tie_member.id <> m.id AND tie_member.discord_id = latest.discord_id)
            ELSE true END`);
