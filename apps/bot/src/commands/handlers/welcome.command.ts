import { Injectable } from "@nestjs/common";
import { InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  BooleanOption,
  Context,
  createCommandGroupDecorator,
  Options,
  StringOption,
  Subcommand,
  type SlashCommandContext,
} from "necord";
import { RequiredMemberPermission } from "../../common/guards/require-member-permission.guard";
import { config } from "../../config";
import { describeWelcomeTemplate, WELCOME_ROTATION_NOTE, welcomeVersions } from "../../welcome/welcome-template";
import { WelcomeService } from "../../welcome/welcome.service";

class WelcomeMessageOptions {
  @StringOption({
    name: "message",
    description: "Template; separate versions with ' --- '. Omit to view the current message",
    required: false,
    min_length: 1,
    max_length: 4000,
  })
  message?: string;
}

class WelcomeEnableOptions {
  @BooleanOption({
    name: "enabled",
    description: "Whether welcome messages should be sent when members join",
    required: true,
  })
  enabled: boolean;
}

const WelcomeCommand = createCommandGroupDecorator({
  name: "welcome",
  description: "Configure welcome messages",
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  contexts: [InteractionContextType.Guild],
});

@Injectable()
@WelcomeCommand()
@RequiredMemberPermission(PermissionFlagsBits.ManageGuild)
export class WelcomeCommandHandler {
  constructor(private readonly welcomeService: WelcomeService) {}

  @Subcommand({
    name: "message",
    description: "Set or view the welcome message and its versions",
  })
  async handleMessage(@Context() [interaction]: SlashCommandContext, @Options() { message }: WelcomeMessageOptions) {
    if (!interaction.guild) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!message) {
      const current = await this.welcomeService.getSettings(interaction.guild.id);
      return interaction.editReply({
        content: describeWelcomeTemplate(current.message),
        allowedMentions: { parse: [] },
      });
    }

    const saved = await this.welcomeService.setMessage(interaction.guild.id, message, {
      interactionId: interaction.id,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });
    const versions = welcomeVersions(saved.message).length;
    return interaction.editReply({
      content:
        versions === 1
          ? "✅ Welcome message updated and saved."
          : `✅ Welcome message updated and saved with ${versions} versions. ${WELCOME_ROTATION_NOTE}`,
    });
  }

  @Subcommand({
    name: "enable",
    description: "Enable or disable welcome messages",
  })
  async handleEnable(@Context() [interaction]: SlashCommandContext, @Options() { enabled }: WelcomeEnableOptions) {
    if (!interaction.guild) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.welcomeService.setEnabled(interaction.guild.id, enabled, {
      interactionId: interaction.id,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });
    return interaction.editReply({
      content: `✅ Welcome messages are now ${enabled ? "enabled" : "disabled"} and saved.`,
    });
  }

  @Subcommand({
    name: "help",
    description: "Show welcome message template placeholders",
  })
  async handleHelp(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply({
      content: [
        "**Welcome message template help**",
        "Welcome settings are stored in Neon PostgreSQL.",
        "Use `/welcome message` to view the current message or `/welcome message message:<text>` to update it.",
        "Use `/welcome enable enabled:true` or `enabled:false` to toggle welcome messages.",
        "",
        "**Versions**",
        `Separate versions with \` --- \` (three dashes with a space on each side), all on one line. ${WELCOME_ROTATION_NOTE}`,
        "Saving replaces every version, so include all of them each time.",
        "Example: `{user} just pulled up. --- Look who made it, {user}.`",
        "",
        "Templates are replaced when a member joins:",
        "`{user}` → mentions the new member",
        "`{user.id}` or `{user_id}` → inserts the new member's ID",
        "`{general}` → mentions #general",
        "`{squad-up}` → mentions #squad-up",
        "`{lobby}` → mentions The Lobby voice channel",
        "`{channels-and-roles}` → inserts **Channels & Roles**",
        "",
        "To mention any Discord channel directly, use `<#CHANNEL_ID>`:",
        `#general: \`<#${config.channels.general}>\``,
        `#squad-up: \`<#${config.channels.squadUp}>\``,
        `The Lobby: \`<#${config.channels.lobby}>\``,
        "",
        "Example: `{user}, say hello in {general}! Your ID is {user.id}.`",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}
