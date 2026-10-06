import { SeedingBusiness } from "../../seeding/seeding.business";
import { Injectable } from "@nestjs/common";
import { Colors, EmbedBuilder, type User } from "discord.js";
import {
  Context,
  createCommandGroupDecorator,
  Options,
  Subcommand,
  type SlashCommandContext,
  UserOption,
} from "necord";

class ServerInfoOptions {
  @UserOption({
    name: "user",
    description: "User to notify with the server information",
    required: false,
  })
  user?: User;
}

const ServerCommand = createCommandGroupDecorator({
  name: "server",
  description: "View server information",
});

@Injectable()
@ServerCommand()
export class ServerCommandHandler {
  constructor(private readonly business: SeedingBusiness) {}
  @Subcommand({
    name: "info",
    description: "Show instructions for joining the server",
  })
  async handleInfo(@Context() [interaction]: SlashCommandContext, @Options() { user }: ServerInfoOptions) {
    await interaction.deferReply();
    const { server } = await this.business.load();
    if (!server?.joinId)
      return interaction.editReply({
        content: "The server join ID is currently unavailable.",
        allowedMentions: { parse: [] },
      });
    const embed = new EmbedBuilder()
      .setTitle("UNCs Community Wardogs Server")
      .setColor(Colors.Orange)
      .setDescription(
        [
          "**Use the ID below to join the server!**",
          `\`\`\`${server.joinId}\`\`\``,
          '-# Find the "Join by ID" button in the bottom-left corner of the server browser, then enter the above code.',
        ].join("\n"),
      );

    return interaction.editReply({
      embeds: [embed],
      ...(user && {
        content: user.toString(),
        allowedMentions: { parse: [], users: [user.id] },
      }),
    });
  }
}
