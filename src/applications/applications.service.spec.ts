import { randomUUID } from "node:crypto";
import { ConflictException, Logger } from "@nestjs/common";
import { Subject } from "rxjs";
import { ApplicationsService } from "./applications.service";
import type { ApplicationsStore } from "./applications.store";
import type { AdminService, WhitelistRemoval } from "../admin/admin.service";
import type { EnvService } from "../env/env.service";
import type { ActionResult, Staff } from "../admin/admin.types";
import { fixtureServers } from "../admin/game-server-fixture";
import type { DiscordRolesService } from "../discord-roles/discord-roles.service";
import type { SupporterMatchService } from "../supporters/supporter-match.service";
import { ownApplication, type ApplicantIdentity, type WhitelistApplication } from "./applications.types";

const applicant: ApplicantIdentity = {
  userId: "123456789012345678",
  displayName: "Discord member",
  csrf: "applicant-csrf",
};
const staff: Staff = { id: "234567890123456789", name: "Reviewer", role: "admin", csrf: "staff-csrf" };
const applicationId = randomUUID();
const input = {
  steamId: "76561198123456789",
  email: "member@example.test",
  contactConsent: true,
  rulesAccepted: true,
  relationship: "unc_member",
};
const record = (overrides: Partial<WhitelistApplication> = {}): WhitelistApplication => ({
  id: applicationId,
  serverId: "primary",
  discordUserId: applicant.userId,
  discordDisplayName: applicant.displayName,
  steamId: input.steamId,
  email: input.email,
  emailVerified: false,
  steamOwnershipVerified: false,
  relationship: "unc_member",
  contactConsent: true,
  consentVersion: "whitelist-application-contact-v1-2026-09-30",
  contactConsentAt: new Date(),
  rulesAcceptedAt: new Date(),
  status: "pending",
  submittedAt: new Date(),
  updatedAt: new Date(),
  reviewedAt: null,
  reviewedBy: null,
  reviewReason: null,
  actionId: null,
  reviewId: null,
  reviewKind: null,
  lastActionState: null,
  lastActionMessage: null,
  accessIntent: "grant",
  whitelistGrant: null,
  revokedAt: null,
  ...overrides,
});

