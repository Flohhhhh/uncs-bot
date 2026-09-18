import { MessageFlags, PermissionsBitField, type BaseInteraction, type PermissionResolvable } from "discord.js";

const PERMISSION_LABELS: Record<string, string> = {
  ManageGuild: "Manage Server",
  ManageMessages: "Manage Messages",
  ViewChannel: "View Channels",
  SendMessages: "Send Messages",
  EmbedLinks: "Embed Links",
  ReadMessageHistory: "Read Message History",
};

export function formatPermissions(permissions: readonly PermissionResolvable[]): string {
  const names = new PermissionsBitField(permissions).toArray();
  return names.map((permission) => PERMISSION_LABELS[permission] ?? permission).join(", ");
}

export async function replyPermissionError(interaction: BaseInteraction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: message });
    return;
  }

  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
