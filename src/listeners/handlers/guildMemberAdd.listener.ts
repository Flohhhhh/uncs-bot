import { Injectable, Logger } from "@nestjs/common";
import { DiscordAPIError, Events, RESTJSONErrorCodes } from "discord.js";
import { Context, type ContextOf, On } from "necord";
import { createHash } from "node:crypto";
import { WelcomeService } from "../../welcome/welcome.service";

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

    try {
      await channel.send({
        content: `👋 ${member}`,
        embeds: [this.welcomeService.createEmbed(member, settings)],
        allowedMentions: { users: [member.id] },
        // One nonce per join, so a REST retry or a second process during a deploy overlap gets the first
        // welcome back instead of posting another. A leave and rejoin has a new join time, so it is welcomed.
        nonce: createHash("sha256")
          .update(`guild-welcome:${member.guild.id}:${member.id}:${member.joinedTimestamp ?? ""}`)
          .digest("hex")
          .slice(0, 25),
        enforceNonce: true,
      });
    } catch (error) {
      // The exception filter does not log these codes, so without this the welcome would fail without a trace.
      if (
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.MissingPermissions || error.code === RESTJSONErrorCodes.MissingAccess)
      ) {
        this.logger.warn(
          `Cannot send welcome message in guild ${member.guild.id}: Discord refused it for missing permissions in system channel ${channel.id} (code ${error.code}). The bot needs View Channel, Send Messages and Embed Links there.`,
        );
        return;
      }
      throw error;
    }
  }
}
