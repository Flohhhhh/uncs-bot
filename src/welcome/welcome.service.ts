import { Injectable, Logger } from "@nestjs/common";
import { EmbedBuilder, type GuildMember } from "discord.js";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const GENERAL_CHANNEL_ID = "1546923296568778893";
export const SQUAD_UP_CHANNEL_ID = "327209891708141568";
export const LOBBY_CHANNEL_ID = "1546924372948815882";

/** Defaults used when a guild has not configured its welcome settings yet. */
export const WELCOME_ENABLED = true;
export const MAX_WELCOME_DESCRIPTION_LENGTH = 4096;
export const DEFAULT_WELCOME_MESSAGE =
  "{user}, good to have you. Say hey in {general}, check {squad-up}, or jump into **The Lobby**.\n\nPick your games and roles in **Channels & Roles**. Get on when you can.";

export interface WelcomeSettings {
  enabled: boolean;
  message: string;
}

interface WelcomeConfig {
  guilds: Record<string, WelcomeSettings>;
}

@Injectable()
export class WelcomeService {
  private readonly logger = new Logger(WelcomeService.name);
  private config: WelcomeConfig = { guilds: {} };
  private loadPromise: Promise<void> | undefined;
  private writeQueue = Promise.resolve();

  async getSettings(guildId: string): Promise<WelcomeSettings> {
    await this.ensureLoaded();

    return (
      this.config.guilds[guildId] ?? {
        enabled: WELCOME_ENABLED,
        message: DEFAULT_WELCOME_MESSAGE,
      }
    );
  }

  async setEnabled(guildId: string, enabled: boolean): Promise<WelcomeSettings> {
    await this.ensureLoaded();
    const settings = await this.updateSettings(guildId, { enabled });
    return settings;
  }

  async setMessage(guildId: string, message: string): Promise<WelcomeSettings> {
    await this.ensureLoaded();
    const settings = await this.updateSettings(guildId, { message: message.trim() });
    return settings;
  }

  createEmbed(member: GuildMember, settings: WelcomeSettings): EmbedBuilder {
    const description = this.renderMessage(settings.message, member).slice(0, MAX_WELCOME_DESCRIPTION_LENGTH);

    return new EmbedBuilder()
      .setColor(0xff6b35)
      .setTitle("Welcome to The UNCs")
      .setDescription(description)
      .setThumbnail(member.displayAvatarURL({ size: 256 }));
  }

  private async updateSettings(guildId: string, update: Partial<WelcomeSettings>): Promise<WelcomeSettings> {
    const current = await this.getSettings(guildId);
    const settings = { ...current, ...update };
    this.config.guilds[guildId] = settings;
    await this.persistConfig();
    return settings;
  }

  private async ensureLoaded() {
    this.loadPromise ??= this.loadConfig();
    await this.loadPromise;
  }

  private async loadConfig() {
    const configPath = getWelcomeConfigPath();

    try {
      const contents = await fs.readFile(configPath, "utf8");
      this.config = this.parseConfig(JSON.parse(contents));
    } catch (error) {
      if (isFileNotFoundError(error)) {
        await this.persistConfig();
        return;
      }

      this.logger.error(`Could not load welcome config from ${configPath}; using defaults`, error);
    }
  }

  private async persistConfig() {
    const configPath = getWelcomeConfigPath();
    const temporaryPath = `${configPath}.${process.pid}.tmp`;

    const write = this.writeQueue.then(async () => {
      await fs.mkdir(dirname(configPath), { recursive: true });
      await fs.writeFile(temporaryPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
      await fs.rename(temporaryPath, configPath);
    });

    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private parseConfig(value: unknown): WelcomeConfig {
    if (!isRecord(value) || !isRecord(value.guilds)) {
      throw new Error("Welcome config must contain a guilds object");
    }

    const guilds: Record<string, WelcomeSettings> = {};
    for (const [guildId, guildSettings] of Object.entries(value.guilds)) {
      if (!isRecord(guildSettings)) continue;

      guilds[guildId] = {
        enabled: typeof guildSettings.enabled === "boolean" ? guildSettings.enabled : WELCOME_ENABLED,
        message:
          typeof guildSettings.message === "string" && guildSettings.message.trim()
            ? guildSettings.message
            : DEFAULT_WELCOME_MESSAGE,
      };
    }

    return { guilds };
  }

  private renderMessage(message: string, member: GuildMember): string {
    return message
      .replaceAll("{user.id}", member.id)
      .replaceAll("{user_id}", member.id)
      .replaceAll("{user}", member.toString())
      .replaceAll("{general.id}", GENERAL_CHANNEL_ID)
      .replaceAll("{general_id}", GENERAL_CHANNEL_ID)
      .replaceAll("{general}", `<#${GENERAL_CHANNEL_ID}>`)
      .replaceAll("{squad-up.id}", SQUAD_UP_CHANNEL_ID)
      .replaceAll("{squad_up_id}", SQUAD_UP_CHANNEL_ID)
      .replaceAll("{squad-up}", `<#${SQUAD_UP_CHANNEL_ID}>`)
      .replaceAll("{lobby.id}", LOBBY_CHANNEL_ID)
      .replaceAll("{lobby_id}", LOBBY_CHANNEL_ID)
      .replaceAll("{lobby}", `<#${LOBBY_CHANNEL_ID}>`)
      .replaceAll("{channels-and-roles}", "**Channels & Roles**");
  }
}

export function getWelcomeConfigPath() {
  const mountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH || resolve(process.cwd(), "data");
  return join(mountPath, "welcome-config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === "ENOENT";
}