function fixture(
  options: {
    enabled?: boolean;
    emailRequired?: boolean;
    initial?: WhitelistApplication | null;
    result?: ActionResult;
    /** SteamIDs active on the running whitelist. A pending request is not live unless a test says so. */
    live?: string[];
    /** WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED */
    confirmExisting?: boolean;
  } = {},
) {
  let current = options.initial === undefined ? record() : options.initial;
  const live = new Set(options.live ?? (current && current.status !== "pending" ? [current.steamId] : []));
  const store = {
    create: jest.fn(async (values) => record(values)),
    own: jest.fn(async () => current ?? undefined),
    list: jest.fn(async () => (current ? [current] : [])),
    get: jest.fn(async (_id, serverId) => (current?.serverId === serverId ? { ...current } : undefined)),
    finishRecheck: jest.fn(async (previous, review, actor, outcome) => {
      if (!current || current.status !== previous.status || current.reviewId !== previous.reviewId)
        throw new ConflictException("Application changed during the check");
      const revoke = current.accessIntent === "revoke";
      current = record({
        ...current,
        status: outcome.state === "applied" ? (revoke ? "revoked" : "approved") : "needs_review",
        revokedAt: revoke && outcome.state === "applied" ? new Date() : current.revokedAt,
        reviewId: review.id,
        reviewKind: "recheck",
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        reviewReason: review.reason,
        lastActionState: outcome.state,
        lastActionMessage: outcome.message,
      });
      return current;
    }),
    claim: jest.fn(async (_id, review, kind, actor) => {
      if (!current || current.status !== "pending") return { claimed: false, application: current ?? undefined };
      current = record({
        ...current,
        status: kind === "decline" ? "declined" : "processing",
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        reviewReason: review.reason,
        actionId: review.id,
        reviewId: review.id,
        reviewKind: kind,
        lastActionState: kind === "decline" ? "applied" : "started",
        lastActionMessage:
          kind === "approve" ? "Approval started." : "Application declined. No whitelist change was sent.",
      });
      return { claimed: true, application: { ...current } };
    }),
    finishApproval: jest.fn(async (_id, actionId, outcome, grant?: "granted" | "existing" | null) => {
      if (current?.status !== "processing" || current.reviewId !== actionId) throw new Error("Application changed");
      current = record({
        ...current!,
        status: outcome.state === "applied" ? "approved" : "needs_review",
        whitelistGrant: outcome.state === "applied" ? (grant ?? null) : null,
        lastActionState: outcome.state,
        lastActionMessage: outcome.message,
      });
      return current;
    }),
    claimRevoke: jest.fn(async (_id, review, actor) => {
      if (
        !current ||
        !(current.status === "approved" || (current.status === "needs_review" && current.accessIntent === "revoke"))
      )
        return { claimed: false, application: current ?? undefined };
      current = record({
        ...current,
        status: "revoking",
        accessIntent: "revoke",
        reviewedBy: actor.id,
        reviewReason: review.reason,
        reviewId: review.id,
        reviewKind: "revoke",
        lastActionState: "started",
        lastActionMessage: "Revocation started.",
      });
      return { claimed: true, application: { ...current } };
    }),
    finishRevoke: jest.fn(async (_id, actionId, outcome: ActionResult) => {
      if (current?.status !== "revoking" || current.reviewId !== actionId) throw new Error("Application changed");
      const removed = outcome.state === "applied" || outcome.state === "pending";
      current = record({
        ...current,
        status: removed ? "revoked" : outcome.state === "failed" ? "approved" : "needs_review",
        accessIntent: outcome.state === "failed" ? "grant" : "revoke",
        revokedAt: removed ? new Date() : null,
        lastActionState: outcome.state,
        lastActionMessage: outcome.message,
      });
      return current;
    }),
    recordExternalRevoke: jest.fn(async (_removal: WhitelistRemoval) =>
      current?.status === "approved" ? [record({ ...current, status: "revoked", accessIntent: "revoke" })] : [],
    ),
  };
  const admin = {
    whitelistRemovals: new Subject<WhitelistRemoval>(),
    read: jest.fn(
      async (_resource: string, _serverId?: string): Promise<unknown> => ({
        entries: [...live].map((steamId) => ({ steamId, active: true, configured: true })),
        configurationAvailable: true,
      }),
    ),
    act: jest.fn(async (_actor: Staff, action: { action: string; steamId: string }) => {
      const result = options.result ?? { state: "applied", message: "Whitelist access is active in the running game." };
      if (result.state === "applied") {
        if (action.action === "whitelist-add") live.add(action.steamId);
        else live.delete(action.steamId);
      }
      return { id: randomUUID(), ...result };
    }),
  };
  const roles = { applicationChanged: jest.fn() };
  const match = { applicationChanged: jest.fn(async (_discordUserId: unknown) => undefined) };
  const env = {
    get: jest.fn((key: string) =>
      key === "WHITELIST_APPLICATIONS_ENABLED"
        ? options.enabled !== false
        : key === "WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED"
          ? options.confirmExisting === true
          : options.emailRequired !== false,
    ),
  };
  const game = {
    whitelist: jest.fn(async () => ({
      entries: [...live].map((steamId) => ({ steamId, active: true, configured: true as boolean | null })),
      configurationAvailable: true,
    })),
  };
  const servers = fixtureServers(game);
  return {
    service: new ApplicationsService(
      store as unknown as ApplicationsStore,
      admin as unknown as AdminService,
      env as unknown as EnvService,
      servers,
      roles as unknown as DiscordRolesService,
      match as unknown as SupporterMatchService,
    ),
    store,
    match,
    admin,
    game,
    servers,
    roles,
    live,
    current: () => current,
  };
}

