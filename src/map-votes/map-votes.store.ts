import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { mapVoteBallots, mapVotes } from "../database/schema";
import { ballotWinner, type MapVoteRecord } from "./map-votes.types";
import type { Staff } from "../admin/admin.types";

@Injectable()
export class MapVotesStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async get(id: string) {
    const [vote] = await this.db.select().from(mapVotes).where(eq(mapVotes.id, id));
    return vote ?? null;
  }
  history(serverId: string) {
    return this.db
      .select()
      .from(mapVotes)
      .where(eq(mapVotes.serverId, serverId))
      .orderBy(desc(mapVotes.createdAt), desc(mapVotes.id))
      .limit(20);
  }
  async liveCounts(ids: string[]) {
    if (!ids.length) return [];
    return this.db
      .select({ voteId: mapVoteBallots.voteId, choice: mapVoteBallots.choice, total: sql<number>`count(*)::int` })
      .from(mapVoteBallots)
      .where(inArray(mapVoteBallots.voteId, ids))
      .groupBy(mapVoteBallots.voteId, mapVoteBallots.choice);
  }
  async create(input: typeof mapVotes.$inferInsert, expectedLatestId?: string | null) {
    const [created] = await this.db.transaction(async (tx) => {
      // Staff and automatic ballots share the lock, including ballots closed by another worker.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"map-vote:" + input.serverId}))`);
      if (expectedLatestId !== undefined) {
        const [latest] = await tx
          .select({ id: mapVotes.id })
          .from(mapVotes)
          .where(eq(mapVotes.serverId, input.serverId))
          .orderBy(desc(mapVotes.createdAt), desc(mapVotes.id))
          .limit(1);
        if ((latest?.id ?? null) !== expectedLatestId)
          throw new ConflictException("Another ballot was recorded. Refresh before opening a vote.");
      }
      return tx.insert(mapVotes).values(input).onConflictDoNothing().returning();
    });
    if (created) return { created: true, record: created };
    const existing = await this.get(input.id);
    if (!existing || existing.actorId !== input.actorId || existing.requestHash !== input.requestHash)
      throw new ConflictException(
        "Another ballot is active, or this request ID has already been used. Refresh the votes.",
      );
    return { created: false, record: existing };
  }
  async published(id: string, messageId: string) {
    const [vote] = await this.db
      .update(mapVotes)
      .set({ state: "open", messageId, updatedAt: new Date(), message: "Voting is open." })
      .where(and(eq(mapVotes.id, id), eq(mapVotes.state, "publishing")))
      .returning();
    return vote ?? null;
  }
  async cast(id: string, userId: string, choice: number, guildId: string, channelId: string, messageId: string) {
    return this.db.transaction(async (tx) => {
      // Closing and voting lock the same ballot: a vote is either counted or explicitly refused.
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (
        !vote ||
        vote.guildId !== guildId ||
        vote.channelId !== channelId ||
        vote.messageId !== messageId ||
        vote.state !== "open" ||
        vote.closesAt.getTime() <= Date.now() ||
        choice < 0 ||
        choice >= vote.choices.length
      )
        throw new ConflictException(
          "This ballot is closed or unavailable. Use the latest ballot in the community channel.",
        );
      await tx
        .insert(mapVoteBallots)
        .values({ voteId: id, discordUserId: userId, choice })
        .onConflictDoUpdate({
          target: [mapVoteBallots.voteId, mapVoteBallots.discordUserId],
          set: { choice, updatedAt: new Date() },
        });
      return vote.choices[choice];
    });
  }
  due(now: Date) {
    return this.db
      .select()
      .from(mapVotes)
      .where(and(eq(mapVotes.state, "open"), lte(mapVotes.closesAt, now)))
      .limit(10);
  }
  async claimClose(id: string) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (!vote || vote.state !== "open" || vote.closesAt.getTime() > Date.now()) return null;
      const totals = await tx
        .select({ choice: mapVoteBallots.choice, total: sql<number>`count(*)::int` })
        .from(mapVoteBallots)
        .where(eq(mapVoteBallots.voteId, id))
        .groupBy(mapVoteBallots.choice);
      const counts = vote.choices.map((_, index) => totals.find((row) => row.choice === index)?.total ?? 0);
      const [claimed] = await tx
        .update(mapVotes)
        .set({
          state: "closing",
          counts,
          winner: ballotWinner(counts),
          updatedAt: new Date(),
          message: "Voting closed; checking the next map.",
        })
        .where(eq(mapVotes.id, id))
        .returning();
      return claimed;
    });
  }
  async finish(id: string, state: "queued" | "no_votes" | "tied" | "cancelled" | "needs_review", message: string) {
    const [vote] = await this.db
      .update(mapVotes)
      .set({ state, message, updatedAt: new Date() })
      .where(and(eq(mapVotes.id, id), inArray(mapVotes.state, ["publishing", "closing"])))
      .returning();
    return vote ?? null;
  }
  async cancel(id: string, requestId: string, actor: Staff, reason: string) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (
        vote?.cancellation?.id === requestId &&
        vote.cancellation.actorId === actor.id &&
        vote.cancellation.reason === reason
      )
        return vote;
      if (!vote || !["open", "needs_review"].includes(vote.state))
        throw new ConflictException(
          "This ballot cannot be closed during an operation or after a final result. Refresh its status.",
        );
      const now = new Date();
      const [closed] = await tx
        .update(mapVotes)
        .set({
          state: "cancelled",
          message: "Staff closed this ballot. No game changes were reversed.",
          cancellation: {
            id: requestId,
            actorId: actor.id,
            actorName: actor.name,
            reason,
            previousState: vote.state,
            previousMessage: vote.message,
            at: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(eq(mapVotes.id, id))
        .returning();
      return closed;
    });
  }
  /** Interrupted publication/closing is uncertain. Never acquire and replay it on another worker. */
  async recover(now: Date): Promise<MapVoteRecord[]> {
    return this.db
      .update(mapVotes)
      .set({
        state: "needs_review",
        message:
          "An operation was interrupted. Check the Discord ballot and action receipt before starting another vote.",
        updatedAt: now,
      })
      .where(
        and(
          inArray(mapVotes.state, ["publishing", "closing"]),
          lte(mapVotes.updatedAt, new Date(now.getTime() - 120_000)),
        ),
      )
      .returning();
  }
}
