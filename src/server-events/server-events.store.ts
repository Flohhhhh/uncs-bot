import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ne } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { DATABASE, type Database } from "../database/database.types";
import { serverEvents, serverEventOperations } from "../database/schema";
import type { Staff } from "../admin/admin.types";
import type { EventOperation, EventProgress, EventRecord, EventState, EventStop } from "./server-events.types";
type EventRow = typeof serverEvents.$inferSelect;
type Update = { state: EventState; progress: EventProgress; message: string; restoreRevision?: string | null };

@Injectable()
export class ServerEventsStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private async resolve(row: EventRow): Promise<EventRecord> {
    const [op] = row.operationId
      ? await this.db.select().from(serverEventOperations).where(eq(serverEventOperations.id, row.operationId))
      : [];
    if (row.operationId && (!op || op.eventId !== row.id))
      throw new Error("The current event operation is unavailable.");
    return { ...row, operation: op?.operation ?? null };
  }
  async get(id: string) {
    const [event] = await this.db.select().from(serverEvents).where(eq(serverEvents.id, id));
    return event ? this.resolve(event) : null;
  }
  async current(serverId: string) {
    const [event] = await this.db
      .select()
      .from(serverEvents)
      .where(and(eq(serverEvents.serverId, serverId), ne(serverEvents.state, "complete")));
    return event ? this.resolve(event) : null;
  }
  async history(serverId: string) {
    const events = await this.db
      .select()
      .from(serverEvents)
      .where(eq(serverEvents.serverId, serverId))
      .orderBy(desc(serverEvents.createdAt))
      .limit(20);
    return Promise.all(events.map((event) => this.resolve(event)));
  }
  async operations(id: string) {
    return this.db
      .select()
      .from(serverEventOperations)
      .where(eq(serverEventOperations.eventId, id))
      .orderBy(desc(serverEventOperations.createdAt))
      .limit(100);
  }
  async create(input: typeof serverEvents.$inferInsert) {
    const [created] = await this.db.insert(serverEvents).values(input).onConflictDoNothing().returning();
    if (created) return { created: true, event: await this.resolve(created) };
    const previous = await this.get(input.id);
    if (!previous || previous.actorId !== input.actorId || previous.requestHash !== input.requestHash)
      throw new ConflictException("Another event is active or this request ID was already used. Refresh the event.");
    return { created: false, event: previous };
  }
  async observe(id: string, version: number, update: Update) {
    return this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(serverEvents).where(eq(serverEvents.id, id)).for("update");
      if (!event || event.version !== version || event.operationId || event.state === "complete") return false;
      if (event.stop && !["stopping", "needs_review"].includes(update.state)) return false;
      await tx
        .update(serverEvents)
        .set({ ...update, version: event.version + 1, updatedAt: new Date() })
        .where(eq(serverEvents.id, id));
      return true;
    });
  }
  async claim(
    eventId: string,
    version: number,
    op: EventOperation,
    staff: Staff,
    progress: EventProgress,
    manual = false,
  ) {
    return this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(serverEvents).where(eq(serverEvents.id, eventId)).for("update");
      const [previous] = await tx.select().from(serverEventOperations).where(eq(serverEventOperations.id, op.id));
      if (previous) {
        if (previous.eventId !== eventId || previous.actorId !== staff.id || !isDeepStrictEqual(previous.operation, op))
          throw new ConflictException("This event action ID was already used for a different request.");
        return null;
      }
      if (!event || event.version !== version || event.state === "complete") return null;
      const restore = op.kind === "restore_lock";
      if (event.operationId && !(manual && event.state === "needs_review" && restore)) return null;
      if ((event.stop || event.state === "needs_review") && !restore) return null;
      await tx
        .insert(serverEventOperations)
        .values({ id: op.id, eventId, actorId: staff.id, actorName: staff.name, operation: op });
      const [claimed] = await tx
        .update(serverEvents)
        .set({
          operationId: op.id,
          progress,
          version: event.version + 1,
          updatedAt: new Date(),
          state: restore ? "stopping" : event.state,
        })
        .where(eq(serverEvents.id, eventId))
        .returning();
      return { ...claimed, operation: op } as EventRecord;
    });
  }
  async settle(id: string, opId: string, result: { state: string; message: string }, update: Update) {
    await this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(serverEvents).where(eq(serverEvents.id, id)).for("update");
      // Preserve the operation result even when a staff review superseded its event pointer.
      await tx
        .update(serverEventOperations)
        .set({ state: result.state, message: result.message, completedAt: new Date() })
        .where(and(eq(serverEventOperations.id, opId), eq(serverEventOperations.state, "started")));
      if (!event || event.operationId !== opId || event.state === "needs_review") return;
      await tx
        .update(serverEvents)
        .set({
          ...update,
          state: event.stop && !["complete", "needs_review"].includes(update.state) ? "stopping" : update.state,
          operationId: null,
          lastActionId: opId,
          version: event.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(serverEvents.id, id));
    });
    return this.get(id);
  }
  async stop(id: string, stop: EventStop) {
    await this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(serverEvents).where(eq(serverEvents.id, id)).for("update");
      if (!event) throw new ConflictException("This event is unavailable.");
      if (event.stop?.id === stop.id && (event.stop.actorId !== stop.actorId || event.stop.reason !== stop.reason))
        throw new ConflictException("This stop ID was already used for a different request.");
      if (event.stop || event.state === "complete") return;
      await tx
        .update(serverEvents)
        .set({
          stop,
          state: event.operationId || event.state === "needs_review" ? event.state : "stopping",
          message: "Stop recorded. No new player actions will be started. Settings restoration is still to be checked.",
          version: event.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(serverEvents.id, id));
    });
    return (await this.get(id))!;
  }
  async completeUnchanged(id: string, version: number) {
    await this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(serverEvents).where(eq(serverEvents.id, id)).for("update");
      if (!event || event.version !== version || event.operationId || event.originalLock || !event.stop) return;
      await tx
        .update(serverEvents)
        .set({
          state: "complete",
          message: "Event stopped. The team-lock setting was already off before this event; no restoration was needed.",
          version: event.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(serverEvents.id, id));
    });
    return this.get(id);
  }
  async recover(event: EventRecord, now: Date) {
    if (!event.operation || now.getTime() - event.updatedAt.getTime() < 120_000) return;
    await this.db
      .update(serverEvents)
      .set({
        state: "needs_review",
        message:
          "An event action was interrupted. Inspect its receipt and stop the affected instance before restoring settings. It will not be replayed.",
        version: event.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(serverEvents.id, event.id),
          eq(serverEvents.version, event.version),
          ne(serverEvents.state, "needs_review"),
        ),
      );
  }
}
