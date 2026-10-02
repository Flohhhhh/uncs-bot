import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DATABASE, type Database } from "../database/database.types";
import {
  discordRoleActions,
  type DiscordRoleActionState,
  type DiscordRoleKind,
  type DiscordRoleOperation,
  type DiscordRoleTrigger,
} from "../database/discord-roles.schema";
import { ROLES_ACTOR_ID, ROLES_ACTOR_NAME, type LedgerEntry } from "./discord-roles.types";

export type RoleActionStart = {
  trigger: DiscordRoleTrigger;
  requestedBy: string | null;
  guildId: string;
  discordUserId: string;
  roleKind: DiscordRoleKind;
  roleId: string;
  operation: DiscordRoleOperation;
  basisType: "application" | "founder";
  basisId: string;
};

/**
 * Reads application and supporter records directly so this module imports neither feature module,
 * and keeps the role ledger. Role actions are deliberately kept out of the per-server game history.
 */
@Injectable()
export class DiscordRolesStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private only(column: SQL, users?: string[]) {
    return users
      ? sql`AND ${column} IN (${sql.join(
          users.map((user) => sql`${user}`),
          sql`, `,
        )})`
      : sql``;
  }

  private map(rows: { userId: string; basisId: string }[]) {
    return new Map(rows.map((row) => [row.userId, row.basisId]));
  }

  /** Who should hold each role, with the record that justifies it, across all servers and providers. */
  async desired(users?: string[]): Promise<Record<DiscordRoleKind, Map<string, string>>> {
    if (users && users.length === 0) return { member: new Map(), founder: new Map() };
    const [member, founder] = await Promise.all([
      this.db.execute<{ userId: string; basisId: string }>(sql`
        SELECT discord_user_id AS "userId",
          (array_agg(id::text ORDER BY reviewed_at ASC NULLS LAST, id))[1] AS "basisId"
        FROM whitelist_applications
        WHERE status = 'approved' AND relationship = 'unc_member' ${this.only(sql`discord_user_id`, users)}
        GROUP BY discord_user_id`),
      this.db.execute<{ userId: string; basisId: string }>(sql`
        SELECT m.discord_id AS "userId", (array_agg(m.id::text ORDER BY f.awarded_at, m.id))[1] AS "basisId"
        FROM supporter_founders f JOIN supporter_members m ON m.id = f.member_id
        WHERE m.discord_id IS NOT NULL ${this.only(sql`m.discord_id`, users)}
        GROUP BY m.discord_id`),
    ]);
    return { member: this.map(member.rows), founder: this.map(founder.rows) };
  }

  /** People with a revoked UNC application and no approved UNC application left on any server. */
  async revokedBasis(users?: string[]) {
    if (users && users.length === 0) return new Map<string, string>();
    const result = await this.db.execute<{ userId: string; basisId: string }>(sql`
      SELECT revoked.discord_user_id AS "userId",
        (array_agg(revoked.id::text ORDER BY revoked.revoked_at DESC NULLS LAST, revoked.id))[1] AS "basisId"
      FROM whitelist_applications revoked
      WHERE revoked.status = 'revoked' AND revoked.relationship = 'unc_member'
        AND NOT EXISTS (SELECT 1 FROM whitelist_applications approved
          WHERE approved.discord_user_id = revoked.discord_user_id
            AND approved.status = 'approved' AND approved.relationship = 'unc_member')
        ${this.only(sql`revoked.discord_user_id`, users)}
      GROUP BY revoked.discord_user_id`);
    return this.map(result.rows);
  }

  async foundersWithoutDiscord(limit = 100) {
    const result = await this.db.execute<{
      supporterId: string;
      displayName: string | null;
      provider: string;
      awardedAt: string;
    }>(sql`
      SELECT m.id AS "supporterId", m.display_name AS "displayName", m.provider, f.awarded_at AS "awardedAt"
      FROM supporter_founders f JOIN supporter_members m ON m.id = f.member_id
      WHERE m.discord_id IS NULL ORDER BY f.awarded_at, m.id LIMIT ${limit}`);
    return result.rows;
  }

  async summary() {
    const result = await this.db.execute<{ memberEligible: number; founders: number; foundersWithoutDiscord: number }>(
      sql`SELECT
        (SELECT count(DISTINCT discord_user_id)::int FROM whitelist_applications
          WHERE status = 'approved' AND relationship = 'unc_member') AS "memberEligible",
        (SELECT count(*)::int FROM supporter_founders) AS "founders",
        (SELECT count(*)::int FROM supporter_founders f JOIN supporter_members m ON m.id = f.member_id
          WHERE m.discord_id IS NULL) AS "foundersWithoutDiscord"`,
    );
    return result.rows[0] ?? { memberEligible: 0, founders: 0, foundersWithoutDiscord: 0 };
  }

  /** The newest applied, unknown or unfinished row. A "started" row is an unknown result. */
  async lastEffective(guildId: string, discordUserId: string, roleKind: DiscordRoleKind): Promise<LedgerEntry | null> {
    const [row] = await this.db
      .select({
        id: discordRoleActions.id,
        operation: discordRoleActions.operation,
        state: discordRoleActions.state,
        changed: discordRoleActions.changed,
        createdAt: discordRoleActions.createdAt,
      })
      .from(discordRoleActions)
      .where(
        and(
          eq(discordRoleActions.guildId, guildId),
          eq(discordRoleActions.discordUserId, discordUserId),
          eq(discordRoleActions.roleKind, roleKind),
          inArray(discordRoleActions.state, ["applied", "unknown", "started"]),
        ),
      )
      .orderBy(desc(discordRoleActions.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Written and committed before Discord is contacted. */
  async begin(input: RoleActionStart) {
    const [row] = await this.db
      .insert(discordRoleActions)
      .values({ id: randomUUID(), actorId: ROLES_ACTOR_ID, actorName: ROLES_ACTOR_NAME, ...input })
      .returning({ id: discordRoleActions.id });
    return row.id;
  }

  /** A role that was already present: recorded as Gramps did not add it, so it is never removed automatically. */
  async note(input: Omit<RoleActionStart, "operation">) {
    await this.db.insert(discordRoleActions).values({
      id: randomUUID(),
      actorId: ROLES_ACTOR_ID,
      actorName: ROLES_ACTOR_NAME,
      ...input,
      operation: "note",
      changed: false,
      state: "applied",
      message: "The role was already present. Gramps did not add it and will not remove it.",
      completedAt: new Date(),
    });
  }

  async finish(id: string, state: Exclude<DiscordRoleActionState, "started">, changed: boolean, message: string) {
    await this.db
      .update(discordRoleActions)
      .set({ state, changed, message, completedAt: new Date() })
      .where(eq(discordRoleActions.id, id));
  }

  /** The role is present after an unknown add: record that the add took effect. */
  async confirm(id: string) {
    await this.db
      .update(discordRoleActions)
      .set({
        state: "applied",
        changed: true,
        message: "Confirmed later: the role is present after an unconfirmed add.",
        completedAt: new Date(),
      })
      .where(and(eq(discordRoleActions.id, id), inArray(discordRoleActions.state, ["unknown", "started"])));
  }

  async recent(limit = 25) {
    return this.db.select().from(discordRoleActions).orderBy(desc(discordRoleActions.createdAt)).limit(limit);
  }
}
