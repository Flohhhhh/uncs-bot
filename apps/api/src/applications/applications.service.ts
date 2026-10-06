import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Subscription } from "rxjs";
import { z } from "zod";
import { AdminService, type WhitelistRemoval } from "../admin/admin.service";
import type { ActionResult, Staff } from "../admin/admin.types";
import { GameServers } from "../admin/game-servers";
import { LEGACY_SERVER_ID, publicGameServer } from "../common/game-server";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import { SupporterMatchService } from "../supporters/supporter-match.service";
import { ApplicationsStore } from "./applications.store";
import {
  applicationSchema,
  consentVersion,
  ownApplication,
  reviewSchema,
  type ApplicantIdentity,
  type ApplicationReview,
  type ReviewKind,
  type WhitelistApplication,
  type WhitelistState,
} from "./applications.types";

const actionStates = z.enum(["applied", "accepted", "pending", "failed", "unknown"]);
const liveWhitelist = z.object({
  entries: z.array(z.object({ steamId: z.string(), active: z.boolean(), configured: z.boolean().nullable() })),
});
const unresolved = ["pending", "processing", "needs_review"];

@Injectable()
export class ApplicationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApplicationsService.name);
  private readonly submissions = new Map<string, { until: number; count: number }>();
  private removals?: Subscription;
  constructor(
    private readonly store: ApplicationsStore,
    private readonly admin: AdminService,
    private readonly env: EnvService,
    private readonly servers: GameServers,
    private readonly roles: DiscordRolesService,
    private readonly match: SupporterMatchService,
  ) {}

  onModuleInit() {
    // A removal on the Whitelist page revokes the matching approved application. AdminModule does not
    // import this module, so subscribing here creates no dependency cycle.
    this.removals = this.admin.whitelistRemovals.subscribe((removal) => {
      void this.externalRevoke(removal);
    });
  }

  onModuleDestroy() {
    this.removals?.unsubscribe();
  }

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
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can review private applications.");
  }

  /** Lets the role service re-check this member. Fire-and-forget: a role problem never fails a review. */
  private notifyRoles(application: Pick<WhitelistApplication, "discordUserId"> | null | undefined) {
    try {
      this.roles.applicationChanged(application?.discordUserId);
    } catch {
      /* The role service logs its own problems. */
    }
  }

  /**
   * An approved application can complete a Patreon supporter's SteamID (automatic supporter matching, off by default).
   * Fire-and-forget after the review is saved: matching waits on locks and must never delay or fail a review.
   */
  private matchSupporters(application: Pick<WhitelistApplication, "discordUserId" | "status"> | null | undefined) {
    try {
      if (application?.status === "approved") void this.match.applicationChanged(application.discordUserId);
    } catch {
      /* Matching logs its own problems. */
    }
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

  /**
   * Unresolved requests show whether their SteamID is already on the whitelist (cached read). A failed
   * read shows "unknown" and never stops the list from loading.
   */
  async list(staff: Staff) {
    this.requireAdmin(staff);
    const serverId = this.servers.resolve(staff.serverId);
    // Off is the default, not a failure. The table may not exist until the reviewed schema is
    // deployed, so report the setting without reading the store.
    if (!this.env.get("WHITELIST_APPLICATIONS_ENABLED")) return { enabled: false, serverId, applications: [] };
    const applications = await this.store.list(serverId);
    let live: Map<string, "active" | "saved"> | null = null;
    if (applications.some((application) => unresolved.includes(application.status)))
      try {
        const parsed = liveWhitelist.safeParse(await this.admin.read("whitelist", serverId));
        if (parsed.success)
          live = new Map(parsed.data.entries.map((entry) => [entry.steamId, entry.active ? "active" : "saved"]));
      } catch {
        live = null;
      }
    return {
      enabled: true,
      serverId,
      applications: applications.map((application) => ({
        ...application,
        whitelistState: (unresolved.includes(application.status)
          ? live
            ? (live.get(application.steamId) ?? "absent")
            : "unknown"
          : null) satisfies WhitelistState,
      })),
    };
  }

  async review(staff: Staff, applicationId: string, kind: ReviewKind, input: unknown) {
    this.enabled();
    this.requireAdmin(staff);
    const parsed = reviewSchema.safeParse(input);
    if (!z.uuid().safeParse(applicationId).success || !parsed.success)
      throw new BadRequestException("A valid application, action ID and review reason are required.");
    const request = parsed.data;
    const serverId = this.servers.resolve(staff.serverId);
    const actor = { ...staff, serverId };
    if (kind === "recheck") return this.recheck(actor, applicationId, request);
    if (kind === "revoke") return this.revoke(actor, applicationId, request);
    // Approving a SteamID that is already live records the registration instead of sending a grant once
    // staff confirm this Discord member owns it. Requiring that confirmation is a setting, off by default,
    // so a dashboard that cannot send it keeps the normal grant. Nothing is ever approved automatically.
    let alreadyLive = false;
    let alreadySaved = false;
    let liveUnknown = false;
    let existing = false;
    if (kind === "approve") {
      const current = await this.store.get(applicationId, serverId);
      if (current?.status === "pending") {
        try {
          const list = await this.servers.get(serverId).whitelist();
          const entry = list.entries.find((item) => item.steamId === current.steamId);
          alreadyLive = Boolean(entry?.active);
          // Saved in the configuration but not running yet: the grant can report it as applied without having
          // added it, so it is not recorded as a grant either. It still gets the normal grant.
          alreadySaved = !alreadyLive && entry?.configured === true;
        } catch {
          // An unreadable whitelist falls back to the normal grant, which confirms its own result. Whether the
          // SteamID was already live is then unknown, so the approval records no grant.
          alreadyLive = false;
          liveUnknown = true;
        }
        existing = alreadyLive && request.existingAccessConfirmed === true;
        if (alreadyLive && !existing && this.env.get("WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED") === true)
          throw new ConflictException(
            "This SteamID is already on the running whitelist. Confirm this Discord member owns it, then approve again to record the registration. No whitelist change will be sent.",
          );
      }
    }
    const claim = await this.store.claim(applicationId, request, kind, actor);
    if (!claim.application) throw new NotFoundException("Application not found.");
    if (claim.application.serverId !== serverId) throw new NotFoundException("Application not found on this server.");
    if (!claim.claimed) return this.recordedReview(claim.application, request, kind, staff);
    if (kind === "decline")
      return {
        application: claim.application,
        outcome: { id: request.id, state: "applied", message: claim.application.lastActionMessage! },
      };
    if (existing) {
      const outcome: ActionResult = {
        state: "applied",
        message: "Registered an existing whitelist entry; it was already active. No whitelist change was sent.",
      };
      let application: WhitelistApplication;
      try {
        application = await this.store.finishApproval(applicationId, request.id, outcome, "existing");
      } catch {
        return {
          application: claim.application,
          outcome: {
            id: request.id,
            state: "unknown",
            message:
              "The registration could not be saved. Refresh this application and use Recheck live whitelist. No whitelist change was sent.",
          },
        };
      }
      this.notifyRoles(application);
      this.matchSupporters(application);
      return { application, outcome: { id: request.id, ...outcome } };
    }
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
      const state = actionStates.safeParse(result.state);
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
    let application: WhitelistApplication;
    try {
      // A grant for an entry that was already live, or already in the saved configuration, may have changed nothing,
      // so it is not recorded as a grant. Neither is one whose earlier whitelist read failed: a build that edits the
      // saved configuration reports an existing entry as applied.
      application = await this.store.finishApproval(
        applicationId,
        request.id,
        outcome,
        alreadyLive || alreadySaved || liveUnknown ? null : "granted",
      );
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
    this.notifyRoles(application);
    this.matchSupporters(application);
    return { application, outcome: { id: request.id, ...outcome } };
  }

  private recordedReview(record: WhitelistApplication, request: ApplicationReview, kind: ReviewKind, staff: Staff) {
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
              ? `This ${kind === "revoke" ? "revocation" : "approval"} was already started. Check the running whitelist and action history before any further change.`
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
    const revoke = application.accessIntent === "revoke";
    if (!["processing", "needs_review", ...(revoke ? ["revoking"] : [])].includes(application.status))
      throw new ConflictException("This application does not need a live recheck. Refresh its status.");
    let outcome: ActionResult;
    try {
      const list = await this.servers.get(staff.serverId!).whitelist();
      const active = list.entries.some((entry) => entry.steamId === application.steamId && entry.active);
      outcome = revoke
        ? active
          ? {
              state: "pending",
              message: "Still active; revoke again or check the host panel. No game change was sent.",
            }
          : {
              state: "applied",
              message: "Whitelist access is confirmed removed from the running game. No game change was sent.",
            }
        : active
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
    let saved: WhitelistApplication;
    try {
      saved = await this.store.finishRecheck(application, request, staff, outcome);
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
    this.notifyRoles(saved);
    // A recheck records no grant, so it never fills a SteamID itself, but ending a review can unblock another
    // approved application of the same Discord account.
    this.matchSupporters(saved);
    return { application: saved, outcome: { id: request.id, ...outcome } };
  }

  /**
   * Removes the application's SteamID from the whitelist. The claim and its review receipt are saved
   * before the game is contacted; an uncertain result is never retried automatically.
   */
  private async revoke(staff: Staff, applicationId: string, request: ApplicationReview) {
    const serverId = staff.serverId!;
    const claim = await this.store.claimRevoke(applicationId, request, staff);
    if (!claim.application) throw new NotFoundException("Application not found on this server.");
    if (!claim.claimed) return this.recordedReview(claim.application, request, "revoke", staff);
    const steamId = claim.application.steamId;
    let outcome: ActionResult;
    try {
      const result = await this.admin.act(staff, {
        id: request.id,
        serverId,
        action: "whitelist-remove",
        steamId,
        confirm: steamId,
        reason: `Website whitelist application ${applicationId} revoked.`,
      });
      const state = actionStates.safeParse(result.state);
      outcome = !state.success
        ? { state: "unknown", message: "The whitelist result could not be interpreted. Check action history." }
        : state.data === "failed"
          ? { state: "failed", message: `The game refused the revocation; access unchanged. ${result.message}` }
          : { state: state.data, message: result.message };
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The revocation could not be confirmed. Check the running whitelist and use Recheck live whitelist. No automatic retry will be sent.",
      };
    }
    if (outcome.state === "failed") outcome = await this.refusedRevoke(serverId, steamId, outcome);
    try {
      const application = await this.store.finishRevoke(applicationId, request.id, outcome);
      this.notifyRoles(application);
      return { application, outcome: { id: request.id, ...outcome } };
    } catch {
      return {
        application: claim.application,
        outcome: {
          id: request.id,
          state: "unknown",
          message:
            "The game request finished, but the revocation result could not be saved. Refresh this application and use Recheck live whitelist.",
        },
      };
    }
  }

  /**
   * A refusal only leaves access unchanged while the SteamID is still live. A removal refused because the
   * entry is already gone (404 reserved_not_found) has taken effect, so it is recorded as a revocation; an
   * unreadable whitelist leaves the revocation for review. Reads only; nothing is sent to the game.
   */
  private async refusedRevoke(serverId: string, steamId: string, refused: ActionResult): Promise<ActionResult> {
    try {
      const list = await this.servers.get(serverId).whitelist();
      if (list.entries.some((entry) => entry.steamId === steamId && entry.active)) return refused;
      return {
        state: "applied",
        message:
          "The SteamID is no longer on the running whitelist, so the revocation is recorded. No further game change was sent.",
      };
    } catch {
      return {
        state: "unknown",
        message:
          "The game refused the revocation and the running whitelist could not be checked. Use Recheck live whitelist before any further change.",
      };
    }
  }

  private async externalRevoke(removal: WhitelistRemoval) {
    try {
      for (const application of await this.store.recordExternalRevoke(removal)) this.notifyRoles(application);
    } catch {
      // Database error text carries SQL parameters (SteamID, staff identity, reasons): log fixed text only.
      this.logger.warn(
        `A Whitelist page removal (action ${removal.actionId}) could not be recorded on its application. Revoke that application on the Applications page to record it.`,
      );
    }
  }
}
