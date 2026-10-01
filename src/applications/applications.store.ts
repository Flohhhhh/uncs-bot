import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DATABASE, type Database } from "../database/database.types";
import { whitelistApplications, whitelistApplicationReviews } from "../database/schema";
import type { ActionResult, Staff } from "../admin/admin.types";
import type { ApplicationReview } from "./applications.types";

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

  async claim(applicationId: string, review: ApplicationReview, kind: "approve" | "decline" | "recheck", staff: Staff) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [application] = await tx
        .update(whitelistApplications)
        .set({
          status: kind === "decline" ? "declined" : "processing",
          reviewedAt: now,
          reviewedBy: staff.id,
          reviewReason: review.reason,
          ...(kind !== "recheck" ? { actionId: review.id } : {}),
          reviewId: review.id,
          reviewKind: kind,
          lastActionState: kind === "decline" ? "applied" : "started",
          lastActionMessage:
            kind === "decline"
              ? "Application declined. No whitelist change was sent."
              : kind === "recheck"
                ? "Live whitelist verification started. No game change will be sent."
                : "Approval started. The running whitelist has not yet been confirmed.",
          updatedAt: now,
        })
        .where(
          and(
            eq(whitelistApplications.id, applicationId),
            eq(whitelistApplications.serverId, staff.serverId ?? "primary"),
            eq(whitelistApplications.status, kind === "recheck" ? "needs_review" : "pending"),
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

  async finishApproval(applicationId: string, actionId: string, outcome: ActionResult) {
    return this.db.transaction(async (tx) => {
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
      if (!application) throw new Error("Approval completion no longer matches its original claim.");
      await tx
        .update(whitelistApplicationReviews)
        .set({ state: outcome.state, message: outcome.message, completedAt: now })
        .where(eq(whitelistApplicationReviews.id, actionId));
      return application;
    });
  }
}
