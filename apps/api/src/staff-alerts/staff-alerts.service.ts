import { StaffAlertsDiscord } from "./staff-alerts.discord";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { escapeMarkdown } from "discord.js";
import { randomBytes } from "node:crypto";
import { EnvService } from "../env/env.service";
import { LEGACY_SERVER_ID, LEGACY_SERVER_NAME } from "../common/game-server";
import {
  alertCategory,
  reviewDecisions,
  SAFE_LINK,
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
/** One automation alert per key and server every 30 minutes, and at most 10 per server an hour. */
const AUTOMATION_REPEAT_MS = 30 * 60_000;
const AUTOMATION_PER_HOUR = 10;

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
  message: { channelId: string; messageId: string } | null;
};
type ChannelCheck = { state: StaffAlertsChannelState; channel: { id: string; ping: StaffAlertsPingState } | null };

/** Bidi controls and zero-width characters. Keeps U+200D and tag characters, which emoji sequences use. */
const INVISIBLE = /[\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
/**
 * Nothing visible: spaces, format characters, the characters Unicode marks as ignorable (fillers,
 * variation selectors and invisible marks) and the blank Braille pattern.
 */
const BLANK = /^[\p{Z}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]*$/u;

/** Game-controlled or staff text: no control, bidi or zero-width characters, collapsed spaces, capped. */
export function cleanText(value: string, max: number) {
  const text = [...value.replace(INVISIBLE, "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** A player name for staff text, or "Unknown" when nothing visible is left. */
export function playerLabel(name: string) {
  const text = cleanText(name, 64);
  return BLANK.test(text) ? "Unknown" : text;
}
/**
 * Text for an embed: cleaned, Markdown escaped and unable to form a mention. Also escapes what
 * escapeMarkdown leaves alone: link brackets, line-start subtext and quotes, and every `<` construct.
 * escapeMarkdown never sees a `<`, because its `<:` and `<scheme:/` exceptions would leave the
 * italics after one unescaped; each `<` comes back followed by a zero-width space, so it cannot open
 * an emoji, mention, timestamp, command or channel link. cleanText turns U+0001 into a space, so the
 * placeholder cannot already be in the text.
 */
export function discordText(value: string, max = 600) {
  const text = cleanText(value, max).replaceAll("<", "\u0001");
  return escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true })
    .replace(/^(\s*)(-#|>)/gm, "$1\\$2")
    .replace(/(?<!\\)((?:\\\\)*)([[\]])/g, "$1\\$2")
    .replace(/@(everyone|here)/gi, "@​$1")
    .replaceAll("\u0001", "<​");
}

/**
 * Tells staff about things that need a person: the monitor's health, seeding, performance and
 * watch-list alerts (raise) and map-vote and 50v50 automation (send). Alert-only: it never changes
 * the game. Posts to the optional STAFF_ALERTS_CHANNEL_ID only, never to a community, voting,
 * leaderboard or status channel, and refuses a channel that @everyone can view. Delivery is best
 * effort and never throws into a worker. Records stay in memory (200 per server, 1,000 in all) and
 * are lost on restart.
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
    private readonly discord: StaffAlertsDiscord,
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
  /** The configured server name, the same one GameServers gives the monitor's alerts; undefined when unknown. */
  private serverName(serverId: string) {
    const configured = this.env.get("WARDOGS_SERVERS");
    if (configured) return configured.find((server) => server.id === serverId)?.name;
    return serverId === LEGACY_SERVER_ID ? LEGACY_SERVER_NAME : undefined;
  }

  /**
   * Map-vote and 50v50 automation that needs a person. Logs the text, then records an `automation`
   * alert and posts it like any other: the same channel checks and refusals, no mentions (warning
   * severity, never a ping) and no snooze. The footer names the configured server, as the monitor's
   * alerts do. The same key repeats at most every 30 minutes, and at most 10 a server post per
   * rolling hour. Returns true only when the alert was posted. Never throws.
   */
  async send(serverId: string, key: string, message: string): Promise<boolean> {
    const text = cleanText(message, 1800);
    this.logger.warn(`Staff alert for ${serverId}: ${text}`);
    try {
      const alert = await this.raise({
        serverId,
        serverName: this.serverName(serverId),
        kind: "automation",
        severity: "warning",
        key: `automation:${key}`,
        repeatMs: AUTOMATION_REPEAT_MS,
        title: "Automation needs a person",
        lines: [text],
        deliver: true,
      });
      return alert?.delivery.state === "posted";
    } catch {
      this.logger.warn("A staff alert could not be recorded. It remains in the log.");
      return false;
    }
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
      player: input.player ? { steamId: input.player.steamId, name: playerLabel(input.player.name) } : null,
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
    if (category === "automation") return AUTOMATION_PER_HOUR;
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
  private pingReady(channel: { ping: StaffAlertsPingState }) {
    return channel.ping;
  }
  async channelCheck(): Promise<ChannelCheck> {
    const check = await this.discord.check();
    return { state: check.state, channel: check.channelId ? { id: check.channelId, ping: check.ping } : null };
  }
  async channelStatus() {
    const check = await this.discord.check();
    return { configured: !!this.env.get("STAFF_ALERTS_CHANNEL_ID"), state: check.state, ping: check.ping };
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
      record.category !== "automation" &&
      !!role &&
      this.pingReady(check.channel) === "ok" &&
      now - this.lastPingAt >= PING_INTERVAL_MS;
    // Reserve the ping before the send, so an alert from another server meanwhile does not ping too.
    const previousPingAt = this.lastPingAt;
    if (ping) this.lastPingAt = now;
    try {
      const messageId = await this.discord.send(record, ping);
      record.message = { channelId: check.channel.id, messageId };
      if (ping) record.pinged = true;
      return { state: "posted", reason: null };
    } catch {
      if (ping && this.lastPingAt === now) this.lastPingAt = previousPingAt;
      return { state: "failed", reason: "discord error" };
    }
  }

  private snoozed(serverId: string, category: StaffAlertCategory, now: number) {
    // A ballot or 50v50 that needs a person is never held back by a snooze.
    if (category === "automation") return false;
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
        await this.discord.edit(record, record.message.messageId, note);
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
