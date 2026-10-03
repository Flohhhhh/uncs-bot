import { MessageFlags } from "discord.js";
import type { ButtonContext } from "necord";
import type { SeedingService } from "../../seeding/seeding.service";
import { SeedingComponent } from "./seeding.component";

const REQUEST = { guildId: "200000000000000001", userId: "500000000000000001", channelId: "400000000000000002" };

function fixture() {
  const service = { join: jest.fn().mockResolvedValue("joined"), leave: jest.fn().mockResolvedValue("left") };
  const component = new SeedingComponent(service as unknown as SeedingService);
  const interaction = {
    guildId: REQUEST.guildId,
    channelId: REQUEST.channelId,
    user: { id: REQUEST.userId },
    deferReply: jest.fn(),
    editReply: jest.fn(),
    update: jest.fn(),
  };
  const context = [interaction] as unknown as ButtonContext;
  return { component, service, interaction, context };
}

it.each([
  ["join", "joined"],
  ["leave", "left"],
] as const)("the %s button does what /seeding %s does, privately", async (action, text) => {
  const { component, service, interaction, context } = fixture();
  await component[action](context);
  expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(service[action].mock.invocationCallOrder[0]);
  expect(service[action]).toHaveBeenCalledWith(REQUEST);
  expect(interaction.editReply).toHaveBeenCalledWith({ content: text, allowedMentions: { parse: [] } });
  expect(interaction.update).not.toHaveBeenCalled();
});

it("leaves the shared panel message untouched", async () => {
  const { component, interaction, context } = fixture();
  await component.join(context);
  await component.leave(context);
  expect(interaction.update).not.toHaveBeenCalled();
});
