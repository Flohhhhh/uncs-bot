import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DATABASE, type Database } from "../database/database.types";
import { whitelistApplications, whitelistApplicationReviews } from "../database/schema";
import type { WhitelistRemoval } from "../admin/admin.service";
import type { ActionResult, Staff } from "../admin/admin.types";
import type { ApplicationReview, WhitelistApplication } from "./applications.types";

@Injectable()
export class ApplicationsStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: typeof whitelistApplications.$inferInsert) {
    const [created] = await this.db.insert(whitelistApplications).values(input).onConflictDoNothing().returning();
    return created;
  }

  async own(discordUserId: string, serverId = "primary") {
    const [record] = await this.db
      .select()
      .from(whitelistApplications)
      .where(and(eq(whitelistApplications.discordUserId, discordUserId), eq(whitelistApplications.serverId, serverId)))
      .limit(1);
    return record;
  }

  async list(serverId = "primary") {
    const awaitingReview = inArray(whitelistApplications.status, ["pending", "processing", "needs_review"]);
    return this.db
      .select()
      .from(whitelistApplications)
      .where(eq(whitelistApplications.serverId, serverId))
      .orderBy(
        sql`case when ${awaitingReview} then 0 else 1 end`,
        sql`case when ${awaitingReview} then ${whitelistApplications.submittedAt} end asc`,
        desc(whitelistApplications.submittedAt),
        asc(whitelistApplications.id),
      )
      .limit(100);
  }

  async get(applicationId: string, serverId: string) {
    const [record] = await this.db
      .select()
      .from(whitelistApplications)
      .where(and(eq(whitelistApplications.id, applicationId), eq(whitelistApplications.serverId, serverId)))
      .limit(1);
    return record;
  }

  async claim(applicationId: string, review: ApplicationReview, kind: "approve" | "decline", staff: Staff) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: kind === "decline" ? "declined" : "processing",
          reviewedAt: now,
          reviewedBy: staff.id,
          reviewReason: review.reason,
          actionId: review.id,
          reviewId: review.id,
          reviewKind: kind,
          lastActionState: kind === "decline" ? "applied" : "started",
          lastActionMessage:
            kind === "decline"
              ? "Application declined. No whitelist change was sent."
              : "Approval started. The running whitelist has not yet been confirmed.",
          updatedAt: now,
        })
        .where(
          and(
            eq(whitelistApplications.id, applicationId),
            eq(whitelistApplications.serverId, staff.serverId ?? "primary"),
            eq(whitelistApplications.status, "pending"),
          ),
        )
        .returning();
      if (!application) {
        const [current] = await tx
          .select()
          .from(whitelistApplications)
          .where(
            and(
              eq(whitelistApplications.id, applicationId),
              eq(whitelistApplications.serverId, staff.serverId ?? "primary"),
            ),
          )
          .limit(1);
        return { claimed: false, application: current };
      }
      await tx.insert(whitelistApplicationReviews).values({
        id: review.id,
        applicationId,
        kind,
        actorId: staff.id,
        actorName: staff.name,
        reason: review.reason,
        state: application.lastActionState!,
        message: application.lastActionMessage!,
        completedAt: kind === "decline" ? now : null,
      });
      return { claimed: true, application };
    });
  }

  /**
   * A read needs no in-flight claim: save only if the decision inspected before the game read still matches.
   * For a revocation, "applied" means the entry is confirmed absent and the application becomes revoked.
   */
  async finishRecheck(previous: WhitelistApplication, review: ApplicationReview, staff: Staff, outcome: ActionResult) {
    const revoke = previous.accessIntent === "revoke";
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: outcome.state === "applied" ? (revoke ? "revoked" : "approved") : "needs_review",
          ...(revoke && outcome.state === "applied" ? { revokedAt: now } : {}),
          reviewedAt: now,
          reviewedBy: staff.id,
          reviewReason: review.reason,
          reviewId: review.id,
          reviewKind: "recheck",
          lastActionState: outcome.state,
          lastActionMessage: outcome.message,
          updatedAt: now,
        })
        .where(
          and(
            eq(whitelistApplications.id, previous.id),
            eq(whitelistApplications.serverId, staff.serverId ?? "primary"),
            inArray(whitelistApplications.status, ["processing", "needs_review", "revoking"]),
            eq(whitelistApplications.status, previous.status),
            eq(whitelistApplications.accessIntent, previous.accessIntent),
            previous.reviewId === null
              ? isNull(whitelistApplications.reviewId)
              : eq(whitelistApplications.reviewId, previous.reviewId),
          ),
        )
        .returning();
      if (!application)
        throw new ConflictException("This application changed during the whitelist check. Refresh its status.");
      await tx.insert(whitelistApplicationReviews).values({
        id: review.id,
        applicationId: previous.id,
        kind: "recheck",
        actorId: staff.id,
        actorName: staff.name,
        reason: review.reason,
        state: outcome.state,
        message: outcome.message,
        completedAt: now,
      });
      return application;
    });
  }

  /** `grant` records how an applied approval was achieved: a whitelist grant or a confirmed existing entry. */
  async finishApproval(
    applicationId: string,
    actionId: string,
    outcome: ActionResult,
    grant: "granted" | "existing" | null = null,
  ) {
    const result = await this.db.transaction(async (tx) => {
      const now = new Date();
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: outcome.state === "applied" ? "approved" : "needs_review",
          ...(outcome.state === "applied" && grant ? { whitelistGrant: grant } : {}),
          lastActionState: outcome.state,
          lastActionMessage: outcome.message,
          updatedAt: now,
        })
        .where(
          and(
            eq(whitelistApplications.id, applicationId),
            eq(whitelistApplications.status, "processing"),
            eq(whitelistApplications.reviewId, actionId),
          ),
        )
        .returning();
      const [review] = await tx
        .update(whitelistApplicationReviews)
        .set({ state: outcome.state, message: outcome.message, completedAt: now })
        .where(
          and(
            eq(whitelistApplicationReviews.id, actionId),
            eq(whitelistApplicationReviews.applicationId, applicationId),
            eq(whitelistApplicationReviews.kind, "approve"),
            eq(whitelistApplicationReviews.state, "started"),
          ),
        )
        .returning();
      if (!review) throw new Error("Approval completion no longer matches its original claim.");
      return application;
    });
    // A newer readback owns application status; still retain this original operation's eventual receipt.
    if (!result)
      throw new ConflictException("Approval completion no longer matches its original claim. Refresh its status.");
    return result;
  }

  /**
   * Claims a revocation before the game is contacted: from approved, or from needs_review after an
   * uncertain revocation. Concurrent requests cannot both claim it.
   */
  async claimRevoke(applicationId: string, review: ApplicationReview, staff: Staff) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const scope = and(
        eq(whitelistApplications.id, applicationId),
        eq(whitelistApplications.serverId, staff.serverId ?? "primary"),
      );
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: "revoking",
          accessIntent: "revoke",
          reviewedAt: now,
          reviewedBy: staff.id,
          reviewReason: review.reason,
          reviewId: review.id,
          reviewKind: "revoke",
          lastActionState: "started",
          lastActionMessage: "Revocation started. The running whitelist has not yet been confirmed.",
          updatedAt: now,
        })
        .where(
          and(
            scope,
            or(
              eq(whitelistApplications.status, "approved"),
              and(eq(whitelistApplications.status, "needs_review"), eq(whitelistApplications.accessIntent, "revoke")),
            ),
          ),
        )
        .returning();
      if (!application) {
        const [current] = await tx.select().from(whitelistApplications).where(scope).limit(1);
        return { claimed: false, application: current };
      }
      await tx.insert(whitelistApplicationReviews).values({
        id: review.id,
        applicationId,
        kind: "revoke",
        actorId: staff.id,
        actorName: staff.name,
        reason: review.reason,
        state: "started",
        message: application.lastActionMessage!,
      });
      return { claimed: true, application };
    });
  }

  /**
   * Applied or saved removals revoke the application. A refusal restores approved access; an unknown
   * result needs a readback.
   */
  async finishRevoke(applicationId: string, actionId: string, outcome: ActionResult) {
    const result = await this.db.transaction(async (tx) => {
      const now = new Date();
      const removed = outcome.state === "applied" || outcome.state === "pending";
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: removed ? "revoked" : outcome.state === "failed" ? "approved" : "needs_review",
          ...(removed ? { revokedAt: now } : {}),
          ...(outcome.state === "failed" ? { accessIntent: "grant" as const } : {}),
          lastActionState: outcome.state,
          lastActionMessage: outcome.message,
          updatedAt: now,
        })
        .where(
          and(
            eq(whitelistApplications.id, applicationId),
            eq(whitelistApplications.status, "revoking"),
            eq(whitelistApplications.reviewId, actionId),
          ),
        )
        .returning();
      const [review] = await tx
        .update(whitelistApplicationReviews)
        .set({ state: outcome.state, message: outcome.message, completedAt: now })
        .where(
          and(
            eq(whitelistApplicationReviews.id, actionId),
            eq(whitelistApplicationReviews.applicationId, applicationId),
            eq(whitelistApplicationReviews.kind, "revoke"),
            eq(whitelistApplicationReviews.state, "started"),
          ),
        )
        .returning();
      if (!review) throw new Error("Revocation completion no longer matches its original claim.");
      return application;
    });
    if (!result)
      throw new ConflictException("Revocation completion no longer matches its original claim. Refresh its status.");
    return result;
  }

  /**
   * A SteamID removed on the Whitelist page revokes the approved application for it on that server,
   * with a review receipt naming the staff member. Applications already being revoked are left alone.
   */
  async recordExternalRevoke(removal: WhitelistRemoval) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const reviewId = randomUUID();
      const reason = `Removed from the Whitelist page (action ${removal.actionId}).`;
      const message =
        removal.state === "applied"
          ? "Whitelist access was removed from the running game on the Whitelist page."
          : "Whitelist access was removed from the saved configuration on the Whitelist page.";
      const revoked = await tx
        .update(whitelistApplications)
        .set({
          status: "revoked",
          accessIntent: "revoke",
          revokedAt: now,
          reviewedAt: now,
          reviewedBy: removal.actorId,
          reviewReason: reason,
          reviewId,
          reviewKind: "revoke",
          lastActionState: removal.state,
          lastActionMessage: message,
          updatedAt: now,
        })
        .where(
          and(
            eq(whitelistApplications.serverId, removal.serverId),
            eq(whitelistApplications.steamId, removal.steamId),
            eq(whitelistApplications.status, "approved"),
          ),
        )
        .returning();
      for (const application of revoked)
        await tx.insert(whitelistApplicationReviews).values({
          id: reviewId,
          applicationId: application.id,
          kind: "revoke",
          actorId: removal.actorId,
          actorName: removal.actorName,
          reason,
          state: removal.state,
          message,
          completedAt: now,
        });
      return revoked;
    });
  }
}
