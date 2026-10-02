import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { whitelistApplications, whitelistApplicationReviews } from "../database/schema";
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

  /** A read needs no in-flight claim: save only if the decision inspected before the game read still matches. */
  async finishRecheck(previous: WhitelistApplication, review: ApplicationReview, staff: Staff, outcome: ActionResult) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: outcome.state === "applied" ? "approved" : "needs_review",
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
            inArray(whitelistApplications.status, ["processing", "needs_review"]),
            eq(whitelistApplications.status, previous.status),
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

  async finishApproval(applicationId: string, actionId: string, outcome: ActionResult) {
    const result = await this.db.transaction(async (tx) => {
      const now = new Date();
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: outcome.state === "applied" ? "approved" : "needs_review",
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
}
