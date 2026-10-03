import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, like, lt, ne, not, sql } from "drizzle-orm";
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

  async begin(staff: Staff, action: AdminAction, requestHash: string) {
    const inserted = await this.db
      .insert(adminActions)
      .values({
        id: action.id,
        actorId: staff.id,
        actorName: staff.name,
        action: action.action,
        target: "steamId" in action ? action.steamId : "server",
        requestHash,
        details: action,
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
}
