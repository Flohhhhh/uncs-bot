import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Client } from "discord.js";
import { createHash, randomUUID } from "node:crypto";
import { AdminStore, COMMUNITY_MESSAGES_ACTOR_ID } from "../admin/admin.store";
import { actionSchema, type ActionResult, type AdminAction, type Staff } from "../admin/admin.types";
import { RconError, RESERVED_SLOTS_CACHE_MS, WardogsClient } from "../admin/wardogs.client";
import { EnvService } from "../env/env.service";
import { GameServers } from "../admin/game-servers";
import type { GameServerSummary } from "../common/game-server";
import type { CommunityMessagesStatus } from "../common/community-messages";
import { CommunityRotation, type WelcomePool } from "./community-rotation";
import { initialCommunityState, observeCommunity, statusCard, type CommunitySnapshot } from "./community-state";

const SYSTEM_ACTOR: Staff = {
  id: COMMUNITY_MESSAGES_ACTOR_ID,
  name: "Gramps community messages",
  role: "admin",
  csrf: "",
};
const MAX_QUEUE = 64;
const MAX_SENDS_PER_TICK = 1;
const MESSAGE_TTL_MS = 60_000;
/** After a failed whitelist read, joiners get the standard welcome without another read for this long. */
export const WHITELIST_RETRY_MS = 60_000;
/** Why a configured status card is not being edited. Fixed text: it names settings, never IDs. */
const CARD_PROBLEMS = {
  guild: "Discord status card is not being updated. Set ADMIN_GUILD_ID to the server that holds its channel.",
  channel:
    "Discord status card is not being updated. Its configured channel is not a text channel in the ADMIN_GUILD_ID server.",
  author:
    "Discord status card is not being updated. Its configured message was not posted by Gramps, and Gramps edits only its own messages.",
  failed: "Discord status card could not be updated. Check the configured existing message and channel permissions.",
} as const;
type QueuedMessage = { action: AdminAction; readyAt: number; expiresAt: number; followUps: string[] };
type StatusCardTarget = { channelId: string; messageId: string } | null | undefined;

function communityOptions(env: EnvService, card: StatusCardTarget) {
  const enabled = env.get("SERVER_COMMUNITY_ENABLED") === true;
  const channelId = card === undefined ? env.get("SERVER_COMMUNITY_DISCORD_CHANNEL_ID") : card?.channelId;
  const messageId = card === undefined ? env.get("SERVER_COMMUNITY_DISCORD_MESSAGE_ID") : card?.messageId;
  const welcome = enabled && env.get("SERVER_COMMUNITY_WELCOME_ENABLED") === true;
  const round = enabled && env.get("SERVER_COMMUNITY_ROUND_ENABLED") === true;
  const status = enabled && env.get("SERVER_COMMUNITY_DISCORD_STATUS_ENABLED") === true && !!channelId && !!messageId;
  return { welcome, round, status, channelId, messageId, active: welcome || round || status };
}

/** Variants take precedence over the sequence, which takes precedence over the legacy single message. */
function welcomeVariants(env: EnvService): string[][] {
  return (
    env.get("SERVER_COMMUNITY_WELCOME_VARIANTS") ?? [
      env.get("SERVER_COMMUNITY_WELCOME_MESSAGES") ?? [env.get("SERVER_COMMUNITY_WELCOME_MESSAGE")],
    ]
  );
}

/** Welcome variants for players on the server's running whitelist; undefined keeps one pool for everyone. */
function whitelistedWelcomeVariants(env: EnvService): string[][] | undefined {
  return env.get("SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS");
}

function roundMessages(env: EnvService): string[] {
  return env.get("SERVER_COMMUNITY_ROUND_MESSAGES") ?? [env.get("SERVER_COMMUNITY_ROUND_MESSAGE")];
}

