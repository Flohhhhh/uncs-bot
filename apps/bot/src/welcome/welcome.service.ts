import { ServiceCallError } from "@uncs/api-client";
import { InteractionError } from "../common/errors/interaction-error";
import { welcomeSettings, type InteractionContext } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { EmbedBuilder, type GuildMember } from "discord.js";
import { config } from "../config";
import {
  MAX_WELCOME_DESCRIPTION_LENGTH,
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
    private readonly remote: RemoteService,
    @Optional() @Inject(WELCOME_RANDOM) random?: RandomSource,
  ) {
    this.random = random ?? Math.random;
  }

  getSettings(guildId: string): Promise<WelcomeSettings> {
    return this.remote.request(`/internal/v1/welcome/${guildId}`, welcomeSettings);
  }
  setEnabled(guildId: string, enabled: boolean, context: InteractionContext): Promise<WelcomeSettings> {
    return this.write({ context, enabled });
  }
  setMessage(guildId: string, message: string, context: InteractionContext): Promise<WelcomeSettings> {
    return this.write({ context, message });
  }

  private async write(body: unknown) {
    try {
      return await this.remote.request("/internal/v1/welcome/settings", welcomeSettings, body);
    } catch (error) {
      const message =
        error instanceof ServiceCallError && error.outcome === "rejected"
          ? (error.details as { message?: unknown })?.message
          : undefined;
      if (typeof message === "string") throw new InteractionError(message);
      throw error;
    }
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
