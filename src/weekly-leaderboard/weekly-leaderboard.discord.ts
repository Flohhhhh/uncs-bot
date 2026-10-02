import { Injectable } from "@nestjs/common";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  PermissionFlagsBits,
  SnowflakeUtil,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { hasWeeklyMarker, type WeeklyBoardMessage } from "./weekly-render";

/** Fixed reason categories for Discord-side outcomes. */
export type WeeklyDiscordReason = "Discord not ready" | "channel unusable" | "posted check unavailable";
export class WeeklyDiscordError extends Error {
  constructor(
    readonly reason: WeeklyDiscordReason,
    /** True when retrying later cannot change the answer within this week's window. */
    readonly settled = false,
  ) {
    super(reason);
  }
}
export type WeeklyChannel = TextChannel | NewsChannel;
export type SendResult = { outcome: "posted"; messageId: string } | { outcome: "failed" | "unknown" };

/** Pages of 100 messages scanned after the slot before the answer counts as unknown. */
export const POSTED_SCAN_PAGES = 5;

/** A snowflake just below every message created at or after this instant, for `after` paging. */
export function firstSnowflakeAt(instant: number) {
  return (((BigInt(instant) - SnowflakeUtil.epoch) << 22n) - 1n).toString();
}

export function weeklyNonce(serverId: string, weekKey: string) {
  return createHash("sha256").update(`weekly-leaderboard:${serverId}:${weekKey}`).digest("hex").slice(0, 24);
}

@Injectable()
export class WeeklyLeaderboardDiscord {
  constructor(private readonly discord: Client) {}

  /** A text or announcement channel in the staff guild that the bot can view, post in and read back. */
  async channel(guildId: string, channelId: string): Promise<WeeklyChannel> {
    if (!this.discord.isReady()) throw new WeeklyDiscordError("Discord not ready");
    let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
    try {
      channel = await this.discord.channels.fetch(channelId);
    } catch {
      throw new WeeklyDiscordError("channel unusable");
    }
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
      channel.guildId !== guildId ||
      !channel
        .permissionsFor(this.discord.user)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    )
      throw new WeeklyDiscordError("channel unusable");
    return channel;
  }

  /**
   * Whether the bot already posted this week's marker since the slot. Reads up to five pages forward; more
   * history than that, or a failed read, is "posted check unavailable", and the caller must not post.
   * The bot can read its own messages' content without the privileged message content intent.
   */
  async posted(channel: WeeklyChannel, slot: number, marker: string) {
    const self = this.discord.user?.id;
    if (!self) throw new WeeklyDiscordError("Discord not ready");
    let after = firstSnowflakeAt(slot);
    for (let page = 0; page < POSTED_SCAN_PAGES; page++) {
      let batch: Map<string, Message>;
      try {
        batch = await channel.messages.fetch({ after, limit: 100, cache: false });
      } catch {
        throw new WeeklyDiscordError("posted check unavailable");
      }
      for (const message of batch.values())
        if (message.author?.id === self && hasWeeklyMarker(message.content, marker)) return true;
      if (batch.size < 100) return false;
      after = [...batch.keys()].reduce((newest, id) => (BigInt(id) > BigInt(newest) ? id : newest), after);
    }
    throw new WeeklyDiscordError("posted check unavailable", true);
  }

  /**
   * One send with a deterministic nonce, so a second process sending the same week within Discord's
   * nonce window gets the first message back. Never retried: a timeout or network error is "unknown".
   */
  async send(channel: WeeklyChannel, payload: WeeklyBoardMessage, nonce: string): Promise<SendResult> {
    try {
      const message = await channel.send({ ...payload, nonce, enforceNonce: true });
      return { outcome: "posted", messageId: message.id };
    } catch (error) {
      // Discord answered with a 4xx error, for example 50013 Missing Permissions: nothing was posted.
      const refused = error instanceof DiscordAPIError && error.status >= 400 && error.status < 500;
      return { outcome: refused ? "failed" : "unknown" };
    }
  }
}
