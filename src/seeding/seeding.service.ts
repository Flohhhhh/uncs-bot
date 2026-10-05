import { Injectable, Logger } from "@nestjs/common";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type NewsChannel,
  type Role,
  type TextChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { AdminSettings } from "../admin/admin.settings";
import { GameServers } from "../admin/game-servers";
import { staffRoleFor } from "../common/admin-policy";
import { LEGACY_SERVER_ID } from "../common/game-server";
import { EnvService } from "../env/env.service";
import {
  CHANNEL_PROBLEMS,
  CHANNEL_VIEW_WARNINGS,
  MEMBER_COPY,
  MENTIONABLE_WARNING,
  ROLE_PROBLEMS,
  STAFF_COPY,
  formatDuration,
  panelMessage,
  sanitizeNote,
  seedingCall,
  type ChannelProblem,
  type RoleProblem,
} from "./seeding-copy";

/** Who asked: the interaction's guild (null in DMs), user and channel. */
export type SeedingRequest = { guildId: string | null; userId: string; channelId?: string | null };

export function seedingRequest(interaction: {
  guildId: string | null;
  channelId: string | null;
  user: { id: string };
}): SeedingRequest {
  return { guildId: interaction.guildId, userId: interaction.user.id, channelId: interaction.channelId };
}

/** How long a ping waits for the game's player count before posting without it. */
export const PLAYER_COUNT_TIMEOUT_MS = 10_000;
/** How long the Seeder visibility check waits for Discord's full member list. */
export const MEMBER_LIST_TIMEOUT_MS = 10_000;

/** A role members can give themselves must not carry any of these. */
const ELEVATED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

type SeedingChannel = TextChannel | NewsChannel;
type MemberContext = { guild: Guild; member: GuildMember };
type RoleCheck = { role: Role | null; problem: RoleProblem | null };
/** A warning is a heads-up for staff that never blocks a ping. */
type ChannelCheck = { channel: SeedingChannel | null; problem: ChannelProblem | null; warning?: string };
type ViewCheck = Pick<ChannelCheck, "problem" | "warning">;

function discordCode(error: unknown) {
  return error instanceof DiscordAPIError ? Number(error.code) : undefined;
}

