import { ConflictException } from "@nestjs/common";
import { MessageFlags } from "discord.js";
import type { ButtonContext } from "necord";
import { MapVotesComponent } from "./map-votes.component";
import { MapVotesService } from "../../map-votes/map-votes.service";
function fixture() {
  const service = {
    cast: jest.fn().mockResolvedValue({ selection: { map: "Europe", experiences: ["KOTH"] }, closeAtScore: 95 }),
  };
  const component = new MapVotesComponent(service as unknown as MapVotesService);
  const interaction = {
    deferReply: jest.fn(),
    editReply: jest.fn(),
    inCachedGuild: () => true,
    member: { pending: false },
    user: { id: "123456789012345678", bot: false },
    guildId: "guild",
    channelId: "channel",
    message: { id: "message" },
  };
  const context = [interaction] as unknown as ButtonContext;
  return { component, service, interaction, context };
}
it("acknowledges privately before saving the vote and privately confirms the chosen map", async () => {
  const { component, service, interaction, context } = fixture();
  await component.vote(context, "vote", "0");
  expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(service.cast.mock.invocationCallOrder[0]);
  expect(service.cast).toHaveBeenCalledWith("vote", "0", interaction.user.id, "guild", "channel", "message", true);
  expect(interaction.editReply).toHaveBeenCalledWith({
    content: "Your vote is now Ozeti · King of the Hill. You can choose again until it closes at 95 points.",
    allowedMentions: { parse: [] },
  });
});
it("names the community map, not its catalog ID, and the 50v50 option", async () => {
  const { component, service, interaction, context } = fixture();
  service.cast.mockResolvedValue({ selection: { map: "Kavkazi", experiences: [] }, closeAtScore: 90 });
  await component.vote(context, "vote", "0");
  expect(interaction.editReply.mock.calls[0][0].content).toContain("Bakurani");
  expect(interaction.editReply.mock.calls[0][0].content).not.toContain("Kavkazi");
  service.cast.mockResolvedValue({
    selection: { map: "NorthAmerica", experiences: ["KOTH"], event: "50v50" },
    closeAtScore: 95,
  });
  await component.vote(context, "vote", "1");
  expect(interaction.editReply.mock.calls[1][0].content).toContain("Zestafona · King of the Hill · 50v50");
  service.cast.mockResolvedValue({ selection: { map: "Europe", experiences: [] }, closeAtScore: null });
  await component.vote(context, "vote", "1");
  expect(interaction.editReply.mock.calls[2][0].content).toContain("until the ballot closes");
});
it.each(["screening", "bot", "outside_guild"])("refuses eligibility for %s", async (reason) => {
  const { component, service, interaction, context } = fixture();
  if (reason === "screening") interaction.member.pending = true;
  if (reason === "bot") interaction.user.bot = true;
  if (reason === "outside_guild") interaction.inCachedGuild = () => false;
  await component.vote(context, "vote", "0");
  expect(service.cast.mock.calls[0].at(-1)).toBe(false);
});
it.each([new Error("postgres://private-credential"), new ConflictException("Ballot is closed.")])(
  "returns a safe private error",
  async (error) => {
    const { component, service, interaction, context } = fixture();
    service.cast.mockRejectedValue(error);
    await component.vote(context, "vote", "0");
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain("postgres");
  },
);
