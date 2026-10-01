import { randomUUID } from "node:crypto";
import { ApplicationsService } from "./applications.service";
import type { ApplicationsStore } from "./applications.store";
import type { AdminService } from "../admin/admin.service";
import type { EnvService } from "../env/env.service";
import type { ActionResult, Staff } from "../admin/admin.types";
import { fixtureServers } from "../admin/game-server-fixture";
import type { ApplicantIdentity, WhitelistApplication } from "./applications.types";

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
  ...overrides,
});

function fixture(
  options: {
    enabled?: boolean;
    emailRequired?: boolean;
    initial?: WhitelistApplication | null;
    result?: ActionResult;
  } = {},
) {
  let current = options.initial === undefined ? record() : options.initial;
  const store = {
    create: jest.fn(async (values) => record(values)),
    own: jest.fn(async () => current ?? undefined),
    list: jest.fn(async () => (current ? [current] : [])),
    claim: jest.fn(async (_id, review, kind, actor) => {
      if (!current || current.status !== (kind === "recheck" ? "needs_review" : "pending"))
        return { claimed: false, application: current ?? undefined };
      current = record({
        ...current,
        status: kind === "decline" ? "declined" : "processing",
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        reviewReason: review.reason,
        actionId: kind === "recheck" ? current.actionId : review.id,
        reviewId: review.id,
        reviewKind: kind,
        lastActionState: kind === "decline" ? "applied" : "started",
        lastActionMessage:
          kind === "approve" ? "Approval started." : "Application declined. No whitelist change was sent.",
      });
      return { claimed: true, application: { ...current } };
    }),
    finishApproval: jest.fn(async (_id, _actionId, outcome) => {
      current = record({
        ...current!,
        status: outcome.state === "applied" ? "approved" : "needs_review",
        lastActionState: outcome.state,
        lastActionMessage: outcome.message,
      });
      return current;
    }),
  };
  const admin = {
    act: jest.fn(async () => ({
      id: randomUUID(),
      ...(options.result ?? { state: "applied", message: "Whitelist access is active in the running game." }),
    })),
  };
  const env = {
    get: jest.fn((key: string) =>
      key === "WHITELIST_APPLICATIONS_ENABLED" ? options.enabled !== false : options.emailRequired !== false,
    ),
  };
  const game = {
    whitelist: jest.fn(async () => ({
      entries: [{ steamId: input.steamId, active: true, configured: true }],
      configurationAvailable: true,
    })),
  };
  return {
    service: new ApplicationsService(
      store as unknown as ApplicationsStore,
      admin as unknown as AdminService,
      env as unknown as EnvService,
      fixtureServers(game),
    ),
    store,
    admin,
    game,
    current: () => current,
  };
}

describe("private website whitelist requests", () => {
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
    await expect(service.list(staff)).rejects.toMatchObject({ status: 503 });
    await expect(
      service.review(staff, applicationId, "approve", { id: randomUUID(), reason: "Reviewed" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.own).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
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
  it("does not recheck an approval still processing", async () => {
    const { service, game, admin } = fixture({ initial: record({ status: "processing", actionId: randomUUID() }) });
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
    expect(game.whitelist).not.toHaveBeenCalled();
  });
});
