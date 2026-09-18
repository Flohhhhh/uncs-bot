import { Inject, Injectable } from "@nestjs/common";
import { EmbedBuilder, type GuildMember } from "discord.js";
import { eq } from "drizzle-orm";
import { config } from "src/config";
import { InteractionError } from "src/common/errors/interaction-error";
import { DATABASE, type Database } from "src/database/database.module";
import { guildWelcomeSettings } from "src/database/schema";

/** Defaults used when a guild has not configured its welcome settings yet. */
export const WELCOME_ENABLED = true;
export const MAX_WELCOME_DESCRIPTION_LENGTH = 4096;
export const DEFAULT_WELCOME_MESSAGE =
  "{user}, good to have you. Say hey in {general}, check {squad-up}, or jump into **The Lobby**.\n\nPick your games and roles in **Channels & Roles**. Get on when you can.";

export interface WelcomeSettings {
  enabled: boolean;
  message: string;
}

@Injectable()
export class WelcomeService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getSettings(guildId: string): Promise<WelcomeSettings> {
    const [settings] = await this.db
      .select()
      .from(guildWelcomeSettings)
      .where(eq(guildWelcomeSettings.guildId, guildId))
      .limit(1);

    return settings ? toWelcomeSettings(settings) : getDefaultWelcomeSettings();
  }

  async setEnabled(guildId: string, enabled: boolean): Promise<WelcomeSettings> {
    const [settings] = await this.db
      .insert(guildWelcomeSettings)
      .values({ guildId, enabled, message: DEFAULT_WELCOME_MESSAGE })
      .onConflictDoUpdate({
        target: guildWelcomeSettings.guildId,
        set: { enabled, updatedAt: new Date() },
      })
      .returning();

    return toWelcomeSettings(settings);
  }

  async setMessage(guildId: string, message: string): Promise<WelcomeSettings> {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new InteractionError("❌ Welcome message cannot be empty.");
    }

    const [settings] = await this.db
      .insert(guildWelcomeSettings)
      .values({ guildId, enabled: WELCOME_ENABLED, message: trimmedMessage })
      .onConflictDoUpdate({
        target: guildWelcomeSettings.guildId,
        set: { message: trimmedMessage, updatedAt: new Date() },
      })
      .returning();

    return toWelcomeSettings(settings);
  }

  createEmbed(member: GuildMember, settings: WelcomeSettings): EmbedBuilder {
    const description = this.renderMessage(settings.message, member).slice(0, MAX_WELCOME_DESCRIPTION_LENGTH);

    return new EmbedBuilder()
      .setColor(0xff6b35)
      .setTitle("Welcome to The UNCs")
      .setDescription(description)
      .setThumbnail(member.displayAvatarURL({ size: 256 }));
  }

  private renderMessage(message: string, member: GuildMember): string {
    return message
      .replaceAll("{user.id}", member.id)
      .replaceAll("{user_id}", member.id)
      .replaceAll("{user}", member.toString())
      .replaceAll("{general.id}", config.channels.general)
      .replaceAll("{general_id}", config.channels.general)
      .replaceAll("{general}", `<#${config.channels.general}>`)
      .replaceAll("{squad-up.id}", config.channels.squadUp)
      .replaceAll("{squad_up_id}", config.channels.squadUp)
      .replaceAll("{squad-up}", `<#${config.channels.squadUp}>`)
      .replaceAll("{lobby.id}", config.channels.lobby)
      .replaceAll("{lobby_id}", config.channels.lobby)
      .replaceAll("{lobby}", `<#${config.channels.lobby}>`)
      .replaceAll("{channels-and-roles}", "**Channels & Roles**");
  }
}

function getDefaultWelcomeSettings(): WelcomeSettings {
  return {
    enabled: WELCOME_ENABLED,
    message: DEFAULT_WELCOME_MESSAGE,
  };
}

function toWelcomeSettings(settings: typeof guildWelcomeSettings.$inferSelect | undefined): WelcomeSettings {
  if (!settings) {
    throw new Error("Database did not return the updated welcome settings");
  }

  return {
    enabled: settings.enabled,
    message: settings.message,
  };
}
