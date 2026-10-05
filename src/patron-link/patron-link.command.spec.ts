import { Reflector } from "@nestjs/core";
import { InteractionContextType, MessageFlags } from "discord.js";
import { SlashCommand, Subcommand, type SlashCommandContext } from "necord";
import { PatronLinkCommand } from "./patron-link.command";
import type { PatronLinkService } from "./patron-link.service";

const REQUEST = {
  guildId: "200000000000000001",
  channelId: "400000000000000002",
  userId: "500000000000000001",
  bot: false,
  roles: ["300000000000000001"],
};

function fixture() {
  const service = {
    request: jest.fn().mockResolvedValue({ content: "link", components: ["row"] }),
    panel: jest.fn().mockResolvedValue("posted"),
  };
  const interaction = {
    guildId: REQUEST.guildId,
    channelId: REQUEST.channelId,
    user: { id: REQUEST.userId, bot: false },
    member: { roles: REQUEST.roles },
    deferReply: jest.fn(),
    editReply: jest.fn(),
    reply: jest.fn(),
  };
  const handler = new PatronLinkCommand(service as unknown as PatronLinkService);
  return { handler, service, interaction, context: [interaction] as unknown as SlashCommandContext };
}

describe("/patreon", () => {
  it.each([
    ["link", "handleLink", "request", { content: "link", components: ["row"] }],
    ["panel", "handlePanel", "panel", { content: "posted" }],
  ] as const)(
    "%s acknowledges privately first, then answers privately without pings",
    async (_name, method, call, reply) => {
      const { handler, service, interaction, context } = fixture();
      await handler[method](context);
      expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
        service[call].mock.invocationCallOrder[0],
      );
      expect(service[call]).toHaveBeenCalledWith(REQUEST);
      expect(interaction.editReply).toHaveBeenCalledWith({ ...reply, allowedMentions: { parse: [] } });
      expect(interaction.reply).not.toHaveBeenCalled();
    },
  );

  it("is one guild-only command with link and panel, and no default permission gate", () => {
    const reflector = new Reflector();
    const root = reflector.get(SlashCommand, PatronLinkCommand);
    for (const method of ["handleLink", "handlePanel"] as const) {
      const subcommand = reflector.get(Subcommand, PatronLinkCommand.prototype[method]);
      subcommand.setDiscoveryMeta({ class: PatronLinkCommand, handler: PatronLinkCommand.prototype[method] });
      root.setSubcommand(subcommand);
    }
    const command = root.toJSON() as unknown as {
      name: string;
      description: string;
      contexts?: InteractionContextType[];
      defaultMemberPermissions?: unknown;
      options: { name: string; description: string }[];
    };
    expect(command).toMatchObject({ name: "patreon", contexts: [InteractionContextType.Guild] });
    expect(command.defaultMemberPermissions).toBeUndefined();
    expect(command.options.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "link", description: "Link your Patreon to this Discord account" },
      { name: "panel", description: "Admins: post the Link Patreon button here" },
    ]);
    for (const description of [command.description, ...command.options.map((option) => option.description)])
      expect(description.length).toBeLessThanOrEqual(100);
  });
});
