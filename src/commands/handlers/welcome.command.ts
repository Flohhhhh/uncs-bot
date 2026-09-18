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
import { RequiredMemberPermission } from "src/common/guards/require-member-permission.guard";
import { config } from "src/config";
import { WelcomeService } from "src/welcome/welcome.service";

class WelcomeMessageOptions {
  @StringOption({
    name: "message",
    description: "Message template, or omit this option to view the current message",
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
    description: "Set or view the welcome message",
  })
  async handleMessage(@Context() [interaction]: SlashCommandContext, @Options() { message }: WelcomeMessageOptions) {
    if (!interaction.guild) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!message) {
      const current = await this.welcomeService.getSettings(interaction.guild.id);
      return interaction.editReply({
        content: ["**Current welcome message:**", current.message, "", "Stored in Neon PostgreSQL."].join("\n"),
        allowedMentions: { parse: [] },
      });
    }

    await this.welcomeService.setMessage(interaction.guild.id, message);
    return interaction.editReply({
      content: "✅ Welcome message updated and saved.",
    });
  }

  @Subcommand({
    name: "enable",
    description: "Enable or disable welcome messages",
  })
  async handleEnable(@Context() [interaction]: SlashCommandContext, @Options() { enabled }: WelcomeEnableOptions) {
    if (!interaction.guild) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.welcomeService.setEnabled(interaction.guild.id, enabled);
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
