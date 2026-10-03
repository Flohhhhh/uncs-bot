import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Reflector } from "@nestjs/core";
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { OPTIONS_METADATA, type SlashCommandContext } from "necord";
import { RequireBotPermissionGuard } from "../../common/guards/require-bot-permission.guard";
import { PurgeCommand } from "./purge.command";

/** Runs the guard declared on /purge for a guild channel where the bot has these permissions. */
async function guard(botPermissions: bigint[]) {
  const interaction = Object.assign(Object.create(ChatInputCommandInteraction.prototype), {
    guildId: "guild-1",
    appPermissions: new PermissionsBitField(botPermissions).freeze(),
  });
  const context = new ExecutionContextHost([[interaction], {}], PurgeCommand, PurgeCommand.prototype.handlePurge);
  return new RequireBotPermissionGuard(new Reflector()).canActivate(context);
}

function purge(deleted: number) {
  const reply = jest.fn();
  const bulkDelete = jest
    .fn()
    .mockResolvedValue(new Collection(Array.from({ length: deleted }, (_, i) => [`${i}`, {}])));
  const interaction = { channel: { isTextBased: () => true, bulkDelete }, reply };
  const context = [interaction] as unknown as SlashCommandContext;
  return { run: () => new PurgeCommand().handlePurge(context, { amount: 50 }), reply, bulkDelete };
}

describe("/purge", () => {
  it("asks Discord for a whole number of messages, since a fractional amount cannot be deleted", () => {
    const options = Reflect.getMetadata(OPTIONS_METADATA, PurgeCommand.prototype.handlePurge);
    expect(options.amount).toMatchObject({
      name: "amount",
      type: ApplicationCommandOptionType.Integer,
      resolver: "getInteger",
      required: true,
      min_value: 1,
      max_value: 100,
    });
  });

  it("names Read Message History when the bot can manage messages but cannot read them", async () => {
    await expect(guard([PermissionFlagsBits.ManageMessages])).rejects.toThrow(
      "❌ I need the following permission(s) in this channel: **Read Message History**.",
    );
    await expect(guard([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])).resolves.toBe(
      true,
    );
  });

  it("says nothing recent was found instead of reporting a successful purge of zero messages", async () => {
    const { run, reply, bulkDelete } = purge(0);
    await run();
    expect(bulkDelete).toHaveBeenCalledWith(50, true);
    expect(reply).toHaveBeenCalledWith({
      content: "No messages newer than 14 days were found to delete.",
      flags: MessageFlags.Ephemeral,
    });
  });

  it("reports how many messages it deleted", async () => {
    const { run, reply } = purge(3);
    await run();
    expect(reply).toHaveBeenCalledWith({ content: "✅ Deleted **3** messages.", flags: MessageFlags.Ephemeral });
  });
});
