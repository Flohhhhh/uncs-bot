/**
 * Deletes a specified number of messages from the current text channel.
 *
 * This command demonstrates how permissions and context restrictions can be applied to a slash command.
 */
import { Injectable } from "@nestjs/common";
import { InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { Context, IntegerOption, Options, SlashCommand, type SlashCommandContext } from "necord";
import { InteractionError } from "../../common/errors/interaction-error";
import { RequiredBotPermission } from "../../common/guards/require-bot-permission.guard";

class PurgeOptions {
  @IntegerOption({
    name: "amount",
    description: "Number of messages to delete (max 100)",
    required: true,
    min_value: 1,
    max_value: 100,
  })
  amount: number;
}

@Injectable()
export class PurgeCommand {
  // This will show an error to the calling user if the bot lacks these permissions. If the user is an admin, the error will include the missing permissions.
  // Without Read Message History, Discord returns no messages to delete instead of an error.
  @RequiredBotPermission(PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory)
  @SlashCommand({
    name: "purge",
    description: "Delete a number of messages from this channel",

    // This will make the command invisible to users without the Manage Messages permission
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,

    // Only allow this command in guilds
    contexts: [InteractionContextType.Guild],
  })
  async handlePurge(@Context() [interaction]: SlashCommandContext, @Options() { amount }: PurgeOptions) {
    const channel = interaction.channel;

    if (!channel?.isTextBased() || !("bulkDelete" in channel)) {
      throw new InteractionError("❌ This command can only be used in text channels.");
    }

    // Messages older than 14 days are skipped, since Discord cannot bulk-delete them.
    const deleted = await channel.bulkDelete(amount, true);
    if (deleted.size === 0) {
      return interaction.reply({
        content: "No messages newer than 14 days were found to delete.",
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: `✅ Deleted **${deleted.size}** messages.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
