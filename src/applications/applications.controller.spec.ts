import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminApiController, AdminExceptionFilter } from "../admin/admin.controller";
import { AdminAuth, AdminGuard } from "../admin/admin.auth";
import { AdminService } from "../admin/admin.service";
import { WardogsClient } from "../admin/wardogs.client";
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

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      // Deliberately register the existing controller first. Its old generic
      // resource route would steal the applications endpoint in this order.
      controllers: [AdminApiController, StaffApplicationsController, ApplicantApiController, ApplicantAuthController],
      providers: [
        ApplicationsService,
        AdminGuard,
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
        { provide: WardogsClient, useValue: {} },
        { provide: AdminAuth, useValue: { authenticate: async () => staff } },
        { provide: ApplicantAuth, useValue: { authenticate: async () => identity } },
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

  it("routes the administrator applications list separately from existing resources", async () => {
    const response = await request(app.getHttpServer()).get("/admin/api/applications").expect(200);
    expect(response.body).toEqual({ applications: [privateRow] });
    expect(admin.read).not.toHaveBeenCalled();
    expect(store.list).toHaveBeenCalledTimes(1);
  });
  it.each(["overview", "bans", "whitelist", "catalog", "rotation", "audit"])(
    "preserves the explicit existing %s route",
    async (resource) => {
      const response = await request(app.getHttpServer()).get(`/admin/api/${resource}`).expect(200);
      expect(response.body).toEqual({ resource });
      expect(admin.read).toHaveBeenCalledWith(resource);
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
    expect(store.own).toHaveBeenCalledWith(identity.userId);
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
  it("returns the Discord fallback while applications are disabled", async () => {
    enabled = false;
    const response = await request(app.getHttpServer()).get("/apply/api/me").expect(503);
    expect(response.body.message).toContain("discord.gg/t5NSzurtRS");
    await request(app.getHttpServer()).get("/admin/api/applications").expect(503);
    expect(store.own).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });
});
