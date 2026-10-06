import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { mapVoteBallots, mapVotes, mapVotePolicies } from "../database/schema";
import {
  automationSettings,
  closeReached,
  type StoredVotingPolicy,
  type VoteAutomation,
  type VoteReminder,
} from "../common/voting-policy";
import { ballotWinner, type MapVoteRecord, type MapVoteState } from "./map-votes.types";
import type { Staff } from "../admin/admin.types";

type FinishState = "queued" | "no_votes" | "tied" | "cancelled" | "needs_review";

@Injectable()
export class MapVotesStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async policy(serverId: string) {
    const [policy] = await this.db.select().from(mapVotePolicies).where(eq(mapVotePolicies.serverId, serverId));
    return policy ?? null;
  }
  policies() {
    return this.db.select().from(mapVotePolicies);
  }
  /**
   * Saves under the per-server lock and optimistic version. A callback receives the stored document so a
   * partial save (such as the original five switches) merges with settings it does not carry.
   */
  async savePolicy(
    serverId: string,
    version: number,
    next: StoredVotingPolicy | ((previous: StoredVotingPolicy | null) => StoredVotingPolicy),
    staff: Staff,
    connectionHash: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"map-vote:" + serverId}))`);
      const [previous] = await tx.select().from(mapVotePolicies).where(eq(mapVotePolicies.serverId, serverId));
      if ((previous?.version ?? 0) !== version)
        throw new ConflictException("Voting controls changed. Refresh before saving.");
      const policy = typeof next === "function" ? next(previous?.policy ?? null) : next;
      const values = {
        serverId,
        policy,
        version: version + 1,
        actorId: staff.id,
        actorName: staff.name,
        connectionHash,
        updatedAt: new Date(),
      };
      const [saved] = await tx
        .insert(mapVotePolicies)
        .values(values)
        .onConflictDoUpdate({ target: mapVotePolicies.serverId, set: values })
        .returning();
      // Turning off closes idle automatic ballots atomically; it never queues a winner.
      const closed = !policy.enabled
        ? await tx
            .update(mapVotes)
            .set({
              state: "cancelled",
              updatedAt: new Date(),
              message: "Automatic voting was switched off. The rotation was left unchanged.",
            })
            .where(
              and(eq(mapVotes.serverId, serverId), eq(mapVotes.state, "open"), sql`${mapVotes.automation} is not null`),
            )
            .returning()
        : [];
      return { saved, closed };
    });
  }
  automaticOpen() {
    return this.db
      .select()
      .from(mapVotes)
      .where(and(eq(mapVotes.state, "open"), sql`${mapVotes.automation} is not null`));
  }
  /** Records a higher leading score and, when `step` is known, the largest increase between close samples. */
  async observeScore(id: string, score: number, step: number | null = null) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (!vote || vote.state !== "open" || !vote.automation || score < vote.automation.highestScore) return false;
      if (score === vote.automation.highestScore) return true;
      const maxStep = Math.max(vote.automation.maxStep ?? 0, step ?? 0);
      await tx
        .update(mapVotes)
        .set({
          automation: {
            ...vote.automation,
            highestScore: score,
            ...(vote.automation.settings ? { maxStep, lastScoreAt: new Date().toISOString() } : {}),
          },
        })
        .where(eq(mapVotes.id, id));
      return true;
    });
  }
  /** Merges stored automation details while the ballot is still in one of `states`. Never changes `updatedAt`. */
  async patchAutomation(id: string, patch: Partial<VoteAutomation>, states: MapVoteState[] = ["open", "closing"]) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (!vote?.automation || !states.includes(vote.state)) return null;
      const [updated] = await tx
        .update(mapVotes)
        .set({ automation: { ...vote.automation, ...patch } })
        .where(eq(mapVotes.id, id))
        .returning();
      return updated ?? null;
    });
  }
  /** Moves an automatic ballot out of review only; a staff close that happened first wins. */
  async resolveReview(
    id: string,
    to: "queued" | "cancelled",
    message: string,
    patch: Partial<VoteAutomation>,
    messageId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (!vote?.automation || vote.state !== "needs_review") return null;
      const [updated] = await tx
        .update(mapVotes)
        .set({
          state: to,
          message,
          updatedAt: new Date(),
          automation: { ...vote.automation, ...patch },
          ...(messageId && !vote.messageId ? { messageId } : {}),
        })
        .where(eq(mapVotes.id, id))
        .returning();
      return updated ?? null;
    });
  }
  /** Automatic ballots awaiting review on every server, oldest first. */
  needsReview() {
    return this.db
      .select()
      .from(mapVotes)
      .where(and(eq(mapVotes.state, "needs_review"), sql`${mapVotes.automation} is not null`))
      .orderBy(mapVotes.updatedAt)
      .limit(20);
  }
  async claimReminder(id: string, stage: VoteReminder, receiptId: string) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (
        !vote ||
        vote.state !== "open" ||
        !vote.automation ||
        vote.closesAt.getTime() <= Date.now() ||
        vote.automation.reminders[stage]
      )
        return null;
      const [policy] = await tx.select().from(mapVotePolicies).where(eq(mapVotePolicies.serverId, vote.serverId));
      const field = stage === "midpoint" ? "midpointReminder" : "finalReminder";
      if (!policy?.policy.enabled || !policy.policy[field] || !vote.automation.policy[field]) return null;
      const automation = {
        ...vote.automation,
        reminders: {
          ...vote.automation.reminders,
          [stage]: {
            id: receiptId,
            state: "started",
            message: "Recorded before sending. An interrupted message is not repeated.",
            at: new Date().toISOString(),
          },
        },
      };
      await tx.update(mapVotes).set({ automation }).where(eq(mapVotes.id, id));
      return { ...vote, automation };
    });
  }
  async finishReminder(id: string, stage: VoteReminder, state: string, message: string) {
    await this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      const reminder = vote?.automation?.reminders[stage];
      if (!vote?.automation || !reminder) return;
      await tx
        .update(mapVotes)
        .set({
          automation: {
            ...vote.automation,
            reminders: { ...vote.automation.reminders, [stage]: { ...reminder, state, message } },
          },
        })
        .where(eq(mapVotes.id, id));
    });
  }

  async checkSetup(serverId: string) {
    // Resolve every expected column without reading member choices or changing any records.
    await this.db.select().from(mapVoteBallots).limit(0);
    const [unfinished] = await this.db
      .select()
      .from(mapVotes)
      .where(
        and(
          eq(mapVotes.serverId, serverId),
          inArray(mapVotes.state, ["publishing", "open", "closing", "needs_review"]),
        ),
      )
      .limit(1);
    return { unfinished: !!unfinished };
  }

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
      if (input.automation) {
        const [policy] = await tx.select().from(mapVotePolicies).where(eq(mapVotePolicies.serverId, input.serverId));
        if (
          !policy?.policy.enabled ||
          policy.actorId !== input.actorId ||
          policy.connectionHash !== input.connectionHash ||
          policy.version !== input.automation.policyVersion
        )
          throw new ConflictException("Voting controls changed before the ballot opened.");
      }
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
      return {
        selection: vote.choices[choice],
        closeAtScore: vote.automation ? automationSettings(vote.automation).closeAtScore : null,
      };
    });
  }
  due(now: Date) {
    return this.db
      .select()
      .from(mapVotes)
      .where(and(eq(mapVotes.state, "open"), lte(mapVotes.closesAt, now)))
      .limit(10);
  }
  async claimClose(id: string, scoreReached = false) {
    return this.db.transaction(async (tx) => {
      const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
      if (!vote || vote.state !== "open" || (!scoreReached && vote.closesAt.getTime() > Date.now())) return null;
      if (scoreReached) {
        const [policy] = await tx.select().from(mapVotePolicies).where(eq(mapVotePolicies.serverId, vote.serverId));
        if (!vote.automation || !closeReached(vote.automation, vote.automation.highestScore) || !policy?.policy.enabled)
          return null;
      }
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
          winner: ballotWinner(
            counts,
            vote.automation ? automationSettings(vote.automation).tieRule : "keep_rotation",
            vote.choices.findIndex((choice) => choice.event === "50v50"),
          ),
          updatedAt: new Date(),
          message: "Voting closed; checking the next map.",
        })
        .where(eq(mapVotes.id, id))
        .returning();
      return claimed;
    });
  }
  async finish(id: string, state: FinishState, message: string, patch?: Partial<VoteAutomation>) {
    if (patch)
      return this.db.transaction(async (tx) => {
        const [vote] = await tx.select().from(mapVotes).where(eq(mapVotes.id, id)).for("update");
        if (!vote || !["publishing", "closing"].includes(vote.state)) return null;
        const [finished] = await tx
          .update(mapVotes)
          .set({
            state,
            message,
            updatedAt: new Date(),
            ...(vote.automation ? { automation: { ...vote.automation, ...patch } } : {}),
          })
          .where(eq(mapVotes.id, id))
          .returning();
        return finished ?? null;
      });
    const [vote] = await this.db
      .update(mapVotes)
      .set({ state, message, updatedAt: new Date() })
      .where(and(eq(mapVotes.id, id), inArray(mapVotes.state, ["publishing", "closing"])))
      .returning();
    return vote ?? null;
  }
  async cancel(id: string, requestId: string, actor: Staff, reason: string, publicMessage?: string) {
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
          message: publicMessage ?? "Staff closed this ballot. No game changes were reversed.",
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