@Injectable()
export class ServerCommunityService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ServerCommunityService.name);
  private readonly workers = new Map<string, ServerCommunityWorker>();
  constructor(
    private readonly servers: GameServers,
    private readonly store: AdminStore,
    private readonly env: EnvService,
    private readonly discord: Client,
  ) {}
  private cardTarget(serverId: string): StatusCardTarget {
    const configured = this.env.get("WARDOGS_SERVERS");
    // Explicit registries must not reuse the legacy shared status message.
    return configured ? (configured.find((entry) => entry.id === serverId)?.communityStatus ?? null) : undefined;
  }

  status(id?: string): CommunityMessagesStatus {
    const serverId = this.servers.resolve(id);
    const options = communityOptions(this.env, this.cardTarget(serverId));
    const worker = this.workers.get(serverId);
    const variants = welcomeVariants(this.env);
    const whitelistedVariants = whitelistedWelcomeVariants(this.env);
    const rounds = roundMessages(this.env);
    return {
      enabled: this.env.get("SERVER_COMMUNITY_ENABLED") === true,
      workerStarted: !!worker && options.active,
      ...(worker?.observations() ?? {
        lastObservedAt: null,
        lastMessageAcknowledgedAt: null,
        lastStatusCardUpdatedAt: null,
      }),
      welcome: {
        enabled: options.welcome,
        messages: variants[0],
        variants,
        whitelistedVariants: whitelistedVariants ?? null,
        whitelist: whitelistedVariants
          ? {
              source: "running-whitelist",
              cacheSeconds: RESERVED_SLOTS_CACHE_MS / 1000,
              ...(worker?.whitelistObservations() ?? { lastLoadedAt: null, lastFailedAt: null }),
            }
          : null,
        delaySeconds: this.env.get("SERVER_COMMUNITY_WELCOME_DELAY_SECONDS"),
        spacingSeconds: this.env.get("SERVER_COMMUNITY_WELCOME_SPACING_SECONDS"),
      },
      round: { enabled: options.round, message: rounds[0], messages: rounds },
      discordStatus: {
        enabled:
          this.env.get("SERVER_COMMUNITY_ENABLED") === true &&
          this.env.get("SERVER_COMMUNITY_DISCORD_STATUS_ENABLED") === true,
        configured: !!options.channelId && !!options.messageId,
        problem: worker?.statusCardProblem() ?? null,
      },
    };
  }
  onApplicationBootstrap() {
    if (!this.env.get("SERVER_COMMUNITY_ENABLED")) return;
    for (const server of this.servers.list()) {
      try {
        const worker = new ServerCommunityWorker(
          this.servers.get(server.id),
          this.store,
          this.env,
          this.discord,
          server,
          this.cardTarget(server.id),
        );
        this.workers.set(server.id, worker);
        worker.onApplicationBootstrap();
      } catch {
        this.logger.warn(`Community messages for ${server.id} need connection setup. Other servers remain available.`);
      }
    }
  }
  onModuleDestroy() {
    for (const worker of this.workers.values()) worker.onModuleDestroy();
    this.workers.clear();
  }
}

