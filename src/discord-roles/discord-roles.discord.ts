import { Injectable } from "@nestjs/common";
import { Client, PermissionFlagsBits, type Role } from "discord.js";
import {
  classifyDiscordError,
  ROLE_KINDS,
  type DiscordRoleKind,
  type RoleCheckView,
  type RolesCheck,
} from "./discord-roles.types";

/** A role that grants any of these is never assigned automatically. */
const PRIVILEGED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.MentionEveryone,
];
const LABELS: Record<DiscordRoleKind, { name: string; env: string }> = {
  member: { name: "UNC", env: "DISCORD_MEMBER_ROLE_ID" },
  founder: { name: "Founder", env: "DISCORD_FOUNDER_ROLE_ID" },
  supporter: { name: "Supporter", env: "DISCORD_SUPPORTER_ROLE_ID" },
};

/** The parts of a guild member the role pass needs; a test double needs nothing else. */
export type RoleMember = {
  id: string;
  joinedAt: Date | null;
  has(roleId: string): boolean;
  add(roleId: string, reason: string): Promise<unknown>;
  remove(roleId: string, reason: string): Promise<unknown>;
};

@Injectable()
export class DiscordRolesDiscord {
  constructor(private readonly client: Client) {}

  ready() {
    return this.client.isReady();
  }

  /** Reads the bot's own permissions and every configured role. Nothing is changed. */
  async check(
    guildId: string,
    roleIds: Record<DiscordRoleKind, string | undefined>,
    staffRoleIds: string[],
  ): Promise<RolesCheck> {
    const guild = await this.client.guilds.fetch(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    // The role cache is kept current by gateway events; fetch only when it was never filled.
    const roles = guild.roles.cache.size ? guild.roles.cache : await guild.roles.fetch();
    const manageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
    const candidates = (name: string) =>
      [...roles.values()].filter((role) => role.name === name).map((role) => ({ id: role.id, name: role.name }));
    const view = (kind: DiscordRoleKind): RoleCheckView => {
      const id = roleIds[kind] ?? null,
        label = LABELS[kind];
      const shared = ROLE_KINDS.find((other) => other !== kind && roleIds[other] === id);
      const role: Role | undefined = id ? roles.get(id) : undefined;
      if (!id || !role)
        return {
          id,
          name: null,
          exists: false,
          position: null,
          managed: false,
          privileged: false,
          staffRole: false,
          assignable: false,
          problem: id
            ? `No role with ID ${id} exists in this Discord server. Copy the ${label.name} role ID into ${label.env} again.`
            : `Set ${label.env} to the ${label.name} role ID (Server Settings, Roles, right-click the role, Copy Role ID).`,
          candidates: candidates(label.name),
        };
      const privileged = role.permissions.any(PRIVILEGED_PERMISSIONS);
      const staffRole = staffRoleIds.includes(role.id);
      const problem =
        role.id === guild.id
          ? `This is the @everyone role. Set ${label.env} to the ${label.name} role.`
          : role.managed
            ? "This role is managed by an integration or bot and cannot be assigned. Choose a normal role."
            : privileged
              ? "This role grants moderation or administrator permissions. Gramps only assigns roles without them."
              : staffRole
                ? "This role is a dashboard staff role. Use a separate role for the community tag."
                : shared
                  ? `The ${label.name} and ${LABELS[shared].name} roles must be two different roles.`
                  : !manageRoles
                    ? "Give the bot's role the Manage Roles permission."
                    : !role.editable
                      ? `Drag the bot's role above "${role.name}" in Server Settings, Roles.`
                      : null;
      return {
        id,
        name: role.name,
        exists: true,
        position: role.position,
        managed: role.managed,
        privileged,
        staffRole,
        assignable: problem === null,
        problem,
      };
    };
    return {
      manageRoles,
      highestRolePosition: me.roles.highest.position,
      roles: Object.fromEntries(ROLE_KINDS.map((kind) => [kind, view(kind)])) as Record<DiscordRoleKind, RoleCheckView>,
    };
  }

  /** A fresh read of one member, or null when they are not in the server. */
  async member(guildId: string, userId: string): Promise<RoleMember | null> {
    const guild = await this.client.guilds.fetch(guildId);
    try {
      const member = await guild.members.fetch({ user: userId, force: true });
      return {
        id: member.id,
        joinedAt: member.joinedAt,
        has: (roleId) => member.roles.cache.has(roleId),
        add: (roleId, reason) => member.roles.add(roleId, reason),
        remove: (roleId, reason) => member.roles.remove(roleId, reason),
      };
    } catch (error) {
      if (classifyDiscordError(error) === "left") return null;
      throw error;
    }
  }
}
