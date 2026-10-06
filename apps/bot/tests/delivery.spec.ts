import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Client } from "discord.js";
import { DeliveryController } from "../src/internal/delivery.controller";
import { InternalGuard } from "../src/internal/transport";
import { DiscordRolesDiscord } from "../src/discord-roles/discord-roles.discord";
import { MapVotesDiscord } from "../src/map-votes/map-votes.discord";
import { WeeklyLeaderboardDiscord } from "../src/weekly-leaderboard/weekly-leaderboard.discord";
import { StaffAlertsDiscord } from "../src/staff-alerts/staff-alerts.discord";
const guildId = "100000000000000001",
  userId = "200000000000000001",
  roleId = "300000000000000001",
  token = "b".repeat(40);
describe("bot delivery boundary", () => {
  let app: INestApplication;
  const add = jest.fn(),
    remove = jest.fn();
  beforeEach(async () => {
    process.env.API_TO_BOT_TOKEN = token;
    process.env.BOT_GATEWAY_ENABLED = "true";
    process.env.ADMIN_GUILD_ID = guildId;
    process.env.DISCORD_MEMBER_ROLE_ID = roleId;
    add.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      controllers: [DeliveryController],
      providers: [
        InternalGuard,
        { provide: Client, useValue: { isReady: () => true } },
        {
          provide: DiscordRolesDiscord,
          useValue: { member: async () => ({ id: userId, joinedAt: null, has: () => false, add, remove }) },
        },
        { provide: MapVotesDiscord, useValue: {} },
        { provide: WeeklyLeaderboardDiscord, useValue: {} },
        {
          provide: StaffAlertsDiscord,
          useValue: { channelCheck: async () => ({ state: "missing", channel: null }), pingState: () => "off" },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    for (const key of ["API_TO_BOT_TOKEN", "BOT_GATEWAY_ENABLED", "ADMIN_GUILD_ID", "DISCORD_MEMBER_ROLE_ID"])
      delete process.env[key];
  });
  it("does not accept API-direction credentials, browser cookies, or malformed DTOs", async () => {
    const body = { guildId, userId, roleId, reason: "Earned role", operationId: "ledger-1" };
    await request(app.getHttpServer())
      .post("/internal/v1/roles/add")
      .set("Authorization", `Bearer ${"a".repeat(40)}`)
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .post("/internal/v1/roles/add")
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", "session=x")
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .post("/internal/v1/roles/add")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...body, role: "admin" })
      .expect(400);
    expect(add).not.toHaveBeenCalled();
  });
  it("suppresses duplicate ledger writes", async () => {
    const body = { guildId, userId, roleId, reason: "Earned role", operationId: "ledger-1" };
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post("/internal/v1/roles/add")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(201)
        .expect({ ok: true });
    expect(add).toHaveBeenCalledTimes(1);
  });
  it("preserves an unknown delivery outcome without retrying", async () => {
    add.mockRejectedValue(new Error("Network response lost after Discord accepted"));
    const body = { guildId, userId, roleId, reason: "Earned role", operationId: "ledger-1" };
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post("/internal/v1/roles/add")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(503)
        .expect(({ body }) => expect(body.outcome).toBe("unknown"));
    expect(add).toHaveBeenCalledTimes(1);
  });
  it("refuses delivery when gateway control is disabled", async () => {
    process.env.BOT_GATEWAY_ENABLED = "false";
    await request(app.getHttpServer())
      .post("/internal/v1/roles/add")
      .set("Authorization", `Bearer ${token}`)
      .send({ guildId, userId, roleId, reason: "Earned role", operationId: "ledger-1" })
      .expect(503);
    expect(add).not.toHaveBeenCalled();
  });
});
