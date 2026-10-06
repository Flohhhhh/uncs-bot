import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Client } from "discord.js";
import { ServiceCallError } from "@uncs/api-client";
import { DiscordRolesDiscord as ApiRoles } from "../src/discord-roles/discord-roles.discord";
import { RemoteService } from "../src/internal/transport";
// Test-only imports exercise both sides of the real HTTP boundary; production imports are independently checked.
import { DeliveryController } from "../../bot/src/internal/delivery.controller";
import { InternalGuard } from "../../bot/src/internal/transport";
import { DiscordRolesDiscord as BotRoles } from "../../bot/src/discord-roles/discord-roles.discord";
import { MapVotesDiscord } from "../../bot/src/map-votes/map-votes.discord";
import { WeeklyLeaderboardDiscord } from "../../bot/src/weekly-leaderboard/weekly-leaderboard.discord";
import { StaffAlertsDiscord } from "../../bot/src/staff-alerts/staff-alerts.discord";

const guildId = "100000000000000001",
  userId = "200000000000000001",
  roleId = "300000000000000001";
describe("API to bot authenticated HTTP integration", () => {
  let bot: INestApplication;
  let api: ApiRoles;
  const add = jest.fn(),
    remove = jest.fn();
  beforeEach(async () => {
    process.env.API_TO_BOT_TOKEN = "b".repeat(40);
    process.env.BOT_GATEWAY_ENABLED = "true";
    process.env.ADMIN_GUILD_ID = guildId;
    process.env.DISCORD_MEMBER_ROLE_ID = roleId;
    add.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
    const member = {
      id: userId,
      joinedAt: new Date("2026-10-05T12:00:00Z"),
      pending: false,
      user: { bot: false },
      roles: { cache: new Map([[roleId, {}]]) },
    };
    const module = await Test.createTestingModule({
      controllers: [DeliveryController],
      providers: [
        InternalGuard,
        {
          provide: Client,
          useValue: {
            isReady: () => true,
            guilds: { fetch: async () => ({ members: { fetch: async () => member } }) },
          },
        },
        { provide: BotRoles, useValue: { member: async () => ({ ...member, add, remove }) } },
        { provide: MapVotesDiscord, useValue: {} },
        { provide: WeeklyLeaderboardDiscord, useValue: {} },
        { provide: StaffAlertsDiscord, useValue: {} },
      ],
    }).compile();
    bot = module.createNestApplication();
    await bot.listen(0, "127.0.0.1");
    process.env.BOT_ORIGIN = await bot.getUrl();
    api = new ApiRoles(new RemoteService());
  });
  afterEach(async () => {
    await bot.close();
    for (const key of [
      "API_TO_BOT_TOKEN",
      "BOT_GATEWAY_ENABLED",
      "ADMIN_GUILD_ID",
      "DISCORD_MEMBER_ROLE_ID",
      "BOT_ORIGIN",
    ])
      delete process.env[key];
  });
  it("validates metadata, revives dates, and forwards a stable ledger ID once", async () => {
    expect(await api.ready()).toBe(true);
    const member = await api.member(guildId, userId);
    expect(member?.joinedAt).toEqual(new Date("2026-10-05T12:00:00Z"));
    expect(member?.has(roleId)).toBe(true);
    await member!.add(roleId, "Earned", "existing-ledger-id");
    await member!.add(roleId, "Earned", "existing-ledger-id");
    expect(add).toHaveBeenCalledTimes(1);
  });
  it("does not send again after a lost Discord response", async () => {
    add.mockRejectedValue(new Error("Accepted, response unavailable"));
    const member = await api.member(guildId, userId);
    for (let index = 0; index < 2; index++)
      await expect(member!.add(roleId, "Earned", "existing-ledger-id")).rejects.toMatchObject({ outcome: "unknown" });
    expect(add).toHaveBeenCalledTimes(1);
  });
  it("rejects the opposite credential and reports an outage without writing", async () => {
    expect(await api.ready()).toBe(true);
    process.env.API_TO_BOT_TOKEN = "a".repeat(40);
    expect(await api.ready()).toBe(false);
    await expect(api.member(guildId, userId)).rejects.toBeInstanceOf(ServiceCallError);
    expect(add).not.toHaveBeenCalled();
    await bot.close();
    expect(await new ApiRoles(new RemoteService()).ready()).toBe(false);
  });
});
