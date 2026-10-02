import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { AdminService } from "../admin/admin.service";
import type { ActionResult, Staff } from "../admin/admin.types";
import { GameServers } from "../admin/game-servers";
import { LEGACY_SERVER_ID, publicGameServer } from "../common/game-server";
import { EnvService } from "../env/env.service";
import { ApplicationsStore } from "./applications.store";
import {
  applicationSchema,
  consentVersion,
  ownApplication,
  reviewSchema,
  type ApplicantIdentity,
  type ApplicationReview,
  type WhitelistApplication,
} from "./applications.types";

@Injectable()
export class ApplicationsService {
  private readonly submissions = new Map<string, { until: number; count: number }>();
  constructor(
    private readonly store: ApplicationsStore,
    private readonly admin: AdminService,
    private readonly env: EnvService,
    private readonly servers: GameServers,
  ) {}

  enabled() {
    if (!this.env.get("WHITELIST_APPLICATIONS_ENABLED"))
      throw new ServiceUnavailableException(
        "Website applications are not open yet. Please check back on this website.",
      );
  }

  emailRequired() {
    return this.env.get("WHITELIST_APPLICATION_EMAIL_REQUIRED");
  }

  private requireAdmin(staff: Staff) {
    this.enabled();
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can review private applications.");
  }

  async me(identity: ApplicantIdentity, selected?: string) {
    this.enabled();
    const serverId = this.servers.resolve(selected ?? LEGACY_SERVER_ID);
    return {
      ...identity,
      emailRequired: this.emailRequired(),
      serverId,
      servers: this.servers.list().map(publicGameServer),
      application: ownApplication(await this.store.own(identity.userId, serverId)),
    };
  }

  async submit(identity: ApplicantIdentity, input: unknown) {
    this.enabled();
    const parsed = applicationSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException("Check your SteamID64, relationship, email and required agreements.");
    const serverId = this.servers.resolve(parsed.data.serverId);
    if (this.emailRequired() && !parsed.data.email)
      throw new BadRequestException("Enter an email for application and access updates.");
    const now = Date.now();
    for (const [key, item] of this.submissions) if (item.until <= now) this.submissions.delete(key);
    let limit = this.submissions.get(identity.userId);
    if (!limit && this.submissions.size < 5000) {
      limit = { until: now + 3_600_000, count: 0 };
      this.submissions.set(identity.userId, limit);
    }
    if (!limit || ++limit.count > 5)
      throw new HttpException("Too many application attempts. Please contact staff in Discord.", 429);
    const data = parsed.data;
    const submittedAt = new Date();
    const application = await this.store.create({
      serverId,
      discordUserId: identity.userId,
      discordDisplayName: identity.displayName,
      steamId: data.steamId,
      relationship: data.relationship,
      email: data.email ?? null,
      contactConsent: data.contactConsent,
      contactConsentAt: data.contactConsent ? submittedAt : null,
      rulesAcceptedAt: submittedAt,
      consentVersion,
      emailVerified: false,
      steamOwnershipVerified: false,
      status: "pending",
      submittedAt,
      updatedAt: submittedAt,
    });
    if (!application)
      throw new ConflictException(
        "A matching application already exists. Check your application status or contact staff in Discord.",
      );
    return { application: ownApplication(application) };
  }

  async list(staff: Staff) {
    this.requireAdmin(staff);
    return {
      serverId: this.servers.resolve(staff.serverId),
      applications: await this.store.list(this.servers.resolve(staff.serverId)),
    };
  }

