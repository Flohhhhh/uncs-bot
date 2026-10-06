import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ServiceCallError } from "@uncs/api-client";
import { channelView, weeklySendResult, weeklyMessage } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
import type { WeeklyBoardMessage } from "./weekly-render";
export type WeeklyDiscordReason = "Discord not ready" | "channel unusable" | "posted check unavailable";
export class WeeklyDiscordError extends Error {
  constructor(
    readonly reason: WeeklyDiscordReason,
    readonly settled = false,
  ) {
    super(reason);
  }
}
export type WeeklyChannel = { guildId: string; channelId: string };
export type SendResult = z.infer<typeof weeklySendResult>;
export function weeklyNonce(serverId: string, weekKey: string) {
  return createHash("sha256").update(`weekly-leaderboard:${serverId}:${weekKey}`).digest("hex").slice(0, 24);
}
@Injectable()
export class WeeklyLeaderboardDiscord {
  constructor(private readonly remote: RemoteService) {}
  render(input: unknown) {
    return this.remote.request("/internal/v1/weekly/render", weeklyMessage, input);
  }
  async channel(guildId: string, channelId: string): Promise<WeeklyChannel> {
    try {
      await this.remote.request("/internal/v1/weekly/channel", channelView, { guildId, channelId });
      return { guildId, channelId };
    } catch {
      throw new WeeklyDiscordError("channel unusable");
    }
  }
  async posted(channel: WeeklyChannel, slot: number, weekKey: string, serverId: string) {
    try {
      return await this.remote.request("/internal/v1/weekly/posted", z.boolean(), {
        ...channel,
        slot,
        weekKey,
        serverId,
      });
    } catch (error) {
      const details = error instanceof ServiceCallError ? (error.details as { settled?: boolean }) : undefined;
      throw new WeeklyDiscordError("posted check unavailable", details?.settled === true);
    }
  }
  async send(channel: WeeklyChannel, payload: WeeklyBoardMessage, nonce: string): Promise<SendResult> {
    try {
      return await this.remote.request("/internal/v1/weekly/send", weeklySendResult, {
        ...channel,
        payload,
        nonce,
        operationId: nonce,
      });
    } catch (error) {
      return { outcome: error instanceof ServiceCallError && error.outcome === "rejected" ? "failed" : "unknown" };
    }
  }
}
