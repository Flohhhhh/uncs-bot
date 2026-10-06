import { Injectable } from "@nestjs/common";
import { Context, SlashCommand, type SlashCommandContext } from "necord";

@Injectable()
export class UptimeCommand {
  @SlashCommand({
    name: "uptime",
    description: "Show the bot uptime",
  })
  async handleUptime(@Context() [interaction]: SlashCommandContext) {
    const totalSeconds = Math.floor(process.uptime());
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    const uptime = [
      days > 0 ? `${days}d` : null,
      hours > 0 ? `${hours}h` : null,
      minutes > 0 ? `${minutes}m` : null,
      `${seconds}s`,
    ]
      .filter(Boolean)
      .join(" ");

    return interaction.reply(`⏱️ Uptime: ${uptime}`);
  }
}
