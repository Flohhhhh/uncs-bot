import {
  ForbiddenException,
  Module,
  type ExecutionContext,
  UnauthorizedException,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Request, Response } from "express";
import request from "supertest";
import { AdminApiController, AdminGameController, AdminExceptionFilter } from "../admin/admin.controller";
import { AdminAuth, AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { AdminModule } from "../admin/admin.module";
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
import { ApplicationsModule } from "./applications.module";
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

  it("returns mixed-case sign-in paths to the website like lowercase ones", async () => {
    applicantAuth.callback.mockRejectedValueOnce(new UnauthorizedException("Expired OAuth state"));
    const callback = await request(app.getHttpServer()).get("/Apply/Auth/Callback?code=private-code").expect(303);
    expect(callback.headers.location).toBe("/whitelist?auth=sign_in");
    expect(callback.text).not.toMatch(/private|Expired/);
    enabled = false;
    const login = await request(app.getHttpServer()).get("/APPLY/AUTH/LOGIN?server=event").expect(303);
    expect(login.headers.location).toBe("/whitelist?auth=unavailable&server=event");
  });

  it("routes the administrator applications list separately from existing resources", async () => {
    const response = await request(app.getHttpServer()).get("/admin/api/applications").expect(200);
    expect(response.body).toEqual({ enabled: true, serverId: "primary", applications: [privateRow] });
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
    expect(store.own).not.toHaveBeenCalled();
  });
  it("tells an administrator that applications are off without reading or reviewing records", async () => {
    enabled = false;
    const list = await request(app.getHttpServer()).get("/admin/api/servers/primary/applications").expect(200);
    expect(list.body).toEqual({ enabled: false, serverId: "primary", applications: [] });
    for (const decision of ["approve", "decline", "recheck"]) {
      const review = await request(app.getHttpServer())
        .post(`/admin/api/servers/primary/applications/${privateRow.id}/${decision}`)
        .send({ id: privateRow.id, reason: "Reviewed" })
        .expect(503);
      expect(review.body.message).toContain("not open yet");
    }
    staff.role = "moderator";
    await request(app.getHttpServer()).get("/admin/api/servers/primary/applications").expect(403);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
  });
});

describe("staff application review traffic limit", () => {
  let app: INestApplication;
  const service = { list: jest.fn(async () => []), review: jest.fn(async () => ({ ok: true })), me: jest.fn() };
  @Module({
    controllers: [ApplicantApiController, StaffApplicationsController],
    providers: [ApplicationsExceptionFilter, { provide: ApplicationsService, useValue: service }],
  })
  class ReviewAndApply implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      new AdminModule(new HttpAdapterHost()).configure(consumer);
      new ApplicationsModule().configure(consumer);
    }
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [ReviewAndApply] })
      .overrideGuard(ApplicationsEnabledGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ApplicantGuard)
      .useValue({
        canActivate: () => {
          throw new UnauthorizedException("Sign in with Discord to continue.");
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<StaffRequest>();
          req.staff = { id: "234567890123456789", name: "Reviewer", role: "admin", csrf: "csrf" };
          return true;
        },
      })
      .overrideGuard(AdminServerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0);
  });
  afterAll(async () => app.close());

  it("keeps anonymous applicant traffic from one proxy address out of staff review", async () => {
    const server = app.getHttpServer();
    for (let count = 0; count < 180; count++) await request(server).get("/apply/api/me").expect(401);
    await request(server).get("/apply/api/me").expect(429);
    await request(server).get("/admin/api/servers/primary/applications").expect(200);
    await request(server).post("/admin/api/applications/x/approve").send({}).expect(201);
    expect(service.review).toHaveBeenCalledTimes(1);
  });

  it("still counts staff review routes in the dashboard's own /admin limit", async () => {
    const server = app.getHttpServer();
    // The previous test's two staff requests already count.
    for (let count = 2; count < 600; count++) await request(server).get("/admin/api/applications").expect(200);
    const refused = await request(server).get("/admin/api/applications").expect(429);
    expect(refused.body.message).toBe("Too many dashboard requests. Try again in a minute.");
  });
});

describe("applicant sign-in traffic limit", () => {
  let app: INestApplication;
  const signIn = jest.fn((_req: Request, res: Response) => res.status(204).end());
  @Module({
    controllers: [ApplicantAuthController],
    providers: [ApplicationsExceptionFilter, { provide: ApplicantAuth, useValue: { login: signIn, callback: signIn } }],
  })
  class SignInOnly implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      new ApplicationsModule().configure(consumer);
    }
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [SignInOnly] })
      .overrideGuard(ApplicationsEnabledGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => app.close());

  it("counts mixed-case sign-in paths against the sign-in limit, not the larger API limit", async () => {
    for (let count = 0; count < 30; count++) await request(app.getHttpServer()).get("/apply/auth/login").expect(204);
    await request(app.getHttpServer()).get("/APPLY/AUTH/LOGIN").expect(429);
    await request(app.getHttpServer()).get("/Apply/Auth/Callback?code=junk").expect(429);
    expect(signIn).toHaveBeenCalledTimes(30);
  });
});
