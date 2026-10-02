import { ForbiddenException, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminApiController, AdminGameController, AdminExceptionFilter } from "../admin/admin.controller";
import { AdminAuth, AdminGuard, AdminServerGuard } from "../admin/admin.auth";
import { AdminService } from "../admin/admin.service";
import { GameServers } from "../admin/game-servers";
import { fixtureServers } from "../admin/game-server-fixture";
import type { Staff } from "../admin/admin.types";
import { EnvService } from "../env/env.service";
import { ApplicantAuth } from "./applicant.auth";
import {
  ApplicantApiController,
  ApplicantAuthController,
  ApplicantGuard,
  ApplicationsEnabledGuard,
  ApplicationsExceptionFilter,
  StaffApplicationsController,
} from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { ApplicationsStore } from "./applications.store";

describe("application HTTP routing and privacy", () => {
  let app: INestApplication;
  let staff: Staff;
  let enabled: boolean;
  const identity = { userId: "123456789012345678", displayName: "Member", csrf: "applicant-csrf" };
  const privateRow = {
    id: "d96766a5-7bda-4920-9623-8b26908e5115",
    discordUserId: identity.userId,
    email: "private@example.test",
    steamId: "76561198123456789",
    reviewReason: "Private staff note",
    reviewedBy: "Reviewer",
    status: "pending",
  };
  const store = {
    list: jest.fn(async () => [privateRow]),
    own: jest.fn(async () => privateRow),
    create: jest.fn(),
    claim: jest.fn(),
    finishApproval: jest.fn(),
  };
  const admin = { read: jest.fn(async (resource: string) => ({ resource })), act: jest.fn() };
  const applicantAuth = { authenticate: async () => identity, login: jest.fn(), callback: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      // Deliberately register the existing controller first. Its old generic
      // resource route would steal the applications endpoint in this order.
      controllers: [
        AdminApiController,
        AdminGameController,
        StaffApplicationsController,
        ApplicantApiController,
        ApplicantAuthController,
      ],
      providers: [
        ApplicationsService,
        AdminGuard,
        AdminServerGuard,
        ApplicantGuard,
        ApplicationsEnabledGuard,
        ApplicationsExceptionFilter,
        AdminExceptionFilter,
        { provide: ApplicationsStore, useValue: store },
        { provide: AdminService, useValue: admin },
        {
          provide: EnvService,
          useValue: { get: (key: string) => (key === "WHITELIST_APPLICATIONS_ENABLED" ? enabled : true) },
        },
        { provide: GameServers, useValue: fixtureServers({}) },
        {
          provide: AdminAuth,
          useValue: {
            authenticate: async () => staff,
            serverStaff: async (actor: Staff, serverId: string) => ({ ...actor, serverId }),
          },
        },
        { provide: ApplicantAuth, useValue: applicantAuth },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    enabled = true;
    staff = { id: "234567890123456789", name: "Reviewer", role: "admin", csrf: "csrf" };
  });
  afterAll(async () => app.close());

  it.each([
    [new UnauthorizedException("Expired OAuth state"), "sign_in"],
    [new ForbiddenException("Membership screening pending"), "discord_access"],
    [new Error("private upstream details"), "unavailable"],
  ])("returns failed browser sign-in to the application without private details: %p", async (error, code) => {
    applicantAuth.callback.mockRejectedValueOnce(error);
    const response = await request(app.getHttpServer())
      .get("/apply/auth/callback?code=private-oauth-code&state=private-state&redirect=https://example.org")
      .expect(303);
    expect(response.headers.location).toBe(`/whitelist?auth=${code}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).not.toMatch(/private-|screening/);
  });

  it("returns disabled login to the website while keeping disabled API requests as JSON errors", async () => {
    enabled = false;
    const response = await request(app.getHttpServer()).get("/apply/auth/login").expect(303);
    expect(response.headers.location).toBe("/whitelist?auth=unavailable");
    const api = await request(app.getHttpServer()).get("/apply/api/me").expect(503);
    expect(api.headers.location).toBeUndefined();
    expect(api.body.message).toBeDefined();
  });
  it("retains a valid login target when applications are disabled, but never adopts callback targets", async () => {
    enabled = false;
    const login = await request(app.getHttpServer()).get("/apply/auth/login?server=event").expect(303);
    expect(login.headers.location).toBe("/whitelist?auth=unavailable&server=event");
    const callback = await request(app.getHttpServer())
      .get("/apply/auth/callback?server=event&code=private-code")
      .expect(303);
    expect(callback.headers.location).toBe("/whitelist?auth=unavailable");
    const unsafe = await request(app.getHttpServer()).get("/apply/auth/login?server=%2F%2Fevil.example").expect(303);
    expect(unsafe.headers.location).toBe("/whitelist?auth=unavailable");
  });

  it("keeps a verified OAuth server on the error redirect without copying callback input", async () => {
    applicantAuth.callback.mockImplementationOnce(async (_req, res) => {
      res.locals.applicantServer = "event";
      throw new ForbiddenException("Membership screening pending");
    });
    const response = await request(app.getHttpServer())
      .get("/apply/auth/callback?server=primary&code=private&redirect=https://evil.example")
      .expect(303);
    expect(response.headers.location).toBe("/whitelist?auth=discord_access&server=event");
    expect(response.text).not.toMatch(/private|evil|primary/);
  });

  it("routes the administrator applications list separately from existing resources", async () => {
    const response = await request(app.getHttpServer()).get("/admin/api/applications").expect(200);
    expect(response.body).toEqual({ serverId: "primary", applications: [privateRow] });
    expect(admin.read).not.toHaveBeenCalled();
    expect(store.list).toHaveBeenCalledTimes(1);
  });
  it.each(["overview", "bans", "whitelist", "catalog", "rotation", "audit"])(
    "preserves the explicit existing %s route",
    async (resource) => {
      const response = await request(app.getHttpServer()).get(`/admin/api/${resource}`).expect(200);
      expect(response.body).toEqual({ resource });
      expect(admin.read).toHaveBeenCalledWith(resource, "primary");
    },
  );
  it.each(["moderator", "viewer"] as const)("does not send private contact data to %s", async (role) => {
    staff.role = role;
    const response = await request(app.getHttpServer()).get("/admin/api/applications").expect(403);
    expect(JSON.stringify(response.body)).not.toContain(privateRow.email);
    expect(store.list).not.toHaveBeenCalled();
  });
  it("ignores an attempted identity selector and returns only the signed-in applicant's public projection", async () => {
    const response = await request(app.getHttpServer()).get("/apply/api/me?userId=999999999999999999").expect(200);
    expect(store.own).toHaveBeenCalledWith(identity.userId, "primary");
    expect(response.body.userId).toBe(identity.userId);
    expect(response.body.emailRequired).toBe(true);
    expect(response.body.application).not.toHaveProperty("reviewReason");
    expect(response.body.application).not.toHaveProperty("reviewedBy");
  });
  it("offers no public application-ID lookup route", async () => {
    await request(app.getHttpServer()).get(`/apply/api/applications/${privateRow.id}`).expect(404);
    expect(store.own).not.toHaveBeenCalled();
  });
  it("rejects forged Discord identity fields on submission", async () => {
    await request(app.getHttpServer())
      .post("/apply/api/request")
      .send({
        steamId: privateRow.steamId,
        email: "member@example.test",
        contactConsent: true,
        rulesAccepted: true,
        relationship: "unc_member",
        discordUserId: staff.id,
      })
      .expect(400);
    expect(store.create).not.toHaveBeenCalled();
  });
  it("keeps application data unavailable while applications are disabled", async () => {
    enabled = false;
    const response = await request(app.getHttpServer()).get("/apply/api/me").expect(503);
    expect(response.body.message).toContain("this website");
    expect(response.body.message).not.toContain("discord.gg");
    await request(app.getHttpServer()).get("/admin/api/applications").expect(503);
    expect(store.own).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });
});
