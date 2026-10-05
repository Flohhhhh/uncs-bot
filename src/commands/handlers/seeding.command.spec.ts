import { Reflector } from "@nestjs/core";
import { ApplicationCommandOptionType, InteractionContextType, MessageFlags } from "discord.js";
import { SlashCommand, Subcommand, type SlashCommandContext } from "necord";
import type { SeedingService } from "../../seeding/seeding.service";
import { SeedingCommand } from "./seeding.command";

const REQUEST = { guildId: "200000000000000001", userId: "500000000000000001", channelId: "400000000000000002" };

function fixture() {
  const service = {
    join: jest.fn().mockResolvedValue("joined"),
    leave: jest.fn().mockResolvedValue("left"),
    panel: jest.fn().mockResolvedValue("panel posted"),
    ping: jest.fn().mockResolvedValue("ping sent"),
    status: jest.fn().mockResolvedValue("status"),
  };
  const interaction = {
    guildId: REQUEST.guildId,
    channelId: REQUEST.channelId,
    user: { id: REQUEST.userId },
    deferReply: jest.fn(),
    editReply: jest.fn(),
    reply: jest.fn(),
  };
  const handler = new SeedingCommand(service as unknown as SeedingService);
  const context = [interaction] as unknown as SlashCommandContext;
  return { handler, service, interaction, context };
}

describe("/seeding", () => {
  it.each([
    ["join", "handleJoin", "joined"],
    ["leave", "handleLeave", "left"],
    ["panel", "handlePanel", "panel posted"],
    ["status", "handleStatus", "status"],
  ] as const)("%s acknowledges privately first, then answers privately without pings", async (action, method, text) => {
    const { handler, service, interaction, context } = fixture();
    await handler[method](context);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      service[action].mock.invocationCallOrder[0],
    );
    expect(service[action]).toHaveBeenCalledWith(REQUEST);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: text, allowedMentions: { parse: [] } });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("ping passes the optional staff note through to the service", async () => {
    const { handler, service, interaction, context } = fixture();
    await handler.handlePing(context, { note: "Map night at 8" });
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(service.ping).toHaveBeenCalledWith(REQUEST, "Map night at 8");
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "ping sent", allowedMentions: { parse: [] } });
  });

  it("ping works without a note", async () => {
    const { handler, service, context } = fixture();
    await handler.handlePing(context, {});
    expect(service.ping).toHaveBeenCalledWith(REQUEST, undefined);
  });

  it("acknowledges each interaction exactly once", async () => {
    const { handler, interaction, context } = fixture();
    await handler.handleJoin(context);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });
});

type RegisteredOption = { name: string; type: ApplicationCommandOptionType; description: string; options?: unknown[] };
type RegisteredCommand = {
  name: string;
  description: string;
  contexts?: InteractionContextType[];
  defaultMemberPermissions?: unknown;
  options: RegisteredOption[];
};

describe("/seeding registration", () => {
  const methods = ["handleJoin", "handleLeave", "handlePanel", "handlePing", "handleStatus"] as const;

  /** The command as Necord registers it with Discord. */
  function registered(): RegisteredCommand {
    const reflector = new Reflector();
    const root = reflector.get(SlashCommand, SeedingCommand);
    for (const method of methods) {
      const subcommand = reflector.get(Subcommand, SeedingCommand.prototype[method]);
      subcommand.setDiscoveryMeta({ class: SeedingCommand, handler: SeedingCommand.prototype[method] });
      root.setSubcommand(subcommand);
    }
    return root.toJSON() as unknown as RegisteredCommand;
  }

  it("is one guild-only command with five subcommands and no default permission gate", () => {
    const command = registered();
    expect(command.name).toBe("seeding");
    expect(command.contexts).toEqual([InteractionContextType.Guild]);
    expect(command.defaultMemberPermissions).toBeUndefined();
    expect(command.options.map((option) => option.name)).toEqual(["join", "leave", "panel", "ping", "status"]);
    for (const option of command.options) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand);
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
    expect(command.description.length).toBeLessThanOrEqual(100);
  });

  it("gives ping one optional note of at most 200 characters, and no other options", () => {
    const options = registered().options;
    const ping = options.find((option) => option.name === "ping");
    expect(ping?.options).toEqual([
      expect.objectContaining({
        name: "note",
        type: ApplicationCommandOptionType.String,
        required: false,
        max_length: 200,
      }),
    ]);
    for (const option of options.filter((entry) => entry.name !== "ping")) expect(option.options).toEqual([]);
  });
});
