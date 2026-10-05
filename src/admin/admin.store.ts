import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  like,
  lt,
  ne,
  not,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { adminActions, adminSessions } from "../database/schema";
import type { ActionResult, AdminAction, Staff } from "./admin.types";
import { LEGACY_SERVER_ID } from "../common/game-server";

/** Audit actor for automatic welcome and round messages. */
export const COMMUNITY_MESSAGES_ACTOR_ID = "system:server-community";

// Existing deployment records predate server selection and belong to its original server.
const actionServer = sql<string>`coalesce(${adminActions.details}->>'serverId', ${LEGACY_SERVER_ID})`;
// An acknowledged automatic message is a delivery receipt, not activity for staff to review.
// Failed, unknown and unfinished deliveries remain notable.
const routineDelivery = and(
  eq(adminActions.actorId, COMMUNITY_MESSAGES_ACTOR_ID),
  inArray(adminActions.action, ["message", "broadcast"]),
  inArray(adminActions.state, ["accepted", "applied"]),
)!;

/** Kicks and bans that count toward a player's record: every one the game did not refuse. */
const counted = and(inArray(adminActions.action, ["kick", "ban"]), ne(adminActions.state, "failed"))!;
/** The value from the group's newest row, among the rows that match `filter` when one is given. */
const newest = <T>(value: SQLWrapper, filter?: SQL) =>
  sql<T>`(array_agg(${value} order by ${adminActions.createdAt} desc)${filter ? sql` filter (where ${filter})` : sql``})[1]`;
const lastAt = sql<Date>`max(${adminActions.createdAt})`.mapWith(adminActions.createdAt);
// Kicks and bans keep the player's name from the roster at the time; older records have none.
const playerName = sql`${adminActions.details}->>'playerName'`;
const recordFields = (since: Date) => ({
  steamId: adminActions.target,
  action: adminActions.action,
  count: count(),
  recent: sql<number>`count(*) filter (where ${gte(adminActions.createdAt, since)})`.mapWith(Number),
  lastAt,
  lastBy: newest<string>(adminActions.actorName),
  lastReason: newest<string | null>(sql`${adminActions.details}->>'reason'`),
  name: newest<string | null>(playerName, isNotNull(playerName)),
});
/** One kind of action against one player: how many, how many since the asked date, and the newest one. */
export type ModerationCount = {
  count: number;
  recent: number;
  lastAt: Date;
  lastBy: string;
  lastReason: string | null;
};
export type ModerationSummary = { name: string | null; kicks: ModerationCount | null; bans: ModerationCount | null };
const moderationCount = (row: ModerationCount): ModerationCount => ({
  count: row.count,
  recent: row.recent,
  lastAt: row.lastAt,
  lastBy: row.lastBy,
  lastReason: row.lastReason,
});

const auditFields = {
  id: adminActions.id,
  actorName: adminActions.actorName,
  action: adminActions.action,
  target: adminActions.target,
  details: adminActions.details,
  state: adminActions.state,
  message: adminActions.message,
  createdAt: adminActions.createdAt,
};

