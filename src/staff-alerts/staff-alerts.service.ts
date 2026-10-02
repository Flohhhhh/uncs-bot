import { Injectable, Logger } from "@nestjs/common";
import { ChannelType, Client } from "discord.js";
import { EnvService } from "../env/env.service";

const REPEAT_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;
const PER_SERVER_PER_HOUR = 10;

/**
 * Tells staff about automation that needs a person. Always logs; posts to the optional
 * STAFF_ALERTS_CHANNEL_ID only, never to a community or voting channel, with mentions disabled.
 * Delivery is best effort and never throws into a worker.
 */
@Injectable()
export class StaffAlerts {
  private readonly logger = new Logger(StaffAlerts.name);
  private readonly lastSent = new Map<string, number>();
  private readonly sentAt = new Map<string, number[]>();
  constructor(
    private readonly discord: Client,
    private readonly env: EnvService,
  ) {}

  /** A single-line, plain-text alert channel ID, or null when unset or unsafe. */
  private channelId() {
    const channelId = this.env.get("STAFF_ALERTS_CHANNEL_ID");
    if (!channelId || !this.env.get("ADMIN_GUILD_ID")) return null;
    const community = [
      this.env.get("MAP_VOTES_CHANNEL_ID"),
      this.env.get("SERVER_COMMUNITY_DISCORD_CHANNEL_ID"),
      ...(this.env.get("WARDOGS_SERVERS") ?? []).map((server) => server.communityStatus?.channelId),
    ];
    return community.includes(channelId) ? null : channelId;
  }

  /** Returns true only when the alert was posted. The same key repeats at most every 30 minutes. */
  async send(serverId: string, key: string, message: string) {
    const text = [...message]
      .map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character))
      .join("")
      .slice(0, 1800);
    this.logger.warn(`Staff alert for ${serverId}: ${text}`);
    const now = Date.now();
    const dedupe = `${serverId}:${key}`;
    if (now - (this.lastSent.get(dedupe) ?? -Infinity) < REPEAT_MS) return false;
    const recent = (this.sentAt.get(serverId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= PER_SERVER_PER_HOUR) return false;
    if (this.lastSent.size > 1000) this.lastSent.clear();
    this.lastSent.set(dedupe, now);
    this.sentAt.set(serverId, [...recent, now]);
    const channelId = this.channelId();
    if (!channelId) return false;
    try {
      if (!this.discord.isReady()) return false;
      const channel = await this.discord.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== this.env.get("ADMIN_GUILD_ID"))
        return false;
      await channel.send({
        content: `**Gramps staff alert** · ${text}`,
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      });
      return true;
    } catch {
      this.logger.warn("A staff alert could not be posted in Discord. It remains in the log and dashboard.");
      return false;
    }
  }
}
