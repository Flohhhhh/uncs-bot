import { Injectable, Logger } from "@nestjs/common";
import { Events } from "discord.js";
import { Context, type ContextOf, On } from "necord";
import { WelcomeService } from "src/welcome/welcome.service";

@Injectable()
export class GuildMemberAddListener {
  private readonly logger = new Logger(GuildMemberAddListener.name);

  constructor(private readonly welcomeService: WelcomeService) {}

  @On(Events.GuildMemberAdd)
  async handleGuildMemberAdd(@Context() [member]: ContextOf<Events.GuildMemberAdd>) {
    const settings = await this.welcomeService.getSettings(member.guild.id);
    if (!settings.enabled) return;

    const channel = member.guild.systemChannel;
    if (!channel?.isTextBased() || !channel.isSendable()) {
      this.logger.warn(`Cannot send welcome message in guild ${member.guild.id}: system channel unavailable`);
      return;
    }

    await channel.send({
      content: `👋 ${member}`,
      embeds: [this.welcomeService.createEmbed(member, settings)],
      allowedMentions: { users: [member.id] },
    });
  }
}
