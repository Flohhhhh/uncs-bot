import { Logger } from "@nestjs/common";
import { ChannelType, Client } from "discord.js";
import { StaffAlerts } from "./staff-alerts.service";
import type { EnvService } from "../env/env.service";

const guild = "234567890123456789",
  alerts = "345678901234567890",
  votes = "456789012345678901",
  community = "567890123456789012";
function fixture(environment: Record<string, unknown> = {}) {
  const channel = {
    type: ChannelType.GuildText,
    guildId: guild,
    send: jest.fn().mockResolvedValue({ id: "message" }),
  };
  const client = { isReady: () => true, channels: { fetch: jest.fn().mockResolvedValue(channel) } };
  const env: Record<string, unknown> = {
    ADMIN_GUILD_ID: guild,
    STAFF_ALERTS_CHANNEL_ID: alerts,
    MAP_VOTES_CHANNEL_ID: votes,
    SERVER_COMMUNITY_DISCORD_CHANNEL_ID: community,
    ...environment,
  };
  const service = new StaffAlerts(client as unknown as Client, { get: (key: string) => env[key] } as EnvService);
  return { service, channel, client };
}

describe("staff alerts", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it("posts once per issue without mentions, then again after 30 minutes", async () => {
    const { service, channel, client } = fixture();
    expect(await service.send("primary", "review:1", "Ballot @everyone needs review.\nCheck it.")).toBe(true);
    expect(client.channels.fetch).toHaveBeenCalledWith(alerts);
    expect(channel.send).toHaveBeenCalledWith({
      content: "**Gramps staff alert** · Ballot @everyone needs review. Check it.",
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    });
    expect(await service.send("primary", "review:1", "Again")).toBe(false);
    expect(await service.send("event", "review:1", "Other server")).toBe(true);
    jest.setSystemTime(now + 30 * 60_000);
    expect(await service.send("primary", "review:1", "Still waiting")).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(4);
  });
  it("sends at most ten alerts per server per hour", async () => {
    const { service, channel } = fixture();
    for (let index = 0; index < 12; index++) await service.send("primary", `issue:${index}`, "Alert");
    expect(channel.send).toHaveBeenCalledTimes(10);
    jest.setSystemTime(now + 60 * 60_000 + 1);
    expect(await service.send("primary", "issue:12", "Alert")).toBe(true);
  });
  it.each([
    ["unset", { STAFF_ALERTS_CHANNEL_ID: undefined }],
    ["no community guild", { ADMIN_GUILD_ID: undefined }],
    ["the voting channel", { STAFF_ALERTS_CHANNEL_ID: votes }],
    ["the community channel", { STAFF_ALERTS_CHANNEL_ID: community }],
    [
      "a server status channel",
      { WARDOGS_SERVERS: [{ communityStatus: { channelId: alerts, messageId: "678901234567890123" } }] },
    ],
  ])("only logs when the alert channel is %s", async (_, environment) => {
    const { service, channel, client } = fixture(environment);
    expect(await service.send("primary", "issue", "Needs review")).toBe(false);
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining("Needs review"));
  });
  it("never throws into a worker when Discord fails or the channel is elsewhere", async () => {
    const failing = fixture();
    failing.channel.send.mockRejectedValue(new Error("token and network details"));
    await expect(failing.service.send("primary", "issue", "Needs review")).resolves.toBe(false);
    const elsewhere = fixture();
    elsewhere.channel.guildId = "999999999999999999";
    await expect(elsewhere.service.send("primary", "issue", "Needs review")).resolves.toBe(false);
    expect(elsewhere.channel.send).not.toHaveBeenCalled();
  });
});
