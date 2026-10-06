import type { SlashCommandContext } from "necord";
import { ServerCommandHandler } from "../src/commands/handlers/server.command";
import type { SeedingBusiness } from "../src/seeding/seeding.business";
it("acknowledges before reading the API's join ID and retains the public mention behavior", async () => {
  const business = { load: jest.fn(async () => ({ server: { joinId: "isolated-game-id" } })) };
  const interaction = { deferReply: jest.fn(), editReply: jest.fn() };
  const handler = new ServerCommandHandler(business as unknown as SeedingBusiness);
  await handler.handleInfo([interaction] as unknown as SlashCommandContext, { user: undefined });
  expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(business.load.mock.invocationCallOrder[0]);
  expect(interaction.editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain("isolated-game-id");
});
