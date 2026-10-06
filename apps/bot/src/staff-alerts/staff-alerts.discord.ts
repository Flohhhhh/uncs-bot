import { Injectable } from "@nestjs/common";
import { ChannelType, Client, escapeMarkdown, PermissionFlagsBits, type APIEmbed, type TextChannel } from "discord.js";
import type { AlertDisplay } from "@uncs/contracts";
import { EnvService } from "../env/env.service";
import type { StaffAlertSeverity, StaffAlertsChannelState, StaffAlertsPingState } from "../common/staff-alerts";
const COLORS: Record<StaffAlertSeverity, number> = { info: 0x95a5a6, warning: 0xe6a23c, high: 0xe74c3c };
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];
type ChannelCheck = { state: StaffAlertsChannelState; channel: TextChannel | null };
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
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

@Injectable()
export class StaffAlertsDiscord {
  constructor(
    private readonly discord: Client,
    private readonly env: EnvService,
  ) {}
  private communityChannel(channelId: string) {
    const community = [
      this.env.get("MAP_VOTES_CHANNEL_ID"),
      this.env.get("SERVER_COMMUNITY_DISCORD_CHANNEL_ID"),
      this.env.get("WEEKLY_LEADERBOARD_CHANNEL_ID"),
      ...(this.env.get("WARDOGS_SERVERS") ?? []).map((server) => server.communityStatus?.channelId),
    ];
    return community.includes(channelId);
  }
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
  pingReady(channel: TextChannel): StaffAlertsPingState {
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

  embed(record: AlertDisplay, footerNote?: string): APIEmbed {
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
}
