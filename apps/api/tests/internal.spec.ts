import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { BusinessController } from "../src/internal/business.controller";
import { InternalGuard } from "../src/internal/transport";
import { AdminSettings } from "../src/admin/admin.settings";
import { EnvService } from "../src/env/env.service";
import { WelcomeService } from "../src/welcome/welcome.service";
import { MapVotesService } from "../src/map-votes/map-votes.service";
import { DiscordRolesService } from "../src/discord-roles/discord-roles.service";
import { PatronLinkService } from "../src/patron-link/patron-link.service";
import { GameServers } from "../src/admin/game-servers";
const guildId = "100000000000000001",
  userId = "200000000000000001",
  interactionId = "300000000000000001",
  channelId = "400000000000000001";
const context = { guildId, userId, interactionId, channelId };
const token = "a".repeat(40);
describe("API internal business boundary", () => {
  let app: INestApplication;
  const welcome = {
    getSettings: jest.fn(async () => ({ enabled: true, message: "Hello" })),
    setMessage: jest.fn(async () => ({ enabled: true, message: "Saved" })),
    setEnabled: jest.fn(),
  };
  const votes = { cast: jest.fn(async () => ({ selection: { map: "Europe", experiences: [] }, closeAtScore: 95 })) };
  const roles = { memberJoined: jest.fn() };
  const patron = { request: jest.fn(async () => ({ content: "Confirmed" })), panel: jest.fn() };
  let memberRoles: string[];
  beforeEach(async () => {
    process.env.BOT_TO_API_TOKEN = token;
    process.env.API_MUTATIONS_ENABLED = "true";
    process.env.API_WORKERS_ENABLED = "false";
    memberRoles = ["staff"];
    jest.clearAllMocks();
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        Response.json(
          String(url) === `https://discord.com/api/v10/guilds/${guildId}`
            ? { owner_id: "another-user" }
            : String(url).endsWith("/roles")
              ? [{ id: "staff", permissions: "32" }]
              : { roles: memberRoles, user: { id: userId, bot: false }, pending: false },
        ),
      );
    const module = await Test.createTestingModule({
      controllers: [BusinessController],
      providers: [
        InternalGuard,
        {
          provide: AdminSettings,
          useValue: {
            staffPolicy: () => ({ ownerIds: [], adminRoleIds: ["staff"], moderatorRoleIds: [], viewerRoleIds: [] }),
          },
        },
        {
          provide: EnvService,
          useValue: { get: (key: string) => ({ ADMIN_GUILD_ID: guildId, DISCORD_BOT_TOKEN: "simulation-token" })[key] },
        },
        { provide: WelcomeService, useValue: welcome },
        { provide: MapVotesService, useValue: votes },
        { provide: DiscordRolesService, useValue: roles },
        { provide: PatronLinkService, useValue: patron },
        { provide: GameServers, useValue: { list: () => [] } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    delete process.env.API_MUTATIONS_ENABLED;
    delete process.env.API_WORKERS_ENABLED;
    delete process.env.BOT_TO_API_TOKEN;
  });
  it("rejects cookies, wrong credentials, and supplied role claims", async () => {
    await request(app.getHttpServer()).post("/internal/v1/patreon/request").send(context).expect(401);
    await request(app.getHttpServer())
      .post("/internal/v1/patreon/request")
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", "session=x")
      .send(context)
      .expect(401);
    await request(app.getHttpServer())
      .post("/internal/v1/patreon/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...context, role: "admin" })
      .expect(400);
    expect(patron.request).not.toHaveBeenCalled();
  });
  it("reverifies staff roles rather than accepting the bot as authority", async () => {
    memberRoles = [];
    await request(app.getHttpServer())
      .post("/internal/v1/patreon/panel")
      .set("Authorization", `Bearer ${token}`)
      .send(context)
      .expect(403);
    expect(patron.panel).not.toHaveBeenCalled();
  });
  it("commits a welcome change once and keeps the confirmed result on duplicate requests", async () => {
    const body = { context, message: "Saved" };
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post("/internal/v1/welcome/settings")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(201)
        .expect({ enabled: true, message: "Saved" });
    expect(welcome.setMessage).toHaveBeenCalledTimes(1);
  });
  it("requires Manage Server for welcome writes", async () => {
    memberRoles = [];
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        Response.json(
          String(url) === `https://discord.com/api/v10/guilds/${guildId}`
            ? { owner_id: "another-user" }
            : String(url).endsWith("/roles")
              ? []
              : { roles: [], user: { id: userId }, pending: false },
        ),
      );
    await request(app.getHttpServer())
      .post("/internal/v1/welcome/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ context, message: "Saved" })
      .expect(403);
  });
  it("validates ballot context and deduplicates the interaction", async () => {
    const body = { context, id: "b250e67e-f93d-4605-b860-12f6e4a2be4a", choice: "0", messageId: channelId };
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post("/internal/v1/votes/cast")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(201);
    expect(votes.cast).toHaveBeenCalledTimes(1);
  });
  it("passive startup does not request member-join reconciliation or permit mutations", async () => {
    process.env.API_MUTATIONS_ENABLED = "false";
    await request(app.getHttpServer())
      .post("/internal/v1/roles/member-joined")
      .set("Authorization", `Bearer ${token}`)
      .send({ guildId, userId })
      .expect(201);
    expect(roles.memberJoined).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post("/internal/v1/welcome/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ context, message: "Saved" })
      .expect(403);
    expect(welcome.setMessage).not.toHaveBeenCalled();
  });
});