/** Each server owns its observation baseline, message queue and backoff timer. */
export class ServerCommunityWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ServerCommunityWorker.name);
  private state = initialCommunityState();
  private queue: QueuedMessage[] = [];
  private snapshot: CommunitySnapshot | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private cardAttemptAt = 0;
  private cardInFlight?: Promise<void>;
  private cardSavedAt = 0;
  private cardKey = "";
  private cardProblem: string | null = null;
  private readonly cardWarnings = new Set<string>();
  private lastMessageAcknowledgedAt: string | null = null;
  private whitelistLoadedAt: string | null = null;
  private whitelistFailedAt: string | null = null;
  private whitelistRetryAt = 0;

  constructor(
    private readonly game: WardogsClient,
    private readonly store: AdminStore,
    private readonly env: EnvService,
    private readonly discord: Client,
    private readonly server: GameServerSummary = { id: "primary", name: "The UNCs", version: "0".repeat(64) },
    private readonly card?: StatusCardTarget,
    private readonly rotation = new CommunityRotation(),
  ) {}

  private options() {
    return communityOptions(this.env, this.card);
  }

  observations() {
    return {
      lastObservedAt: this.snapshot?.observedAt ?? null,
      lastMessageAcknowledgedAt: this.lastMessageAcknowledgedAt,
      lastStatusCardUpdatedAt: this.cardSavedAt ? new Date(this.cardSavedAt).toISOString() : null,
    };
  }

  /** Why the latest status-card attempt made no edit; null before the first attempt and after an edit. */
  statusCardProblem() {
    return this.cardProblem;
  }

  /** When the whitelist used to pick welcome pools was last read, and when a read last failed. */
  whitelistObservations() {
    return { lastLoadedAt: this.whitelistLoadedAt, lastFailedAt: this.whitelistFailedAt };
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
        this.refreshCard(false);
        return 30_000;
      }
      if (this.stopped) return 30_000;
      const now = Date.now();
      const observation = observeCommunity(this.state, current, now);
      this.state = observation.state;
      this.snapshot = current;
      const options = this.options();
      if (observation.baseline) this.queue = [];
      const connected = new Set(
        current.status.players.current > 0 ? current.players.map((player) => player.steamId) : [],
      );
      this.queue = this.queue.filter(
        ({ action, expiresAt }) =>
          expiresAt > now &&
          (action.action === "message" ? options.welcome && connected.has(action.steamId) : options.round),
      );
      if (options.round && observation.round) {
        const messages = roundMessages(this.env);
        this.enqueue({ action: "broadcast", message: messages[this.rotation.round(messages.length)] }, now, true);
      }
      if (options.welcome) {
        const variants = welcomeVariants(this.env);
        const whitelistedVariants = whitelistedWelcomeVariants(this.env);
        const readyAt = now + this.env.get("SERVER_COMMUNITY_WELCOME_DELAY_SECONDS") * 1000;
        const available = MAX_QUEUE - this.queue.length;
        if (observation.joined.length > available)
          this.logger.warn("Community message queue is full; excess welcomes were skipped.");
        const joining = observation.joined.slice(0, available);
        // Read the whitelist only when it can change a welcome, and at most once per cache period.
        const whitelisted = whitelistedVariants && joining.length ? await this.whitelistedPlayers() : null;
        if (this.stopped) return 30_000;
        for (const steamId of joining) {
          const [pool, choices]: [WelcomePool, string[][]] =
            whitelistedVariants && whitelisted?.has(steamId)
              ? ["whitelisted", whitelistedVariants]
              : ["standard", variants];
          const [message, ...followUps] = choices[this.rotation.welcome(steamId, choices.length, pool)];
          this.enqueue({ action: "message", steamId, message }, readyAt, false, followUps);
        }
      }
      for (let sent = 0; sent < MAX_SENDS_PER_TICK && this.queue.length && !this.stopped; sent++) {
        // A future welcome must not hold up another recipient or a ready round message.
        const index = this.queue.findIndex((item) => item.readyAt <= Date.now() && item.expiresAt > Date.now());
        if (index < 0) break;
        const [next] = this.queue.splice(index, 1);
        const confirmed = await this.deliver(next.action);
        if (confirmed && !this.stopped && next.action.action === "message" && next.followUps.length) {
          // Space from the actual send, so a delayed queue never dumps several messages at once.
          const readyAt = Date.now() + this.env.get("SERVER_COMMUNITY_WELCOME_SPACING_SECONDS") * 1000;
          this.enqueue(
            { action: "message", steamId: next.action.steamId, message: next.followUps[0] },
            readyAt,
            false,
            next.followUps.slice(1),
          );
        }
      }
      this.refreshCard(true);
      return current.status.players.current > 0 ? 5_000 : 15_000;
    } finally {
      this.running = false;
    }
  }

  /** The running whitelist, or null so every joiner gets the standard welcome. Never throws. */
  private async whitelistedPlayers(): Promise<ReadonlySet<string> | null> {
    if (Date.now() < this.whitelistRetryAt) return null;
    try {
      const { ids, loadedAt } = await this.game.reservedSlots();
      this.whitelistLoadedAt = loadedAt;
      return ids;
    } catch {
      this.whitelistFailedAt = new Date().toISOString();
      this.whitelistRetryAt = Date.now() + WHITELIST_RETRY_MS;
      this.logger.warn("The server whitelist could not be read; joiners get the standard welcome for now.");
      return null;
    }
  }

  private enqueue(input: Record<string, unknown>, readyAt: number, first = false, followUps: string[] = []) {
    const parsed = actionSchema.safeParse({
      ...input,
      id: randomUUID(),
      serverId: this.server.id,
      serverVersion: this.server.version,
      reason:
        input.action === "message"
          ? "Automatic observed-join welcome."
          : "Automatic observed round-transition message.",
    });
    if (!parsed.success) {
      this.logger.warn("Community message was skipped because its configured text is invalid.");
      return;
    }
    const item = { action: parsed.data, readyAt, expiresAt: readyAt + MESSAGE_TTL_MS, followUps };
    if (first) this.queue.unshift(item);
    else this.queue.push(item);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.length = MAX_QUEUE;
    }
  }

  private async deliver(action: AdminAction) {
    const requestHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    try {
      const started = await this.store.begin(
        { ...SYSTEM_ACTOR, serverId: this.server.id, serverVersion: this.server.version },
        action,
        requestHash,
      );
      if (!started.created) return false;
      if (this.stopped) {
        // Shutdown began while the receipt was being saved. Close it so it does not read as Unconfirmed.
        try {
          await this.store.finish(action.id, {
            state: "failed",
            changed: false,
            message: "Gramps stopped before sending this automatic message. Nothing was sent.",
          });
        } catch {
          this.logger.warn(
            "Community message was stopped before sending; its started audit record could not be closed.",
          );
        }
        return false;
      }
    } catch {
      this.logger.warn("Community message was not sent because its audit record could not be saved.");
      return false;
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
      return false;
    }
    const acknowledged = result.state === "accepted" || result.state === "applied";
    if (acknowledged) this.lastMessageAcknowledgedAt = new Date().toISOString();
    return acknowledged;
  }

  /**
   * Starts a status-card update without waiting for Discord. A slow edit must not hold the next
   * observation past the baseline gap, which would drop queued welcomes and round messages.
   */
  private refreshCard(online: boolean) {
    if (this.stopped || this.cardInFlight) return;
    this.cardInFlight = this.updateCard(online)
      .catch(() => undefined)
      .finally(() => {
        this.cardInFlight = undefined;
      });
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
      const guildId = this.env.get("ADMIN_GUILD_ID");
      if (!guildId) return this.refuseCard(CARD_PROBLEMS.guild);
      const channel = await this.discord.channels.fetch(options.channelId!);
      if (!channel || !("guildId" in channel) || channel.guildId !== guildId || !("messages" in channel))
        return this.refuseCard(CARD_PROBLEMS.channel);
      const message = await channel.messages.fetch(options.messageId!);
      if (this.stopped) return;
      if (message.author.id !== this.discord.user!.id) return this.refuseCard(CARD_PROBLEMS.author);
      // Edit only the explicitly configured, bot-owned message. Never create one.
      await message.edit(payload);
      this.cardKey = key;
      this.cardSavedAt = now;
      this.cardProblem = null;
    } catch {
      this.cardProblem = CARD_PROBLEMS.failed;
      this.logger.warn(CARD_PROBLEMS.failed);
    }
  }

  /** A setup problem repeats every minute until fixed, so each cause is logged once per worker. */
  private refuseCard(problem: string) {
    this.cardProblem = problem;
    if (this.cardWarnings.has(problem)) return;
    this.cardWarnings.add(problem);
    this.logger.warn(problem);
  }
}