describe("private website whitelist requests", () => {
  it("returns configured joining details without exposing connection metadata or reading the game", async () => {
    const { service, servers, game } = fixture();
    const joinId = "11111111-1111-4111-8111-111111111111";
    jest.spyOn(servers, "list").mockReturnValue([
      { id: "primary", name: "The UNCs", version: "private-connection-hash", joinId },
      { id: "event", name: "Events", version: "other-connection-hash" },
    ]);
    const get = jest.spyOn(servers, "get");
    expect((await service.me(applicant)).servers).toEqual([
      { id: "primary", name: "The UNCs", joinId },
      { id: "event", name: "Events" },
    ]);
    expect(get).not.toHaveBeenCalled();
    expect(game.whitelist).not.toHaveBeenCalled();
  });
  it("stores Discord identity only from authentication and keeps claims unverified", async () => {
    const { service, store } = fixture();
    const result = await service.submit(applicant, input);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        discordUserId: applicant.userId,
        discordDisplayName: applicant.displayName,
        steamId: input.steamId,
        relationship: "unc_member",
        emailVerified: false,
        steamOwnershipVerified: false,
        status: "pending",
        contactConsent: true,
        contactConsentAt: expect.any(Date),
      }),
    );
    expect(result.application).not.toHaveProperty("reviewReason");
    expect(result.application).not.toHaveProperty("discordUserId");
  });
  it.each([
    { ...input, email: undefined },
    { ...input, contactConsent: false },
    { ...input, email: "invalid email" },
    { ...input, rulesAccepted: false },
    { ...input, relationship: "admin" },
    { ...input, discordUserId: staff.id },
    { ...input, emailVerified: true },
    { ...input, status: "approved" },
  ])("rejects missing consent or forged claims without storing data (%#)", async (body) => {
    const { service, store } = fixture();
    await expect(service.submit(applicant, body)).rejects.toMatchObject({ status: 400 });
    expect(store.create).not.toHaveBeenCalled();
  });
  it("reads only the authenticated member's application and omits staff review notes", async () => {
    const { service, store } = fixture({
      initial: record({ reviewReason: "Private staff note", reviewedBy: staff.id }),
    });
    const result = await service.me(applicant);
    expect(store.own).toHaveBeenCalledWith(applicant.userId, "primary");
    expect(result).toMatchObject({ userId: applicant.userId, csrf: applicant.csrf, emailRequired: true });
    expect(JSON.stringify(result)).not.toContain("Private staff note");
    expect(result.application).not.toHaveProperty("reviewedBy");
  });
  it("returns a generic duplicate response without identifying another applicant", async () => {
    const { service, store } = fixture();
    store.create.mockResolvedValueOnce(undefined as never);
    await expect(service.submit(applicant, input)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("matching application"),
    });
  });
  it("bounds valid submission attempts for each authenticated identity", async () => {
    const { service, store } = fixture();
    for (let count = 0; count < 5; count++) await service.submit(applicant, input);
    await expect(service.submit(applicant, input)).rejects.toMatchObject({ status: 429 });
    expect(store.create).toHaveBeenCalledTimes(5);
  });
  it("keeps every route disabled by policy until explicitly enabled", async () => {
    const { service, store, admin } = fixture({ enabled: false });
    await expect(service.me(applicant)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("check back on this website"),
    });
    await expect(service.submit(applicant, input)).rejects.toMatchObject({ status: 503 });
    await expect(service.list(staff)).resolves.toEqual({ enabled: false, serverId: "primary", applications: [] });
    await expect(service.list({ ...staff, role: "moderator" })).rejects.toMatchObject({ status: 403 });
    await expect(
      service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Reviewed" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.own).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
  });
  it.each(["moderator", "viewer"] as const)("does not disclose contacts or permit decisions to %s", async (role) => {
    const { service, store, admin } = fixture();
    const actor = { ...staff, role };
    await expect(service.list(actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      service.review(actor, applicationId, "approve", { id: randomUUID(), reason: "Reviewed" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.list).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
  });
});

describe("durable application decisions", () => {
  it.each(["applied", "accepted", "pending", "unknown", "failed"] as const)(
    "records game outcome %s without overstating approval",
    async (state) => {
      const { service, store, admin } = fixture({ result: { state, message: `Game result: ${state}` } });
      const review = { id: randomUUID(), reason: "Application reviewed" };
      const result = await service.review(staff, applicationId, "approve", review);
      expect(result.application.status).toBe(state === "applied" ? "approved" : "needs_review");
      expect(admin.act).toHaveBeenCalledWith(
        { ...staff, serverId: "primary" },
        {
          id: review.id,
          serverId: "primary",
          reason: `Website whitelist application ${applicationId} approved.`,
          action: "whitelist-add",
          steamId: input.steamId,
        },
      );
      expect(store.claim.mock.invocationCallOrder[0]).toBeLessThan(admin.act.mock.invocationCallOrder[0]);
      expect(JSON.stringify(admin.act.mock.calls)).not.toContain(input.email);
      expect(JSON.stringify(admin.act.mock.calls)).not.toContain("unc_member");
      expect(JSON.stringify(admin.act.mock.calls)).not.toContain(review.reason);
    },
  );
  it("allows only one concurrent approval claim to reach the game", async () => {
    const { service, admin } = fixture();
    const results = await Promise.allSettled([
      service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "First reviewer" }),
      service.review({ ...staff, id: "345678901234567890" }, applicationId, "approve", {
        id: randomUUID(),
        reason: "Second reviewer",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("returns a recorded same-ID outcome without replaying the whitelist mutation", async () => {
    const { service, admin } = fixture();
    const review = { id: randomUUID(), reason: "Reviewed request" };
    const first = await service.review(staff, applicationId, "approve", review);
    const repeat = await service.review(staff, applicationId, "approve", review);
    expect(repeat.outcome.state).toBe(first.outcome.state);
    expect(repeat.application.actionId).toBe(review.id);
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("does not replay an uncertain approval even when a new action ID is supplied", async () => {
    const { service, admin } = fixture({ result: { state: "unknown", message: "Readback failed" } });
    await service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Reviewed request" });
    await expect(
      service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Try again" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("requires recording the review before sending anything to the game", async () => {
    const { service, store, admin } = fixture();
    store.claim.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(
      service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Reviewed request" }),
    ).rejects.toThrow();
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("keeps failed completion persistence unresolved rather than claiming approval", async () => {
    const { service, store, admin } = fixture();
    store.finishApproval.mockRejectedValueOnce(new Error("Database unavailable"));
    const result = await service.review(staff, applicationId, "approve", {
      id: randomUUID(),
      reason: "Reviewed request",
    });
    expect(result.application.status).toBe("processing");
    expect(result.outcome.state).toBe("unknown");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost approval completion by reading access without sending the grant again", async () => {
    const { service, store, admin, game } = fixture();
    const approvalId = randomUUID();
    store.finishApproval.mockRejectedValueOnce(new Error("Database unavailable"));
    await service.review(staff, applicationId, "approve", { id: approvalId, reason: "Reviewed request" });
    const result = await service.review(staff, applicationId, "recheck", {
      id: randomUUID(),
      reason: "Check live result",
    });
    expect(result.application).toMatchObject({ status: "approved", actionId: approvalId, reviewKind: "recheck" });
    // One read before approving, one for the recheck.
    expect(game.whitelist).toHaveBeenCalledTimes(2);
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("records a thrown game-service error for manual review without retrying", async () => {
    const { service, admin } = fixture();
    admin.act.mockRejectedValueOnce(new Error("secret upstream detail"));
    const result = await service.review(staff, applicationId, "approve", {
      id: randomUUID(),
      reason: "Reviewed request",
    });
    expect(result.application.status).toBe("needs_review");
    expect(result.outcome.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("secret upstream detail");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("declines locally with durable actor and reason metadata and no RCON action", async () => {
    const { service, admin } = fixture();
    const review = { id: randomUUID(), reason: "Identity needs staff discussion" };
    const result = await service.review(staff, applicationId, "decline", review);
    expect(result.application).toMatchObject({
      status: "declined",
      reviewedBy: staff.id,
      reviewReason: review.reason,
      actionId: review.id,
    });
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("will not decline a request after an uncertain whitelist action", async () => {
    const { service, store } = fixture({ initial: record({ status: "needs_review", actionId: randomUUID() }) });
    await expect(
      service.review(staff, applicationId, "decline", { id: randomUUID(), reason: "Decline" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.finishApproval).not.toHaveBeenCalled();
  });
  it("rejects attempts to replace the stored target through the approval body", async () => {
    const { service, store } = fixture();
    await expect(
      service.review(staff, applicationId, "approve", {
        id: randomUUID(),
        reason: "Reviewed",
        steamId: "76561198000000000",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.claim).not.toHaveBeenCalled();
  });
  it("rechecks an unresolved request without sending another whitelist mutation", async () => {
    const approvalId = randomUUID();
    const { service, admin, game } = fixture({
      initial: record({ status: "needs_review", actionId: approvalId, reviewId: approvalId, reviewKind: "approve" }),
    });
    const request = { id: randomUUID(), reason: "Check live result" };
    const result = await service.review(staff, applicationId, "recheck", request);
    expect(result.application).toMatchObject({
      status: "approved",
      actionId: approvalId,
      reviewId: request.id,
      reviewKind: "recheck",
    });
    expect(game.whitelist).toHaveBeenCalledTimes(1);
    expect(admin.act).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "leaves an unresolved request for review when runtime access is absent or unreadable (%s)",
    async (unreadable) => {
      const { service, admin, game } = fixture({ initial: record({ status: "needs_review", actionId: randomUUID() }) });
      if (unreadable) game.whitelist.mockRejectedValueOnce(new Error("offline"));
      else
        game.whitelist.mockResolvedValueOnce({
          entries: [{ steamId: input.steamId, active: false, configured: true }],
          configurationAvailable: true,
        });
      const result = await service.review(staff, applicationId, "recheck", {
        id: randomUUID(),
        reason: "Check live result",
      });
      expect(result.application.status).toBe("needs_review");
      expect(result.outcome.state).toBe(unreadable ? "unknown" : "pending");
      expect(admin.act).not.toHaveBeenCalled();
    },
  );
  it.each(["pending", "approved", "declined"] as const)("does not recheck a %s application", async (status) => {
    const { service, game, admin } = fixture({ initial: record({ status, actionId: randomUUID() }) });
    await expect(
      service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check live result" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(game.whitelist).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("does not reuse an approval UUID as a readback decision", async () => {
    const { service, game } = fixture();
    const request = { id: randomUUID(), reason: "Reviewed request" };
    await service.review(staff, applicationId, "approve", request);
    await expect(service.review(staff, applicationId, "recheck", request)).rejects.toMatchObject({ status: 409 });
    // Only the pre-approval read; the refused recheck reads nothing.
    expect(game.whitelist).toHaveBeenCalledTimes(1);
  });
  it("leaves a failed recheck save recoverable and replays a saved recheck without another game read", async () => {
    const { service, store, game, admin, current } = fixture({ initial: record({ status: "processing" }) });
    store.finishRecheck.mockRejectedValueOnce(new Error("Database unavailable"));
    const failed = await service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check access" });
    expect(failed.outcome.state).toBe("unknown");
    expect(current()?.status).toBe("processing");
    const request = { id: randomUUID(), reason: "Check access" };
    const recovered = await service.review(staff, applicationId, "recheck", request);
    expect(recovered.application.status).toBe("approved");
    expect(await service.review(staff, applicationId, "recheck", request)).toEqual(recovered);
    expect(game.whitelist).toHaveBeenCalledTimes(2);
    expect(admin.act).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
  });
  it("rejects a stale readback when the original approval completes during its game read", async () => {
    const { service, store, game, admin, current } = fixture();
    const approvalId = randomUUID();
    store.finishApproval.mockRejectedValueOnce(new Error("Completion deferred"));
    await service.review(staff, applicationId, "approve", { id: approvalId, reason: "Reviewed" });
    game.whitelist.mockImplementationOnce(async () => {
      await store.finishApproval(applicationId, approvalId, { state: "applied", message: "Original completion" });
      return { entries: [], configurationAvailable: true };
    });
    await expect(
      service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check access" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(current()).toMatchObject({
      status: "approved",
      reviewId: approvalId,
      lastActionMessage: "Original completion",
    });
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("never reads the game or returns contacts when rechecking another server's application", async () => {
    const { service, game, admin, store } = fixture({ initial: record({ status: "processing", serverId: "event" }) });
    await expect(
      service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check access" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.get).toHaveBeenCalledWith(applicationId, "primary");
    expect(game.whitelist).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
  });
});

describe("automatic supporter matching after a review", () => {
  it.each([
    ["a grant", {}, {}],
    ["a confirmed existing entry", { live: [input.steamId] }, { existingAccessConfirmed: true as const }],
  ])("asks for a match after the role check when %s is approved", async (_name, options, extra) => {
    const { service, roles, match } = fixture(options);
    const result = await service.review(staff, applicationId, "approve", {
      id: randomUUID(),
      reason: "Approve",
      ...extra,
    });
    expect(result.application.status).toBe("approved");
    expect(match.applicationChanged).toHaveBeenCalledWith(applicant.userId);
    expect(roles.applicationChanged.mock.invocationCallOrder[0]).toBeLessThan(
      match.applicationChanged.mock.invocationCallOrder[0],
    );
  });
  it("asks for a match when a recheck confirms an approval", async () => {
    const { service, match } = fixture({ initial: record({ status: "needs_review" }), live: [input.steamId] });
    const result = await service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check" });
    expect(result.application.status).toBe("approved");
    expect(match.applicationChanged).toHaveBeenCalledWith(applicant.userId);
  });
  it("does not ask after a decline, an approval that needs review, a revocation or a Whitelist page removal", async () => {
    const declined = fixture();
    await declined.service.review(staff, applicationId, "decline", { id: randomUUID(), reason: "Decline" });
    const unclear = fixture({ result: { state: "unknown", message: "Not confirmed" } });
    await unclear.service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Approve" });
    expect(unclear.current()?.status).toBe("needs_review");
    const revoked = fixture({ initial: record({ status: "approved", whitelistGrant: "granted" }) });
    await revoked.service.review(staff, applicationId, "revoke", { id: randomUUID(), reason: "Left" });
    expect(revoked.current()?.status).toBe("revoked");
    const removed = fixture({ initial: record({ status: "approved" }) });
    removed.service.onModuleInit();
    removed.admin.whitelistRemovals.next({
      actionId: randomUUID(),
      serverId: "primary",
      steamId: input.steamId,
      actorId: staff.id,
      actorName: staff.name,
      state: "applied",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(removed.store.recordExternalRevoke).toHaveBeenCalled();
    for (const { match } of [declined, unclear, revoked, removed])
      expect(match.applicationChanged).not.toHaveBeenCalled();
  });
  it("never lets matching change or delay the review result", async () => {
    const throwing = fixture();
    throwing.match.applicationChanged.mockImplementation(() => {
      throw new Error("match unavailable");
    });
    await expect(
      throwing.service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Approve" }),
    ).resolves.toMatchObject({ application: { status: "approved" }, outcome: { state: "applied" } });
    const slow = fixture();
    slow.match.applicationChanged.mockImplementation(() => new Promise(() => undefined));
    await expect(
      slow.service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Approve" }),
    ).resolves.toMatchObject({ outcome: { state: "applied" } });
  });
});

describe("existing whitelist members", () => {
  it("approves an already whitelisted SteamID with the normal grant when confirmation is not required", async () => {
    // The current dashboard sends only {id, reason}; approval must not be stuck behind a 409 it cannot answer.
    const { service, admin, roles } = fixture({ live: [input.steamId] });
    const result = await service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Approve" });
    expect(result.application).toMatchObject({ status: "approved", whitelistGrant: null });
    expect(admin.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "whitelist-add" }));
    expect(roles.applicationChanged).toHaveBeenCalledWith(applicant.userId);
  });
  it("registers a confirmed existing entry without a grant whether or not confirmation is required", async () => {
    const { service, admin } = fixture({ live: [input.steamId] });
    const result = await service.review(staff, applicationId, "approve", {
      id: randomUUID(),
      reason: "Registering existing member",
      existingAccessConfirmed: true,
    });
    expect(result.application).toMatchObject({ status: "approved", whitelistGrant: "existing" });
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("refuses to approve an already whitelisted SteamID until staff confirm ownership, and sends no grant", async () => {
    const { service, store, admin, roles } = fixture({ live: [input.steamId], confirmExisting: true });
    const review = { id: randomUUID(), reason: "Registering existing member" };
    await expect(service.review(staff, applicationId, "approve", review)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already on the running whitelist"),
    });
    expect(store.claim).not.toHaveBeenCalled();
    const result = await service.review(staff, applicationId, "approve", { ...review, existingAccessConfirmed: true });
    expect(result.application).toMatchObject({ status: "approved", whitelistGrant: "existing" });
    expect(result.outcome).toMatchObject({ state: "applied", message: expect.stringContaining("No whitelist change") });
    expect(store.finishApproval).toHaveBeenCalledWith(applicationId, review.id, expect.any(Object), "existing");
    expect(admin.act).not.toHaveBeenCalled();
    expect(roles.applicationChanged).toHaveBeenCalledWith(applicant.userId);
  });
  it("grants normally when the SteamID is not live, recording the grant", async () => {
    const { service, admin, roles } = fixture();
    const result = await service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Approve" });
    expect(result.application).toMatchObject({ status: "approved", whitelistGrant: "granted" });
    expect(admin.act).toHaveBeenCalledTimes(1);
    expect(roles.applicationChanged).toHaveBeenCalledWith(applicant.userId);
  });
  it("falls back to the normal grant when the running whitelist cannot be read, recording no grant", async () => {
    // A configuration-edit build reports an entry that was already saved as applied, so "granted" would claim a
    // grant that may not have changed anything.
    const { service, admin, game, store } = fixture({ live: [input.steamId] });
    game.whitelist.mockRejectedValueOnce(new Error("offline"));
    const review = { id: randomUUID(), reason: "Approve" };
    const result = await service.review(staff, applicationId, "approve", review);
    expect(admin.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "whitelist-add" }));
    expect(store.finishApproval).toHaveBeenCalledWith(applicationId, review.id, expect.any(Object), null);
    expect(result.application).toMatchObject({ status: "approved", whitelistGrant: null });
  });
  it("never lets the confirmation approve a request automatically or reveal access to the applicant", async () => {
    const { service, admin, store } = fixture({ live: [input.steamId] });
    await expect(service.me(applicant)).resolves.toMatchObject({ application: { status: "pending" } });
    const view = await service.me(applicant);
    expect(view.application).not.toHaveProperty("whitelistGrant");
    expect(view.application).not.toHaveProperty("whitelistState");
    expect(store.claim).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("annotates unresolved requests with their live whitelist state and survives a failed read", async () => {
    const { service, admin, store } = fixture({ live: [input.steamId] });
    await expect(service.list(staff)).resolves.toMatchObject({ applications: [{ whitelistState: "active" }] });
    admin.read.mockResolvedValueOnce({ entries: [{ steamId: input.steamId, active: false, configured: true }] });
    await expect(service.list(staff)).resolves.toMatchObject({ applications: [{ whitelistState: "saved" }] });
    admin.read.mockResolvedValueOnce({ entries: [] });
    await expect(service.list(staff)).resolves.toMatchObject({ applications: [{ whitelistState: "absent" }] });
    admin.read.mockRejectedValueOnce(new Error("offline"));
    await expect(service.list(staff)).resolves.toMatchObject({ applications: [{ whitelistState: "unknown" }] });
    admin.read.mockResolvedValueOnce({ unexpected: true });
    await expect(service.list(staff)).resolves.toMatchObject({ applications: [{ whitelistState: "unknown" }] });
    expect(admin.read).toHaveBeenCalledWith("whitelist", "primary");
    store.list.mockResolvedValueOnce([record({ status: "approved" })]);
    admin.read.mockClear();
    await expect(service.list(staff)).resolves.toMatchObject({ applications: [{ whitelistState: null }] });
    expect(admin.read).not.toHaveBeenCalled();
  });
});

describe("revoking whitelist access", () => {
  const approved = () => record({ status: "approved", actionId: randomUUID(), reviewId: randomUUID() });
  it.each([
    ["applied", "revoked"],
    ["pending", "revoked"],
    ["failed", "approved"],
    ["unknown", "needs_review"],
  ] as const)("records a %s removal as %s", async (state, status) => {
    const { service, admin, store, roles } = fixture({
      initial: approved(),
      result: { state, message: `Game: ${state}` },
    });
    const request = { id: randomUUID(), reason: "Left the community" };
    const result = await service.review(staff, applicationId, "revoke", request);
    expect(result.application.status).toBe(status);
    expect(store.claimRevoke.mock.invocationCallOrder[0]).toBeLessThan(admin.act.mock.invocationCallOrder[0]);
    expect(admin.act).toHaveBeenCalledWith(
      { ...staff, serverId: "primary" },
      {
        id: request.id,
        serverId: "primary",
        action: "whitelist-remove",
        steamId: input.steamId,
        confirm: input.steamId,
        reason: `Website whitelist application ${applicationId} revoked.`,
      },
    );
    if (state === "failed") {
      expect(result.application.accessIntent).toBe("grant");
      expect(result.outcome.message).toContain("The game refused the revocation; access unchanged.");
    }
    expect(JSON.stringify(admin.act.mock.calls)).not.toContain(request.reason);
    expect(roles.applicationChanged).toHaveBeenCalledWith(applicant.userId);
  });
  it("keeps an uncertain revocation for review after a thrown game error, without retrying", async () => {
    const { service, admin } = fixture({ initial: approved() });
    admin.act.mockRejectedValueOnce(new Error("secret upstream detail"));
    const result = await service.review(staff, applicationId, "revoke", { id: randomUUID(), reason: "Left" });
    expect(result.application).toMatchObject({ status: "needs_review", accessIntent: "revoke" });
    expect(JSON.stringify(result)).not.toContain("secret upstream detail");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it.each(["pending", "declined", "processing"] as const)("does not revoke a %s application", async (status) => {
    const { service, admin } = fixture({ initial: record({ status }) });
    await expect(
      service.review(staff, applicationId, "revoke", { id: randomUUID(), reason: "Revoke" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("rechecks an uncertain revocation by reading the running whitelist only", async () => {
    const { service, admin, game, live } = fixture({
      initial: record({ status: "needs_review", accessIntent: "revoke", reviewId: randomUUID() }),
      live: [input.steamId],
    });
    const still = await service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check" });
    expect(still.application.status).toBe("needs_review");
    expect(still.outcome.message).toContain("Still active; revoke again or check the host panel");
    live.clear();
    const gone = await service.review(staff, applicationId, "recheck", { id: randomUUID(), reason: "Check" });
    expect(gone.application.status).toBe("revoked");
    expect(game.whitelist).toHaveBeenCalledTimes(2);
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("allows revoking again after an uncertain revocation", async () => {
    const { service, admin } = fixture({
      initial: record({ status: "needs_review", accessIntent: "revoke", reviewId: randomUUID() }),
    });
    const result = await service.review(staff, applicationId, "revoke", { id: randomUUID(), reason: "Retry" });
    expect(result.application.status).toBe("revoked");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["an approved application", () => approved()],
    [
      "a revocation left uncertain",
      () => record({ status: "needs_review", accessIntent: "revoke", reviewId: randomUUID() }),
    ],
  ])(
    "records a refused removal of %s as revoked when the SteamID is already gone from the running whitelist",
    async (_label, initial) => {
      // DELETE /v1/reserved-slots/{id} refuses an absent ID with 404 reserved_not_found, which arrives as "failed".
      const { service, admin, game, roles } = fixture({
        initial: initial(),
        live: [],
        result: { state: "failed", message: "That SteamID is not in the running whitelist. Refresh the list." },
      });
      const result = await service.review(staff, applicationId, "revoke", { id: randomUUID(), reason: "Left" });
      expect(result.application).toMatchObject({ status: "revoked", accessIntent: "revoke" });
      expect(result.outcome).toMatchObject({
        state: "applied",
        message: expect.stringContaining("no longer on the running whitelist"),
      });
      expect(game.whitelist).toHaveBeenCalledTimes(1);
      expect(admin.act).toHaveBeenCalledTimes(1);
      expect(roles.applicationChanged).toHaveBeenCalledWith(applicant.userId);
    },
  );
  it("keeps a refused revocation for review when the running whitelist cannot be read afterwards", async () => {
    const { service, admin, game } = fixture({
      initial: approved(),
      result: { state: "failed", message: "That SteamID is not in the running whitelist. Refresh the list." },
    });
    game.whitelist.mockRejectedValueOnce(new Error("offline"));
    const result = await service.review(staff, applicationId, "revoke", { id: randomUUID(), reason: "Left" });
    expect(result.application).toMatchObject({ status: "needs_review", accessIntent: "revoke" });
    expect(result.outcome.state).toBe("unknown");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("logs a fixed warning without the database error text when a Whitelist page removal cannot be recorded", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { service, admin, store } = fixture({ initial: approved() });
      service.onModuleInit();
      store.recordExternalRevoke.mockRejectedValueOnce(
        new Error(
          `Failed query: update "whitelist_applications" set "reviewed_by" = $1\nparams: ${staff.id},${staff.name},${input.steamId}`,
        ),
      );
      const actionId = randomUUID();
      admin.whitelistRemovals.next({
        serverId: "primary",
        steamId: input.steamId,
        actionId,
        actorId: staff.id,
        actorName: staff.name,
        state: "applied",
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain(actionId);
      expect(message).not.toContain(input.steamId);
      expect(message).not.toContain(staff.id);
      expect(message).not.toContain("Failed query");
      service.onModuleDestroy();
    } finally {
      warn.mockRestore();
    }
  });
  it("revokes the matching approved application when staff remove its SteamID on the Whitelist page", async () => {
    const { service, admin, store, roles } = fixture({ initial: approved() });
    service.onModuleInit();
    const removal: WhitelistRemoval = {
      serverId: "primary",
      steamId: input.steamId,
      actionId: randomUUID(),
      actorId: staff.id,
      actorName: staff.name,
      state: "applied",
    };
    admin.whitelistRemovals.next(removal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.recordExternalRevoke).toHaveBeenCalledWith(removal);
    expect(roles.applicationChanged).toHaveBeenCalledWith(applicant.userId);
    // A storage failure is logged, never thrown back into the whitelist action.
    store.recordExternalRevoke.mockRejectedValueOnce(new Error("Database unavailable"));
    expect(() => admin.whitelistRemovals.next(removal)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    service.onModuleDestroy();
    admin.whitelistRemovals.next(removal);
    expect(store.recordExternalRevoke).toHaveBeenCalledTimes(2);
  });
  it("shows a revocation in progress to the applicant as processing, and a finished one as revoked", () => {
    expect(ownApplication(record({ status: "revoking" }))?.status).toBe("processing");
    expect(ownApplication(record({ status: "revoked", whitelistGrant: "existing" }))).toMatchObject({
      status: "revoked",
    });
    expect(ownApplication(record({ whitelistGrant: "existing" }))).not.toHaveProperty("whitelistGrant");
    expect(ownApplication(record({ accessIntent: "revoke" }))).not.toHaveProperty("accessIntent");
  });
});