/** Discord answered with a 4xx error, so nothing was posted. Anything else is uncertain. */
function refused(error: unknown) {
  return error instanceof DiscordAPIError && error.status >= 400 && error.status < 500;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A message nonce (Discord allows at most 25 characters) that stays the same if the REST client resends. */
function nonce(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/**
 * The opt-in Seeder role. The role itself is the list of who opted in, so there is no database state. Pings are
 * only ever sent by a staff member running /seeding ping; nothing here runs on a timer or kicks, bans or grants.
 */
@Injectable()
export class SeedingService {
  private readonly logger = new Logger(SeedingService.name);
  /** Per-guild ping cooldowns, in memory only: a restart resets them. */
  private readonly cooldowns = new Map<string, { until: number }>();

  constructor(
    private readonly env: EnvService,
    private readonly admin: AdminSettings,
    private readonly servers: GameServers,
    private readonly discord: Client,
  ) {}

  settings() {
    return {
      enabled: this.env.get("SEEDING_ENABLED") === true,
      guildId: this.env.get("ADMIN_GUILD_ID"),
      roleId: this.env.get("SEEDING_ROLE_ID"),
      channelId: this.env.get("SEEDING_PING_CHANNEL_ID"),
      cooldownMs: this.env.get("SEEDING_PING_COOLDOWN_MINUTES") * 60_000,
    };
  }

  cooldownRemaining(guildId: string, now = Date.now()) {
    const claim = this.cooldowns.get(guildId);
    return claim && claim.until > now ? claim.until - now : 0;
  }

  join(request: SeedingRequest) {
    return this.toggle(request, true);
  }

  leave(request: SeedingRequest) {
    return this.toggle(request, false);
  }

  /** Posts the persistent opt-in buttons in the channel the staff member ran the command in. */
  async panel(request: SeedingRequest): Promise<string> {
    const config = this.settings();
    try {
      // Staff first, so members never see the setup replies meant for staff.
      const context = await this.staff(request, config.guildId);
      if (typeof context === "string") return context;
      if (!config.enabled) return STAFF_COPY.off;
      if (!config.roleId) return STAFF_COPY.roleUnset;
      const { problem } = await this.checkRole(context.guild, config.roleId);
      if (problem) return ROLE_PROBLEMS[problem];
      const channel = request.channelId ? await this.textChannel(context.guild, request.channelId) : null;
      if (!channel) return STAFF_COPY.panelChannel;
      try {
        // Gramps sends once and never retries. The REST client repeats a request that timed out or hit a 5xx;
        // the nonce lets Discord drop that duplicate instead of posting a second panel.
        await channel.send({
          ...panelMessage(),
          nonce: nonce(`seeding-panel:${context.guild.id}:${channel.id}:${Date.now()}`),
          enforceNonce: true,
        });
      } catch (error) {
        if (refused(error)) return STAFF_COPY.panelRefused;
        this.logger.warn(`Seeding panel in channel ${channel.id} was not confirmed: ${describe(error)}`);
        return STAFF_COPY.panelUnknown;
      }
      return STAFF_COPY.panelPosted;
    } catch (error) {
      return this.unexpected("panel", error);
    }
  }

  /**
   * One staff-triggered call to the Seeder role. The cooldown is claimed before the role, channel or game is read,
   * so two staff members pinging at once send one message. It is given back only when nothing was posted.
   */
  async ping(request: SeedingRequest, note?: string | null): Promise<string> {
    const config = this.settings();
    let context: MemberContext | string;
    try {
      // Staff first, so members never see the setup replies meant for staff.
      context = await this.staff(request, config.guildId);
    } catch (error) {
      return this.unexpected("ping", error);
    }
    if (typeof context === "string") return context;
    if (!config.enabled) return STAFF_COPY.off;
    const { roleId, channelId } = config;
    if (!roleId || !channelId) return STAFF_COPY.pingUnset;

    const guildId = context.guild.id;
    const remaining = this.cooldownRemaining(guildId);
    if (remaining > 0) return STAFF_COPY.cooldown(remaining);
    const claimedAt = Date.now();
    const claim = { until: claimedAt + config.cooldownMs };
    this.cooldowns.set(guildId, claim);
    const release = () => {
      if (this.cooldowns.get(guildId) === claim) this.cooldowns.delete(guildId);
    };

    let channel: SeedingChannel;
    let content: string;
    let warning: string | undefined;
    try {
      const { role, problem } = await this.checkRole(context.guild, roleId);
      // Pinging needs the role to exist and be safe, not for Gramps to be able to assign it.
      if (!role || problem === "unsafe") {
        release();
        return `${ROLE_PROBLEMS[problem ?? "missing"]} Nothing was sent.`;
      }
      const target = await this.pingChannel(context.guild, channelId, role);
      if (!target.channel || target.problem) {
        release();
        return `${CHANNEL_PROBLEMS[target.problem ?? "unusable"]} Nothing was sent.`;
      }
      channel = target.channel;
      warning = target.warning;
      const server = this.gameServer();
      content = seedingCall({
        roleId,
        players: await this.players(server?.id),
        joinId: server?.joinId,
        note: sanitizeNote(note),
      });
    } catch (error) {
      release();
      return this.unexpected("ping", error);
    }

    try {
      // Gramps sends once and never retries. The REST client repeats a request that timed out or hit a 5xx;
      // the nonce lets Discord drop that duplicate instead of pinging twice.
      await channel.send({
        content,
        allowedMentions: { roles: [roleId] },
        flags: MessageFlags.SuppressEmbeds,
        nonce: nonce(`seeding-ping:${guildId}:${claimedAt}`),
        enforceNonce: true,
      });
    } catch (error) {
      if (refused(error)) {
        release();
        return STAFF_COPY.pingRefused(channelId);
      }
      this.logger.warn(`Seeding ping in channel ${channelId} was not confirmed: ${describe(error)}`);
      return STAFF_COPY.pingUnknown(channelId);
    }
    const sentReply = STAFF_COPY.pingSent(channelId, config.cooldownMs);
    return warning ? `${sentReply}\n${warning}` : sentReply;
  }

  /** Staff-only summary. Works while the switch is off, so staff can finish the setup first. */
  async status(request: SeedingRequest): Promise<string> {
    const config = this.settings();
    try {
      const context = await this.staff(request, config.guildId);
      if (typeof context === "string") return context;
      const { guild } = context;
      let ready = config.enabled;

      let role: Role | null = null;
      let roleLine = "not set (`SEEDING_ROLE_ID`).";
      if (config.roleId) {
        const check = await this.checkRole(guild, config.roleId);
        role = check.role;
        roleLine = `<@&${config.roleId}>. ${check.problem ? ROLE_PROBLEMS[check.problem] : "Ready."}`;
        ready &&= !check.problem;
      } else ready = false;

      let channelLine = "not set (`SEEDING_PING_CHANNEL_ID`).";
      let channelWarning: string | undefined;
      if (config.channelId) {
        const check = await this.pingChannel(guild, config.channelId, role);
        channelLine = `<#${config.channelId}>. ${check.problem ? CHANNEL_PROBLEMS[check.problem] : "Ready."}`;
        channelWarning = check.warning;
        ready &&= !check.problem;
      } else ready = false;

      const remaining = this.cooldownRemaining(guild.id);
      const lines = [
        "**Seeding status**",
        `Configured: ${ready ? "yes, ready to ping." : "not yet. See below."}`,
        `Switch: ${config.enabled ? "on" : "off"} (\`SEEDING_ENABLED\`).`,
        `Seeder role: ${roleLine}`,
        `Ping channel: ${channelLine}`,
        `Seeders: ${await this.seederCount(guild, role)}.`,
        `Ping cooldown: ${formatDuration(config.cooldownMs)}. ${
          remaining ? `Next ping opens in ${formatDuration(remaining)}.` : "Ready now."
        }`,
      ];
      if (role?.mentionable) lines.push(MENTIONABLE_WARNING);
      if (channelWarning) lines.push(channelWarning);
      return lines.join("\n");
    } catch (error) {
      return this.unexpected("status", error);
    }
  }

  /**
   * The dashboard's admins and moderators: an owner ID or a listed admin or moderator role. Like the dashboard,
   * Discord permissions alone (Manage Roles, Administrator) never count, and a viewer role is not enough.
   */
  isStaff(member: GuildMember) {
    const role = staffRoleFor(member.id, [...member.roles.cache.keys()], this.admin.staffPolicy());
    return role === "admin" || role === "moderator";
  }

  /** Joining needs the switch on. Leaving works whenever the role is set, so nobody is ever stuck with it. */
  private async toggle(request: SeedingRequest, join: boolean): Promise<string> {
    const config = this.settings();
    if (join && !config.enabled) return MEMBER_COPY.off;
    if (!config.guildId || !config.roleId) return MEMBER_COPY.unconfigured;
    try {
      const context = await this.member(request, config.guildId);
      if (typeof context === "string") return context;
      const { role, problem } = await this.checkRole(context.guild, config.roleId);
      if (!role) return problem === "missing" ? MEMBER_COPY.roleMissing : MEMBER_COPY.failed;
      if (problem === "unsafe") return MEMBER_COPY.roleUnusable;
      const has = context.member.roles.cache.has(role.id);
      if (join && has) return MEMBER_COPY.alreadyJoined;
      if (!join && !has) return MEMBER_COPY.alreadyLeft;
      if (problem === "unassignable") return MEMBER_COPY.roleTooLow;
      if (join) await context.member.roles.add(role.id, "Opted in to seeding pings");
      else await context.member.roles.remove(role.id, "Opted out of seeding pings");
      return join ? MEMBER_COPY.joined : MEMBER_COPY.left;
    } catch (error) {
      switch (discordCode(error)) {
        case MISSING_PERMISSIONS:
        case MISSING_ACCESS:
          return MEMBER_COPY.roleTooLow;
        case UNKNOWN_ROLE:
          return MEMBER_COPY.roleMissing;
        case UNKNOWN_MEMBER:
          return MEMBER_COPY.notMember;
      }
      this.logger.warn(`Seeder role ${join ? "add" : "removal"} failed: ${describe(error)}`);
      return MEMBER_COPY.failed;
    }
  }

  private async member(request: SeedingRequest, guildId: string): Promise<MemberContext | string> {
    if (request.guildId !== guildId) return MEMBER_COPY.outsideGuild;
    const guild = await this.discord.guilds.fetch(guildId);
    try {
      return { guild, member: await guild.members.fetch(request.userId) };
    } catch (error) {
      if (discordCode(error) === UNKNOWN_MEMBER) return MEMBER_COPY.notMember;
      throw error;
    }
  }

  private async staff(request: SeedingRequest, guildId: string | undefined): Promise<MemberContext | string> {
    // Without ADMIN_GUILD_ID no roles can be read, so only an owner ID gets the setup hint; everyone else
    // gets the plain member reply.
    if (!guildId)
      return this.admin.staffPolicy().ownerIds.includes(request.userId)
        ? STAFF_COPY.guildUnset
        : MEMBER_COPY.unconfigured;
    const context = await this.member(request, guildId);
    if (typeof context === "string") return context;
    return this.isStaff(context.member) ? context : STAFF_COPY.staffOnly;
  }

  private async me(guild: Guild) {
    return guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  }

  private async checkRole(guild: Guild, roleId: string): Promise<RoleCheck> {
    let role: Role | null;
    try {
      role = await guild.roles.fetch(roleId);
    } catch (error) {
      return { role: null, problem: discordCode(error) === UNKNOWN_ROLE ? "missing" : "unavailable" };
    }
    if (!role) return { role: null, problem: "missing" };
    if (this.unsafe(guild, role)) return { role, problem: "unsafe" };
    const me = await this.me(guild);
    if (me && (!me.permissions.has(PermissionFlagsBits.ManageRoles) || me.roles.highest.comparePositionTo(role) <= 0))
      return { role, problem: "unassignable" };
    return { role, problem: null };
  }

  /**
   * @everyone, integration roles, staff roles and roles with moderation powers are never self-assignable. Powers
   * count whether the role has them server-wide or through a channel permission override in Gramps' cache.
   */
  private unsafe(guild: Guild, role: Role) {
    const staff = this.admin.staffPolicy();
    // Gramps' automatic UNC, Founder and Supporter roles are earned, so a button must never hand them out.
    const automatic = [
      this.env.get("DISCORD_MEMBER_ROLE_ID"),
      this.env.get("DISCORD_FOUNDER_ROLE_ID"),
      this.env.get("DISCORD_SUPPORTER_ROLE_ID"),
    ];
    return (
      role.id === guild.id ||
      role.managed ||
      [...staff.adminRoleIds, ...staff.moderatorRoleIds, ...staff.viewerRoleIds].includes(role.id) ||
      automatic.includes(role.id) ||
      role.permissions.any(ELEVATED_PERMISSIONS) ||
      guild.channels.cache.some(
        (channel) =>
          "permissionOverwrites" in channel &&
          channel.permissionOverwrites.cache.get(role.id)?.allow.any(ELEVATED_PERMISSIONS) === true,
      )
    );
  }

  /** A text or announcement channel in this guild where Gramps can view and post. */
  private async textChannel(guild: Guild, channelId: string): Promise<SeedingChannel | null> {
    let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
    try {
      channel = await this.discord.channels.fetch(channelId);
    } catch {
      return null;
    }
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
      channel.guildId !== guild.id
    )
      return null;
    const me = await this.me(guild);
    if (!me || !channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
      return null;
    return channel;
  }

  /**
   * The ping channel, plus whether the ping can actually notify Seeders there: Gramps must be able to mention the
   * role, and Seeders must be able to see the channel. Otherwise the ping is silent.
   */
  private async pingChannel(guild: Guild, channelId: string, role: Role | null): Promise<ChannelCheck> {
    const channel = await this.textChannel(guild, channelId);
    if (!channel) return { channel: null, problem: "unusable" };
    const me = await this.me(guild);
    if (role && !role.mentionable && !(me && channel.permissionsFor(me).has(PermissionFlagsBits.MentionEveryone)))
      return { channel, problem: "cannot-mention" };
    if (!role) return { channel, problem: null };
    return { channel, ...(await this.seederView(guild, channel, role)) };
  }

  /**
   * Discord doesn't notify anyone about a mention in a channel they can't view. When @everyone or Seeder can view
   * the channel, Seeders see it. Otherwise they may still see it through another role, so each Seeder is checked
   * against the full member list. Only "no Seeder can see it" is a problem; anything Gramps can't settle is a
   * warning, so a setup that works through another role is never refused.
   */
  private async seederView(guild: Guild, channel: SeedingChannel, role: Role): Promise<ViewCheck> {
    if (channel.permissionsFor(role).has(PermissionFlagsBits.ViewChannel)) return { problem: null };
    const seeders = (await this.allMembersLoaded(guild)) ? role.members : null;
    if (!seeders?.size) return { problem: null, warning: CHANNEL_VIEW_WARNINGS.unknown };
    const hidden = seeders.filter((seeder) => !channel.permissionsFor(seeder).has(PermissionFlagsBits.ViewChannel));
    if (hidden.size === seeders.size) return { problem: "hidden" };
    if (hidden.size) return { problem: null, warning: CHANNEL_VIEW_WARNINGS.some(hidden.size, seeders.size) };
    return { problem: null };
  }

  /** Whether every member is in Gramps' cache, loading the list once when the GuildMembers intent allows it. */
  private async allMembersLoaded(guild: Guild) {
    if (guild.members.cache.size >= guild.memberCount) return true;
    if (!this.discord.options.intents.has(GatewayIntentBits.GuildMembers)) return false;
    try {
      await guild.members.fetch({ time: MEMBER_LIST_TIMEOUT_MS });
      return true;
    } catch (error) {
      this.logger.warn(`Could not load the member list for the Seeder check: ${describe(error)}`);
      return false;
    }
  }

  /** The primary WARDOGS server: the legacy single server, or the registry's `primary` entry (else its first). */
  private gameServer() {
    const servers = this.servers.list();
    return servers.find((server) => server.id === LEGACY_SERVER_ID) ?? servers[0];
  }

  /** The current player count from the cached overview, or null when the game can't be read in time. */
  private async players(serverId: string | undefined) {
    if (!serverId) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const overview = await Promise.race([
        this.servers.get(serverId).overview(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The player count timed out.")), PLAYER_COUNT_TIMEOUT_MS);
        }),
      ]);
      const { current, max } = overview.status.players;
      return Number.isInteger(current) && Number.isInteger(max) && current >= 0 && max > 0 ? { current, max } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async seederCount(guild: Guild, role: Role | null) {
    if (!role) return "unknown";
    try {
      const count = (await guild.roles.fetchMemberCounts()).get(role.id);
      if (typeof count === "number") return `${count}`;
    } catch {
      // Fall back to the member cache below.
    }
    return `at least ${role.members.size} (from cache)`;
  }

  private unexpected(action: string, error: unknown) {
    this.logger.warn(`Seeding ${action} failed: ${describe(error)}`);
    return STAFF_COPY.failed;
  }
}
