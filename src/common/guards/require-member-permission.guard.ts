import {
  applyDecorators,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { BaseInteraction, GuildChannel, PermissionResolvable } from "discord.js";
import { NecordExecutionContext } from "necord";
import { formatPermissions, replyPermissionError } from "../utils/permission.utils";

const REQUIRED_MEMBER_PERMISSIONS_KEY = "required_member_permissions";

/**
 * Guard that ensures the member has the required permissions to execute a command.
 * Use this over doing manual permission checks in each handler.
 */
@Injectable()
export class RequireMemberPermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<PermissionResolvable[]>(
      REQUIRED_MEMBER_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const [interaction] = NecordExecutionContext.create(context).getContext();
    if (!interaction || !(interaction instanceof BaseInteraction) || !interaction.guild) return true;

    const channel = interaction.channel;
    if (!channel || !(channel instanceof GuildChannel)) return true;

    const permissions = interaction.memberPermissions;
    if (!permissions || !permissions.has(requiredPermissions)) {
      const missing = permissions?.missing(requiredPermissions) ?? requiredPermissions;
      await replyPermissionError(
        interaction,
        `❌ You need the following permission(s) to use this command: **${formatPermissions(missing)}**.`,
      );
      return false;
    }

    return true;
  }
}

export const RequiredMemberPermission = (...permissions: PermissionResolvable[]) =>
  applyDecorators(UseGuards(RequireMemberPermissionGuard), SetMetadata(REQUIRED_MEMBER_PERMISSIONS_KEY, permissions));
