import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  ChannelType,
  Client,
  escapeMarkdown,
  PermissionFlagsBits,
  type APIEmbed,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import { createHash, randomBytes } from "node:crypto";
import { EnvService } from "../env/env.service";
import {
  alertCategory,
  reviewDecisions,
  type FeedContextView,
  type NetworkBanView,
  type StaffAlertCategory,
  type StaffAlertDecision,
  type StaffAlertDelivery,
  type StaffAlertKind,
  type StaffAlertReviewResult,
  type StaffAlertSeverity,
  type StaffAlertSnoozeCategory,
  type StaffAlertView,
  type StaffAlertsChannelState,
  type StaffAlertsPingState,
  type StaffAlertsSnoozeView,
} from "../common/staff-alerts";
import { staffAlertsOptions } from "./staff-alerts.config";

const HOUR_MS = 60 * 60_000;
const DEDUPE_MS = 24 * HOUR_MS;
const PING_INTERVAL_MS = 30 * 60_000;
const RECORDS_PER_SERVER = 200;
const RECORDS_TOTAL = 1000;
const VIEW_LIMIT = 100;
const SNOOZE_MINUTES = { min: 15, max: 1440 };
const COLORS: Record<StaffAlertSeverity, number> = { info: 0x95a5a6, warning: 0xe6a23c, high: 0xe74c3c };
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];
/** An https link shown as an autolink (<url>): no spaces, angle brackets or backticks to break out. */
const SAFE_LINK = /^https:\/\/[^\s<>`]{1,500}$/;
const NO_MENTIONS = { parse: [], users: [], roles: [], repliedUser: false };

export type StaffAlertInput = {
  serverId: string;
  /** Shown in the embed footer; defaults to the server ID. */
  serverName?: string;
  kind: StaffAlertKind;
  severity: StaffAlertSeverity;
  /** One alert per key and server within `repeatMs` (24 hours by default). */
  key: string;
  repeatMs?: number;
  title: string;
  lines: string[];
  player?: { steamId: string; name: string };
  facts?: Record<string, string | number>;
  /** Up to four short embed fields shown beside the player and SteamID. */
  fields?: [string, string][];
  /** https evidence links, shown unescaped in their own field (at most three). */
  links?: string[];
  /** False in observe mode: recorded for the dashboard, never posted. */
  deliver: boolean;
  /** Recorded only, with this reason (a cooldown or a scheduled restart below the threshold). */
  suppressed?: string;
  feed?: FeedContextView | null;
  network?: NetworkBanView | null;
};
type StoredAlert = StaffAlertView & {
  key: string;
  serverName: string;
  fields: [string, string][];
  links: string[];
  message: { channelId: string; messageId: string; embed: APIEmbed } | null;
};
type ChannelCheck = { state: StaffAlertsChannelState; channel: TextChannel | null };

/** Game-controlled or staff text: no control characters, collapsed spaces, capped. */
export function cleanText(value: string, max: number) {
  const text = [...value]
    .map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** Text for an embed: cleaned, Markdown escaped and unable to form a mention. */
export function discordText(value: string, max = 600) {
  return escapeMarkdown(cleanText(value, max))
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/<([@#])/g, "<​$1");
}
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/**
 * Tells staff about things that need a person. Alert-only: it never changes the game. Posts to
 * the optional STAFF_ALERTS_CHANNEL_ID only, never to a community, voting, leaderboard or status
 * channel, and refuses a channel that @everyone can view. Delivery is best effort and never throws into a
 * worker. Records stay in memory (200 per server, 1,000 in all) and are lost on restart.
 */
@Injectable()
export class StaffAlerts {
  private readonly logger = new Logger(StaffAlerts.name);
  private readonly records: StoredAlert[] = [];
  private readonly byId = new Map<string, StoredAlert>();
  private readonly raised = new Map<string, { at: number; id: string }>();
  private readonly hourly = new Map<string, number[]>();
  private readonly snoozes = new Map<string, Map<StaffAlertSnoozeCategory, { until: number; by: string }>>();
  private readonly never = new Set<string>();
  private lastPingAt = -Infinity;
  constructor(
    private readonly discord: Client,
    private readonly env: EnvService,
  ) {}

  /** The voting, community, weekly leaderboard and server status channels: never a staff alert channel. */
  private communityChannel(channelId: string) {
    const community = [
      this.env.get("MAP_VOTES_CHANNEL_ID"),
      this.env.get("SERVER_COMMUNITY_DISCORD_CHANNEL_ID"),
      this.env.get("WEEKLY_LEADERBOARD_CHANNEL_ID"),
      ...(this.env.get("WARDOGS_SERVERS") ?? []).map((server) => server.communityStatus?.channelId),
    ];
    return community.includes(channelId);
  }

  /**
   * Records an alert and, unless it is held back, posts it as an embed. Returns null when the
   * same key was raised within its repeat window (nothing new is recorded). Never throws.
   */
  async raise(input: StaffAlertInput): Promise<StaffAlertView | null> {
    const now = Date.now();
    const dedupe = `${input.serverId}:${input.key}`;
    const previous = this.raised.get(dedupe);
    if (previous && now - previous.at < (input.repeatMs ?? DEDUPE_MS)) return null;
    for (const [key, value] of this.raised) if (now - value.at >= DEDUPE_MS * 7) this.raised.delete(key);
    if (this.raised.size >= 5000) this.raised.delete(this.raised.keys().next().value!);
    const category = alertCategory(input.kind);
    const stored = this.store({
      ...input,
      serverName: input.serverName ?? input.serverId,
      delivery: { state: "observe", reason: null },
    });
    this.raised.set(dedupe, { at: now, id: stored.id });
    let delivery: StaffAlertDelivery;
    if (input.suppressed) delivery = { state: "suppressed", reason: input.suppressed };
    else if (!input.deliver) delivery = { state: "observe", reason: null };
    else if (this.snoozed(input.serverId, category, now)) delivery = { state: "snoozed", reason: null };
    else if (!this.allowHourly(input.serverId, category, now))
      delivery = { state: "suppressed", reason: "hourly limit" };
    else delivery = await this.post(stored, now);
    stored.delivery = delivery;
    this.logger.log(
      `Staff alert ${stored.id} ${stored.kind} ${stored.serverId} ${delivery.state}${delivery.reason ? `: ${delivery.reason}` : ""}`,
    );
    return this.view(stored);
  }

  /** Updates an earlier alert's text in memory only (a second rule for the same player and round). */
  amend(
    serverId: string,
    key: string,
    patch: { kind?: StaffAlertKind; title?: string; lines?: string[]; facts?: Record<string, string | number> },
  ) {
    const record = this.records.find((item) => item.serverId === serverId && item.key === key);
    if (!record) return null;
    if (patch.kind) {
      record.kind = patch.kind;
      record.category = alertCategory(patch.kind);
    }
    if (patch.title) record.title = cleanText(patch.title, 80);
    if (patch.lines) record.lines = patch.lines.map((line) => cleanText(line, 600));
    if (patch.facts) record.facts = { ...record.facts, ...patch.facts };
    record.updatedAt = new Date().toISOString();
    return this.view(record);
  }

  private store(input: Omit<StaffAlertInput, "deliver"> & { serverName: string; delivery: StaffAlertDelivery }) {
    let id = randomBytes(6).toString("hex");
    while (this.byId.has(id)) id = randomBytes(6).toString("hex");
    const at = new Date().toISOString();
    const record: StoredAlert = {
      id,
      serverId: input.serverId,
      serverName: cleanText(input.serverName, 80) || input.serverId,
      kind: input.kind,
      category: alertCategory(input.kind),
      severity: input.severity,
      key: input.key,
      title: cleanText(input.title, 80),
      lines: input.lines.map((line) => cleanText(line, 600)),
      player: input.player
        ? { steamId: input.player.steamId, name: cleanText(input.player.name, 64) || "Unknown" }
        : null,
      facts: { ...(input.facts ?? {}) },
      fields: (input.fields ?? []).slice(0, 4),
      links: (input.links ?? []).filter((link) => SAFE_LINK.test(link)).slice(0, 3),
      createdAt: at,
      updatedAt: at,
      delivery: input.delivery,
      pinged: false,
      review: null,
      feed: input.feed ?? null,
      network: input.network ?? null,
      message: null,
    };
    this.records.push(record);
    this.byId.set(id, record);
    const forServer = this.records.filter((item) => item.serverId === record.serverId);
    for (const old of forServer.slice(0, Math.max(0, forServer.length - RECORDS_PER_SERVER))) this.drop(old);
    while (this.records.length > RECORDS_TOTAL) this.drop(this.records[0]);
    return record;
  }
  private drop(record: StoredAlert) {
    const index = this.records.indexOf(record);
    if (index >= 0) this.records.splice(index, 1);
    this.byId.delete(record.id);
  }

  private hourlyLimit(category: StaffAlertCategory) {
    if (category === "performance") return staffAlertsOptions(this.env).performance.maxPerHour;
    return 6;
  }
  private allowHourly(serverId: string, category: StaffAlertCategory, now: number) {
    const bucket = `${serverId}:${category === "seeding" ? "health" : category}`;
    const recent = (this.hourly.get(bucket) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= this.hourlyLimit(category)) {
      this.hourly.set(bucket, recent);
      return false;
    }
    this.hourly.set(bucket, [...recent, now]);
    return true;
  }

  /** The configured ping role, or why it cannot be used. Never the @everyone role (the guild ID). */
  pingState(): StaffAlertsPingState {
    const role = this.env.get("STAFF_ALERTS_PING_ROLE_ID");
    if (!role) return "off";
    const guild = this.env.get("ADMIN_GUILD_ID");
    return !guild || role === guild ? "invalid" : "ok";
  }
  /**
   * Whether a ping in this staff channel would notify anyone. Discord delivers a role mention only
   * when the role allows anyone to mention it or the sender has Mention @everyone, @here, and All
   * Roles; allowed mentions cannot grant that. Gramps never changes the role or its own permissions.
   */
  private pingReady(channel: TextChannel): StaffAlertsPingState {
    const state = this.pingState();
    const role = this.env.get("STAFF_ALERTS_PING_ROLE_ID");
    if (state !== "ok" || !role) return state;
    const found = channel.guild.roles.cache.get(role);
    if (!found) return "invalid";
    const me = channel.guild.members.me;
    if (found.mentionable || (me && channel.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone))) return "ok";
    return "not-mentionable";
  }

  /** Checks the staff channel without posting: guild, type, bot permissions and @everyone visibility. */
  async channelCheck(): Promise<ChannelCheck> {
    const channelId = this.env.get("STAFF_ALERTS_CHANNEL_ID");
    const guildId = this.env.get("ADMIN_GUILD_ID");
    if (!channelId) return { state: "missing", channel: null };
    if (!guildId) return { state: "wrong-guild", channel: null };
    if (this.communityChannel(channelId)) return { state: "community-channel", channel: null };
    try {
      if (!this.discord.isReady()) return { state: "discord-offline", channel: null };
      const channel = await this.discord.channels.fetch(channelId);
      if (!channel) return { state: "missing", channel: null };
      if (!("guildId" in channel) || channel.guildId !== guildId) return { state: "wrong-guild", channel: null };
      if (channel.type !== ChannelType.GuildText) return { state: "not-text", channel: null };
      const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
      if (!channel.permissionsFor(me)?.has(REQUIRED_PERMISSIONS))
        return { state: "missing-permissions", channel: null };
      if (channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))
        return { state: "public", channel: null };
      return { state: "ok", channel };
    } catch {
      return { state: "missing", channel: null };
    }
  }
  async channelStatus() {
    const check = await this.channelCheck();
    return {
      configured: !!this.env.get("STAFF_ALERTS_CHANNEL_ID"),
      state: check.state,
      ping: check.channel ? this.pingReady(check.channel) : this.pingState(),
    };
  }

  private embed(record: StoredAlert, footerNote?: string): APIEmbed {
    const fields: APIEmbed["fields"] = [];
    if (record.player)
      fields.push(
        { name: "Player", value: discordText(record.player.name, 64) || "Unknown", inline: true },
        { name: "SteamID", value: `\`${record.player.steamId}\``, inline: true },
      );
    for (const [name, value] of record.fields)
      if (fields.length < 4) fields.push({ name: discordText(name, 40), value: discordText(value, 200), inline: true });
    if (record.links.length)
      fields.push({ name: "Evidence", value: record.links.map((link) => `<${link}>`).join("\n"), inline: false });
    const footer = cleanText(
      `Gramps · ${record.serverName} · alert ${record.id}${footerNote ? ` · ${footerNote}` : ""}`,
      300,
    );
    return {
      title: clip(discordText(record.title, 80), 80),
      description: clip(record.lines.map((line) => discordText(line)).join("\n"), 600),
      color: COLORS[record.severity],
      fields,
      footer: { text: footer },
      timestamp: record.createdAt,
    };
  }

  private async post(record: StoredAlert, now: number): Promise<StaffAlertDelivery> {
    const check = await this.channelCheck();
    if (check.state !== "ok" || !check.channel)
      return {
        state: "failed",
        reason:
          check.state === "missing" && !this.env.get("STAFF_ALERTS_CHANNEL_ID") ? "no staff channel" : check.state,
      };
    const role = this.env.get("STAFF_ALERTS_PING_ROLE_ID");
    const ping =
      record.severity === "high" &&
      record.category !== "performance" &&
      !!role &&
      this.pingReady(check.channel) === "ok" &&
      now - this.lastPingAt >= PING_INTERVAL_MS;
    // Reserve the ping before the send, so an alert from another server meanwhile does not ping too.
    const previousPingAt = this.lastPingAt;
    if (ping) this.lastPingAt = now;
    const embed = this.embed(record);
    // No "Open in dashboard" button until the dashboard's Staff alerts tab can show the alert.
    const options: MessageCreateOptions = {
      embeds: [embed],
      allowedMentions: { ...NO_MENTIONS, roles: ping ? [role] : [] },
      nonce: createHash("sha256").update(`gramps-staff-alert:${record.id}`).digest("hex").slice(0, 25),
      enforceNonce: true,
      ...(ping ? { content: `<@&${role}>` } : {}),
    };
    try {
      const message = await check.channel.send(options);
      record.message = { channelId: check.channel.id, messageId: message.id, embed };
      if (ping) record.pinged = true;
      return { state: "posted", reason: null };
    } catch {
      if (ping && this.lastPingAt === now) this.lastPingAt = previousPingAt;
      return { state: "failed", reason: "discord error" };
    }
  }

  private snoozed(serverId: string, category: StaffAlertCategory, now: number) {
    const active = this.snoozes.get(serverId);
    return [category, "all"].some((item) => (active?.get(item as StaffAlertSnoozeCategory)?.until ?? 0) > now);
  }

  /** Snoozes a category on one server for 15 to 1440 minutes; 0 clears it. In memory only. */
  snooze(serverId: string, category: StaffAlertSnoozeCategory, minutes: number, by: string) {
    const active = this.snoozes.get(serverId) ?? new Map();
    if (minutes === 0) active.delete(category);
    else {
      if (!Number.isInteger(minutes) || minutes < SNOOZE_MINUTES.min || minutes > SNOOZE_MINUTES.max)
        throw new BadRequestException("Snooze for 15 to 1440 minutes, or 0 to clear.");
      active.set(category, { until: Date.now() + minutes * 60_000, by: cleanText(by, 64) });
    }
    this.snoozes.set(serverId, active);
    this.logger.log(`Staff alerts ${category} ${minutes ? `snoozed for ${minutes} min` : "unsnoozed"} on ${serverId}`);
    return this.activeSnoozes(serverId);
  }
  activeSnoozes(serverId: string): StaffAlertsSnoozeView[] {
    const now = Date.now();
    return [...(this.snoozes.get(serverId) ?? [])]
      .filter(([, value]) => value.until > now)
      .map(([category, value]) => ({ category, until: new Date(value.until).toISOString(), by: value.by }));
  }

  /** SteamIDs marked "never flag" since Gramps started. */
  sessionNever(): ReadonlySet<string> {
    return this.never;
  }

  /** Records a staff decision in memory and, best effort, notes it in the Discord footer. */
  async review(
    serverId: string,
    id: string,
    decision: StaffAlertDecision,
    staff: { name: string },
  ): Promise<StaffAlertReviewResult> {
    const record = this.byId.get(id);
    if (!record || record.serverId !== serverId)
      throw new NotFoundException(
        "This alert is no longer available. Alerts are kept in memory until Gramps restarts.",
      );
    if (!reviewDecisions(record.kind).includes(decision))
      throw new BadRequestException("Only performance alerts can be marked legit or never flagged.");
    const by = cleanText(staff.name, 64) || "staff";
    const at = new Date();
    record.review = { decision, by, at: at.toISOString() };
    let knownGoodEntry: string | undefined;
    if (decision === "never" && record.player) {
      this.never.add(record.player.steamId);
      knownGoodEntry = JSON.stringify({
        steamId: record.player.steamId,
        note: cleanText(`never flag: ${by}, ${at.toISOString().slice(0, 10)}`, 80),
      });
    }
    this.logger.log(`Staff alert ${record.id} reviewed: ${decision}`);
    if (record.message) {
      const note =
        decision === "ack"
          ? `Acknowledged by ${by}`
          : decision === "legit"
            ? `Marked legit by ${by}`
            : `Never flag (${by})`;
      try {
        const channel = await this.discord.channels.fetch(record.message.channelId);
        if (channel && channel.type === ChannelType.GuildText)
          await channel.messages.edit(record.message.messageId, { embeds: [this.embed(record, note)] });
      } catch {
        this.logger.warn(`Staff alert ${record.id} review could not be shown in Discord.`);
      }
    }
    return { alert: this.view(record), ...(knownGoodEntry ? { knownGoodEntry } : {}) };
  }

  /** Newest first, at most 100, for one server. */
  list(serverId: string): StaffAlertView[] {
    return this.records
      .filter((record) => record.serverId === serverId)
      .slice(-VIEW_LIMIT)
      .reverse()
      .map((record) => this.view(record));
  }

  private view(record: StoredAlert): StaffAlertView {
    const { key: _key, serverName: _serverName, fields: _fields, links: _links, message: _message, ...view } = record;
    return structuredClone(view);
  }
}
