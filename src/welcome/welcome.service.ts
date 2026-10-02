import { Inject, Injectable, Optional } from "@nestjs/common";
import { EmbedBuilder, type GuildMember } from "discord.js";
import { eq } from "drizzle-orm";
import { InteractionError } from "../common/errors/interaction-error";
import { config } from "../config";
import { DATABASE, type Database } from "../database/database.types";
import { guildWelcomeSettings } from "../database/schema";
import {
  DEFAULT_WELCOME_MESSAGE,
  MAX_WELCOME_DESCRIPTION_LENGTH,
  parseWelcomeVersions,
  pickWelcomeVersion,
  welcomeVersions,
  type RandomSource,
} from "./welcome-template";

export { DEFAULT_WELCOME_MESSAGE, MAX_WELCOME_DESCRIPTION_LENGTH } from "./welcome-template";

/** Defaults used when a guild has not configured its welcome settings yet. */
export const WELCOME_ENABLED = true;

/** Optional provider for the random source that picks a welcome version; `Math.random` when absent. */
export const WELCOME_RANDOM = Symbol("WELCOME_RANDOM");

export interface WelcomeSettings {
  enabled: boolean;
  message: string;
}

@Injectable()
export class WelcomeService {
  /** The version each guild was sent last, so it is not sent twice in a row. In memory; resets on restart. */
  private readonly lastVersionByGuild = new Map<string, string>();
  private readonly random: RandomSource;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(WELCOME_RANDOM) random?: RandomSource,
  ) {
    this.random = random ?? Math.random;
  }

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
    if (!parseWelcomeVersions(trimmedMessage).length) {
      throw new InteractionError("❌ Welcome message needs text between the `---` separators.");
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

  /**
   * Builds the welcome embed from one of the template's versions, picked at random and, when another is
   * available, never the version this guild was sent last since the bot started. Call it once per join: it
   * records the pick.
   */
  createEmbed(member: GuildMember, settings: WelcomeSettings): EmbedBuilder {
    const guildId = member.guild.id;
    const version = pickWelcomeVersion(
      welcomeVersions(settings.message),
      this.lastVersionByGuild.get(guildId),
      this.random,
    );
    this.lastVersionByGuild.set(guildId, version);
    const description = this.renderMessage(version, member).slice(0, MAX_WELCOME_DESCRIPTION_LENGTH);

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
