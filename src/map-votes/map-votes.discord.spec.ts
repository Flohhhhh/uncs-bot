import { ChannelType, Client } from "discord.js";
import { ballotMessage, MapVotesDiscord } from "./map-votes.discord";
import type { MapVoteRecord } from "./map-votes.types";
import { mapVoteView } from "./map-votes.types";
const record: MapVoteRecord = {
  id: "d0a3cdd7-a1c7-4904-a99e-cf058b432c34",
  serverId: "primary",
  serverName: "@everyone **The UNCs**",
  connectionHash: "private connection hash",
  guildId: "123456789012345678",
  channelId: "234567890123456789",
  messageId: "345678901234567890",
  actorId: "456789012345678901",
  actorName: "Private staff name",
  reason: "Private review reason",
  requestHash: "private hash",
  choices: [
    { map: "Europe", experiences: ["InfantryOnly"], lighting: "Dusk" },
    { map: "Islands", experiences: [] },
  ],
  revision: "r1",
  currentMap: "Kavkazi",
  currentIndex: 0,
  roundStartedAt: null,
  state: "open",
  winner: null,
  counts: [0, 0],
  createdAt: new Date(),
  closesAt: new Date(),
  updatedAt: new Date(),
  message: "Voting is open.",
  cancellation: null,
};
function fixture() {
  const message = { id: record.messageId, author: { id: "bot" }, edit: jest.fn() };
  const channel = {
    name: "map-voting",
    type: ChannelType.GuildText,
    guildId: record.guildId,
    permissionsFor: jest.fn().mockReturnValue({ has: () => true }),
    send: jest.fn().mockResolvedValue(message),
    messages: { fetch: jest.fn().mockResolvedValue(message) },
  };
  const client = {
    isReady: () => true,
    user: { id: "bot" },
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
  };
  return { service: new MapVotesDiscord(client as unknown as Client), client, channel, message };
}
it("shows choices and voting rules without private staff evidence or pinging members", () => {
  const payload = ballotMessage(record);
  expect(payload.content).toContain("Ozeti");
  expect(payload.content).toContain("InfantryOnly Dusk");
  expect(payload.components[0].toJSON().components[0]).toMatchObject({ label: "1. Ozeti · InfantryOnly · Dusk" });
  expect(payload.content).toContain("A tie or no votes keeps the rotation");
  expect(payload.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
  expect(JSON.stringify(payload)).not.toContain("Private");
  expect(JSON.stringify(payload)).not.toContain(record.requestHash);
  expect(payload.components[0].toJSON().components.every((button) => !button.disabled)).toBe(true);
});
it("disables closed buttons and reports the winner and counts", () => {
  const payload = ballotMessage({
    ...record,
    state: "queued",
    counts: [2, 3],
    winner: 1,
    message: "Winning map queued.",
  });
  expect(payload.content).toContain("Winner: Islands");
  expect(payload.content).toContain("3 votes");
  expect(payload.components[0].toJSON().components.every((button) => button.disabled)).toBe(true);
});
it.each(["cancelled", "needs_review"] as const)("does not present an uncounted %s ballot as zero votes", (state) => {
  const vote = { ...record, state };
  expect(ballotMessage(vote).content).not.toContain("0 votes");
  expect(mapVoteView(vote).counted).toBe(false);
  expect(mapVoteView({ ...record, state: "no_votes" }).counted).toBe(true);
});
it("uses a stable nonce for Discord's duplicate-send protection", async () => {
  const { service, channel } = fixture();
  await service.publish(record);
  await service.publish(record);
  const first = channel.send.mock.calls[0][0],
    second = channel.send.mock.calls[1][0];
  expect(first.enforceNonce).toBe(true);
  expect(first.nonce).toBe(second.nonce);
  expect(first.nonce.length).toBeLessThanOrEqual(25);
});
it("distinguishes two modes on the same map and sends totals without mentions or exposing staff data", async () => {
  const { service, channel } = fixture();
  const vote = {
    ...record,
    choices: [
      { map: "Europe", experiences: ["KOTH"] },
      { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] },
    ],
    counts: [4, 7],
  };
  const buttons = ballotMessage(vote).components[0].toJSON().components;
  expect(buttons[0]).toMatchObject({ label: "1. Ozeti · King of the Hill" });
  expect(buttons[1]).toMatchObject({ label: "2. Ozeti · Infantry only" });
  await service.remind(vote, "final");
  await service.remind(vote, "final");
  const first = channel.send.mock.calls[0][0];
  expect(first.content).toContain("4 votes");
  expect(first.content).toContain("7 votes");
  expect(first.content).toContain("11 votes so far");
  expect(first.content).toContain("Closes at 95 points");
  expect(first.allowedMentions.parse).toEqual([]);
  expect(first.nonce).toBe(channel.send.mock.calls[1][0].nonce);
  expect(JSON.stringify(first)).not.toContain("Private staff");
  expect(JSON.stringify(first)).not.toContain(record.connectionHash);
});
it("checks channel permissions without posting or editing a message", async () => {
  const { service, channel } = fixture();
  expect(await service.check(record.guildId, record.channelId)).toEqual({ name: "map-voting" });
  expect(channel.send).not.toHaveBeenCalled();
  expect(channel.messages.fetch).not.toHaveBeenCalled();
});
it("identifies the layout and lighting when choices share a map and mode", async () => {
  const { service, channel } = fixture();
  const vote = {
    ...record,
    choices: [
      {
        map: "Europe",
        experiences: ["KOTH", "KOTH_InfantryOnly"],
        lighting: "DayEarlyClear",
        zoneAlternator: "ZoneAlternator.Ozeti.Farmland.Circle",
      },
      {
        map: "Europe",
        experiences: ["KOTH", "KOTH_InfantryOnly"],
        lighting: "DayEarlyFog",
        zoneAlternator: "ZoneAlternator.Ozeti.Church.Circle",
      },
    ],
    counts: [4, 7],
  };
  const buttons = ballotMessage(vote).components[0].toJSON().components;
  expect(buttons[0]).toMatchObject({ label: expect.stringContaining("Farmland · Early day · clear") });
  expect(buttons[1]).toMatchObject({ label: expect.stringContaining("Church · Early day · fog") });
  await service.remind(vote, "final");
  expect(channel.send.mock.calls[0][0].content).toContain("Farmland");
  expect(channel.send.mock.calls[0][0].content).toContain("Church");
  const result = ballotMessage({ ...vote, state: "queued", winner: 1 });
  expect(result.content.split("Winner:")[1]).toContain("Church");
});
it.each(["guild", "channel_type", "permission", "missing", "not_ready"])(
  "refuses publication for %s",
  async (invalid) => {
    const { service, client, channel } = fixture();
    if (invalid === "guild") channel.guildId = "other";
    if (invalid === "channel_type") channel.type = ChannelType.DM;
    if (invalid === "permission") channel.permissionsFor.mockReturnValue({ has: () => false });
    if (invalid === "missing") client.channels.fetch.mockResolvedValue(null);
    if (invalid === "not_ready") client.isReady = () => false;
    await expect(service.publish(record)).rejects.toThrow();
    expect(channel.send).not.toHaveBeenCalled();
  },
);
it("edits only the saved bot-owned message and never creates a replacement", async () => {
  const { service, channel, message } = fixture();
  await service.update({ ...record, state: "cancelled" });
  expect(channel.messages.fetch).toHaveBeenCalledWith(record.messageId);
  expect(message.edit).toHaveBeenCalledTimes(1);
  message.author.id = "other";
  await expect(service.update(record)).rejects.toThrow("author");
  await service.update({ ...record, messageId: null });
  expect(message.edit).toHaveBeenCalledTimes(1);
  expect(channel.send).not.toHaveBeenCalled();
});
