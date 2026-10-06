import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { memberView, readiness, rolesCheck, acknowledged } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
import type { DiscordRoleKind, RolesCheck } from "./discord-roles.types";
export type RoleMember = {
  id: string;
  joinedAt: Date | null;
  has(roleId: string): boolean;
  add(roleId: string, reason: string, operationId?: string): Promise<unknown>;
  remove(roleId: string, reason: string, operationId?: string): Promise<unknown>;
};
@Injectable()
export class DiscordRolesDiscord {
  constructor(private readonly remote: RemoteService) {}
  async ready() {
    try {
      return (await this.remote.request("/internal/v1/discord/ready", readiness)).gateway === true;
    } catch {
      return false;
    }
  }
  check(
    guildId: string,
    roleIds: Record<DiscordRoleKind, string | undefined>,
    staffRoleIds: string[],
    seederRoleId?: string | null,
  ): Promise<RolesCheck> {
    return this.remote.request("/internal/v1/roles/check", rolesCheck, {
      guildId,
      roleIds,
      staffRoleIds,
      seederRoleId,
    });
  }
  async member(guildId: string, userId: string): Promise<RoleMember | null> {
    const member = await this.remote.request("/internal/v1/roles/member", memberView, { guildId, userId });
    if (!member) return null;
    return {
      id: member.id,
      joinedAt: member.joinedAt ? new Date(member.joinedAt) : null,
      has: (id) => member.roles.includes(id),
      add: (roleId, reason, operationId = randomUUID()) =>
        this.remote.request("/internal/v1/roles/add", acknowledged, { guildId, userId, roleId, reason, operationId }),
      remove: (roleId, reason, operationId = randomUUID()) =>
        this.remote.request("/internal/v1/roles/remove", acknowledged, {
          guildId,
          userId,
          roleId,
          reason,
          operationId,
        }),
    };
  }
}
