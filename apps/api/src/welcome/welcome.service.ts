import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import { eq } from "drizzle-orm";

import { DATABASE, type Database } from "../database/database.types";
import { guildWelcomeSettings } from "../database/schema";
import { DEFAULT_WELCOME_MESSAGE, parseWelcomeVersions } from "./welcome-template";

export { DEFAULT_WELCOME_MESSAGE, MAX_WELCOME_DESCRIPTION_LENGTH } from "./welcome-template";

/** Defaults used when a guild has not configured its welcome settings yet. */
export const WELCOME_ENABLED = true;

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
      throw new BadRequestException("❌ Welcome message cannot be empty.");
    }
    if (!parseWelcomeVersions(trimmedMessage).length) {
      throw new BadRequestException("❌ Welcome message needs text between the `---` separators.");
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
