import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { adminActions, adminSessions } from "../database/schema";
import type { ActionResult, AdminAction, Staff } from "./admin.types";

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
      .set({ ...result, completedAt: new Date() })
      .where(eq(adminActions.id, id));
  }

  async history() {
    return this.db
      .select({
        id: adminActions.id,
        actorName: adminActions.actorName,
        action: adminActions.action,
        target: adminActions.target,
        details: adminActions.details,
        state: adminActions.state,
        message: adminActions.message,
        createdAt: adminActions.createdAt,
      })
      .from(adminActions)
      .orderBy(desc(adminActions.createdAt))
      .limit(100);
  }
}
