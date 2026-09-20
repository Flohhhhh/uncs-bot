import { Injectable } from "@nestjs/common";
import { Colors, EmbedBuilder } from "discord.js";
import { Context, createCommandGroupDecorator, Subcommand, type SlashCommandContext } from "necord";

const ServerCommand = createCommandGroupDecorator({
  name: "server",
  description: "View server information",
});

@Injectable()
@ServerCommand()
export class ServerCommandHandler {
  @Subcommand({
    name: "info",
    description: "Show instructions for joining the server",
  })
  async handleInfo(@Context() [interaction]: SlashCommandContext) {
    const embed = new EmbedBuilder()
      .setTitle("UNCs Community Wardogs Server")
      .setColor(Colors.Orange)
      .setDescription(
        [
          "**Use the ID below to join the server!**",
          "```a52d6616-1b7b-4df9-a5c7-864b9b4eb77b```",
          '-# Find the "Join by ID" button in the bottom-left corner of the server browser, then enter the above code.',
        ].join("\n"),
      );

    return interaction.reply({
      embeds: [embed],
    });
  }
}
