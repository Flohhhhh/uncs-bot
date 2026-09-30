import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Client } from "discord.js";
import { createHash, randomUUID } from "node:crypto";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { actionSchema, type ActionResult, type AdminAction, type Staff } from "../admin/admin.types";
import { RconError, WardogsClient } from "../admin/wardogs.client";
import { EnvService } from "../env/env.service";
import { initialCommunityState, observeCommunity, statusCard, type CommunitySnapshot } from "./community-state";

const SYSTEM_ACTOR: Staff = {
  id: "system:server-community",
  name: "Gramps community messages",
  role: "admin",
  csrf: "",
};
const MAX_QUEUE = 64;
const MAX_SENDS_PER_TICK = 1;
const MESSAGE_TTL_MS = 60_000;
type QueuedMessage = { action: AdminAction; expiresAt: number };

@Injectable()
export class ServerCommunityService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ServerCommunityService.name);
  private state = initialCommunityState();
  private queue: QueuedMessage[] = [];
  private snapshot: CommunitySnapshot | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private cardAttemptAt = 0;
  private cardSavedAt = 0;
  private cardKey = "";

  constructor(
    private readonly game: WardogsClient,
    private readonly store: AdminStore,
    private readonly settings: AdminSettings,
    private readonly env: EnvService,
    private readonly discord: Client,
  ) {}

  private options() {
    const enabled = this.env.get("SERVER_COMMUNITY_ENABLED") === true;
    const channelId = this.env.get("SERVER_COMMUNITY_DISCORD_CHANNEL_ID");
    const messageId = this.env.get("SERVER_COMMUNITY_DISCORD_MESSAGE_ID");
    const welcome = enabled && this.env.get("SERVER_COMMUNITY_WELCOME_ENABLED") === true;
    const round = enabled && this.env.get("SERVER_COMMUNITY_ROUND_ENABLED") === true;
    const status =
      enabled && this.env.get("SERVER_COMMUNITY_DISCORD_STATUS_ENABLED") === true && !!channelId && !!messageId;
    return { welcome, round, status, channelId, messageId, active: welcome || round || status };
  }

  onApplicationBootstrap() {
    if (this.options().active) this.schedule(0);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.queue = [];
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().then(
        (next) => this.schedule(next),
        () => {
          this.logger.warn("Community worker failed; the next observation will start from a baseline.");
          this.state = initialCommunityState();
          this.queue = [];
          this.schedule(30_000);
        },
      );
    }, delay);
    this.timer.unref();
  }

  /** One bounded observation/delivery pass. Public only to support isolated tests. */
  async tick(): Promise<number> {
    if (this.running || this.stopped || !this.options().active) return 30_000;
    this.running = true;
    try {
      let current: CommunitySnapshot;
      try {
        current = await this.game.overview();
      } catch {
        this.state = initialCommunityState();
        this.queue = [];
        if (!this.stopped) await this.updateCard(false);
        return 30_000;
      }
      if (this.stopped) return 30_000;
      const now = Date.now();
      const observation = observeCommunity(this.state, current, now);
      this.state = observation.state;
      this.snapshot = current;
      const options = this.options();
      if (observation.baseline) this.queue = [];
      if (options.round && observation.round)
        this.enqueue({ action: "broadcast", message: this.env.get("SERVER_COMMUNITY_ROUND_MESSAGE") }, now, true);
      if (options.welcome) {
        const available = MAX_QUEUE - this.queue.length;
        if (observation.joined.length > available)
          this.logger.warn("Community message queue is full; excess welcomes were skipped.");
        for (const steamId of observation.joined.slice(0, available))
          this.enqueue({ action: "message", steamId, message: this.env.get("SERVER_COMMUNITY_WELCOME_MESSAGE") }, now);
      }
      const connected = new Set(
        current.status.players.current > 0 ? current.players.map((player) => player.steamId) : [],
      );
      this.queue = this.queue.filter(
        ({ action, expiresAt }) => expiresAt > now && (!("steamId" in action) || connected.has(action.steamId)),
      );
      for (let sent = 0; sent < MAX_SENDS_PER_TICK && this.queue.length && !this.stopped; sent++) {
        const next = this.queue.shift()!;
        if (next.expiresAt > Date.now()) await this.deliver(next.action);
      }
      if (!this.stopped) await this.updateCard(true);
      return current.status.players.current > 0 ? 5_000 : 15_000;
    } finally {
      this.running = false;
    }
  }

  private enqueue(input: Record<string, unknown>, now: number, first = false) {
    const parsed = actionSchema.safeParse({
      ...input,
      id: randomUUID(),
      reason:
        input.action === "message"
          ? "Automatic observed-join welcome."
          : "Automatic observed round-transition message.",
    });
    if (!parsed.success) {
      this.logger.warn("Community message was skipped because its configured text is invalid.");
      return;
    }
    const item = { action: parsed.data, expiresAt: now + MESSAGE_TTL_MS };
    if (first) this.queue.unshift(item);
    else this.queue.push(item);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.length = MAX_QUEUE;
    }
  }

  private async deliver(action: AdminAction) {
    const requestHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    try {
      const started = await this.store.begin(SYSTEM_ACTOR, action, requestHash);
      if (!started.created || this.stopped) return;
    } catch {
      this.logger.warn("Community message was not sent because its audit record could not be saved.");
      return;
    }
    let result: ActionResult;
    try {
      result = await this.game.execute(action);
    } catch (error) {
      result = {
        state: error instanceof RconError && !error.unknownResult ? "failed" : "unknown",
        message: "Automatic message was not confirmed. It will not be retried automatically.",
      };
    }
    try {
      await this.store.finish(action.id, result);
    } catch {
      this.logger.warn(
        "Community message result could not be saved; inspect its started audit record. No retry is scheduled.",
      );
    }
  }

  private async updateCard(online: boolean) {
    const options = this.options();
    if (!options.status || !this.discord.isReady() || this.stopped) return;
    const now = Date.now();
    if (this.cardAttemptAt && now - this.cardAttemptAt < 60_000) return;
    const payload = statusCard(this.snapshot, online);
    const key = JSON.stringify({ ...payload, content: payload.content.replace(/Last observed: <t:\d+:R>/, "") });
    if (key === this.cardKey && now - this.cardSavedAt < 300_000) return;
    this.cardAttemptAt = now;
    try {
      const guildId = this.settings.get().guildId;
      const channel = await this.discord.channels.fetch(options.channelId!);
      if (!channel || !("guildId" in channel) || channel.guildId !== guildId || !("messages" in channel)) return;
      const message = await channel.messages.fetch(options.messageId!);
      if (message.author.id !== this.discord.user!.id || this.stopped) return;
      // Edit only the explicitly configured, bot-owned message. Never create one.
      await message.edit(payload);
      this.cardKey = key;
      this.cardSavedAt = now;
    } catch {
      this.logger.warn(
        "Discord status card could not be updated. Check the configured existing message and channel permissions.",
      );
    }
  }
}