  async review(staff: Staff, applicationId: string, kind: "approve" | "decline" | "recheck", input: unknown) {
    this.requireAdmin(staff);
    const parsed = reviewSchema.safeParse(input);
    if (!z.uuid().safeParse(applicationId).success || !parsed.success)
      throw new BadRequestException("A valid application, action ID and review reason are required.");
    const request = parsed.data;
    const serverId = this.servers.resolve(staff.serverId);
    const actor = { ...staff, serverId };
    if (kind === "recheck") return this.recheck(actor, applicationId, request);
    const claim = await this.store.claim(applicationId, request, kind, actor);
    if (!claim.application) throw new NotFoundException("Application not found.");
    if (claim.application.serverId !== serverId) throw new NotFoundException("Application not found on this server.");
    if (!claim.claimed) return this.recordedReview(claim.application, request, kind, staff);
    if (kind === "decline")
      return {
        application: claim.application,
        outcome: { id: request.id, state: "applied", message: claim.application.lastActionMessage! },
      };
    let outcome: ActionResult;
    try {
      const result = await this.admin.act(actor, {
        id: request.id,
        serverId,
        action: "whitelist-add",
        steamId: claim.application.steamId,
        // Private reviewer notes and contact details must stay out of the shared game audit.
        reason: `Website whitelist application ${applicationId} approved.`,
      });
      const state = z.enum(["applied", "accepted", "pending", "failed", "unknown"]).safeParse(result.state);
      outcome = state.success
        ? { state: state.data, message: result.message }
        : { state: "unknown", message: "The whitelist result could not be interpreted. Check action history." };
    } catch {
      outcome = {
        state: "unknown",
        message:
          "Approval could not be confirmed. Check the running whitelist and action history. No automatic retry will be sent.",
      };
    }
    try {
      const application = await this.store.finishApproval(applicationId, request.id, outcome);
      return { application, outcome: { id: request.id, ...outcome } };
    } catch {
      return {
        application: claim.application,
        outcome: {
          id: request.id,
          state: "unknown",
          message:
            "The game request finished, but the application result could not be saved. Refresh this application and use Recheck live whitelist. No further grant will be sent.",
        },
      };
    }
  }

  private recordedReview(
    record: WhitelistApplication,
    request: ApplicationReview,
    kind: "approve" | "decline" | "recheck",
    staff: Staff,
  ) {
    const sameKind = record.reviewKind === kind;
    if (
      record.reviewId === request.id &&
      record.reviewedBy === staff.id &&
      record.reviewReason === request.reason &&
      sameKind
    ) {
      return {
        application: record,
        outcome: {
          id: request.id,
          state: record.lastActionState === "started" ? "unknown" : (record.lastActionState ?? "unknown"),
          message:
            record.lastActionState === "started"
              ? "This approval was already started. Check the running whitelist and action history before any further change."
              : (record.lastActionMessage ?? "Check the recorded application status."),
        },
      };
    }
    throw new ConflictException(
      "This application is already being reviewed or has a recorded decision. Refresh and check its history.",
    );
  }

  private async recheck(staff: Staff, applicationId: string, request: ApplicationReview) {
    const application = await this.store.get(applicationId, staff.serverId!);
    if (!application) throw new NotFoundException("Application not found on this server.");
    if (application.reviewId === request.id) return this.recordedReview(application, request, "recheck", staff);
    if (!["processing", "needs_review"].includes(application.status))
      throw new ConflictException("This application does not need a live recheck. Refresh its status.");
    let outcome: ActionResult;
    try {
      const list = await this.servers.get(staff.serverId!).whitelist();
      const active = list.entries.some((entry) => entry.steamId === application.steamId && entry.active);
      outcome = active
        ? { state: "applied", message: "Whitelist access is confirmed in the running game. No game change was sent." }
        : {
            state: "pending",
            message:
              "Access is not confirmed in the running whitelist. The application still needs review. No game change was sent.",
          };
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The running whitelist could not be checked. The application still needs review. No game change was sent.",
      };
    }
    try {
      const saved = await this.store.finishRecheck(application, request, staff, outcome);
      return { application: saved, outcome: { id: request.id, ...outcome } };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      return {
        application,
        outcome: {
          id: request.id,
          state: "unknown",
          message:
            "The whitelist check could not be saved. Refresh this application before checking again. No game change was sent.",
        },
      };
    }
  }
}