@Injectable()
export class AdminStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async session(tokenHash: string) {
    const [session] = await this.db
      .select()
      .from(adminSessions)
      .where(and(eq(adminSessions.tokenHash, tokenHash), gt(adminSessions.expiresAt, new Date())));
    return session;
  }

  async createSession(session: typeof adminSessions.$inferInsert) {
    await this.db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
    await this.db.insert(adminSessions).values(session);
  }

  async deleteSession(tokenHash: string) {
    await this.db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
  }

  /** `playerName` is the target's name from the roster, kept with a kick or ban for its record. */
  async begin(staff: Staff, action: AdminAction, requestHash: string, playerName?: string) {
    const inserted = await this.db
      .insert(adminActions)
      .values({
        id: action.id,
        actorId: staff.id,
        actorName: staff.name,
        action: action.action,
        target: "steamId" in action ? action.steamId : "server",
        requestHash,
        details: playerName ? { ...action, playerName } : action,
      })
      .onConflictDoNothing()
      .returning();
    const [record] = inserted.length
      ? inserted
      : await this.db.select().from(adminActions).where(eq(adminActions.id, action.id));
    return { created: inserted.length > 0, record };
  }

  async finish(id: string, result: ActionResult) {
    await this.db
      .update(adminActions)
      .set({ state: result.state, message: result.message, completedAt: new Date() })
      .where(eq(adminActions.id, id));
  }

  /** Newest 100 receipts. `notable` excludes routine deliveries before the limit so they cannot crowd out others. */
  async history(serverId = LEGACY_SERVER_ID, { notable = false } = {}) {
    return this.db
      .select(auditFields)
      .from(adminActions)
      .where(and(eq(actionServer, serverId), notable ? not(routineDelivery) : undefined))
      .orderBy(desc(adminActions.createdAt))
      .limit(100);
  }

  /**
   * Whether a person (not a `system:*` actor) sent a map-next for this server at or after `since` that the
   * game did not refuse. Started and unconfirmed queues count: they may still change the next map.
   */
  async staffQueuedSince(serverId: string, since: Date) {
    const [found] = await this.db
      .select({ id: adminActions.id })
      .from(adminActions)
      .where(
        and(
          eq(adminActions.action, "map-next"),
          eq(actionServer, serverId),
          gte(adminActions.createdAt, since),
          not(like(adminActions.actorId, "system:%")),
          ne(adminActions.state, "failed"),
        ),
      )
      .limit(1);
    return !!found;
  }

  async receipt(id: string, serverId = LEGACY_SERVER_ID) {
    const [record] = await this.db
      .select(auditFields)
      .from(adminActions)
      .where(and(eq(adminActions.id, id), eq(actionServer, serverId)))
      .limit(1);
    return record ?? null;
  }

  /**
   * Kicks and bans recorded for these players on the server, in one query. Failed ones are not counted.
   * `recent` counts those at or after `since`. Players with neither are left out.
   */
  async moderationSummaries(serverId: string, steamIds: readonly string[], since = new Date(0)) {
    const summaries = new Map<string, ModerationSummary>();
    if (!steamIds.length) return summaries;
    const rows = await this.db
      .select(recordFields(since))
      .from(adminActions)
      .where(and(eq(actionServer, serverId), inArray(adminActions.target, [...steamIds]), counted))
      .groupBy(adminActions.target, adminActions.action)
      .orderBy(desc(lastAt));
    for (const row of rows) {
      const summary = summaries.get(row.steamId) ?? { name: null, kicks: null, bans: null };
      summary.name ??= row.name;
      if (row.action === "kick") summary.kicks = moderationCount(row);
      else summary.bans = moderationCount(row);
      summaries.set(row.steamId, summary);
    }
    return summaries;
  }

  /** One player's newest kicks and bans on the server, failed ones left out. */
  async moderationEntries(serverId: string, steamId: string, limit = 10) {
    return this.db
      .select(auditFields)
      .from(adminActions)
      .where(and(eq(actionServer, serverId), eq(adminActions.target, steamId), counted))
      .orderBy(desc(adminActions.createdAt))
      .limit(limit);
  }

  /** Players kicked at least `minimum` times on the server since `since`, most kicks first (at most 50). */
  async repeatOffenders(serverId: string, since: Date, minimum = 2) {
    const rows = await this.db
      .select(recordFields(since))
      .from(adminActions)
      .where(
        and(eq(actionServer, serverId), eq(adminActions.action, "kick"), counted, gte(adminActions.createdAt, since)),
      )
      .groupBy(adminActions.target, adminActions.action)
      .having(sql`count(*) >= ${minimum}`)
      .orderBy(desc(count()), desc(lastAt))
      .limit(50);
    return rows.map((row) => ({ steamId: row.steamId, name: row.name, kicks: moderationCount(row) }));
  }
}
