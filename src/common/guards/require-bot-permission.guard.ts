import {
  applyDecorators,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { BaseInteraction, PermissionResolvable } from "discord.js";
import { NecordExecutionContext } from "necord";
import { formatPermissions, replyPermissionError } from "../utils/permission.utils";

const REQUIRED_BOT_PERMISSIONS_KEY = "required_bot_permissions";

/**
 * Guard that ensures the bot has the required permissions to execute a command.
 * Use this over doing manual permission checks in each handler.
 */
@Injectable()
export class RequireBotPermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<PermissionResolvable[]>(REQUIRED_BOT_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const [interaction] = NecordExecutionContext.create(context).getContext();
    if (!interaction || !(interaction instanceof BaseInteraction) || !interaction.guildId) return true;

    // Discord resolves these for the channel the command ran in, threads and uncached channels included.
    const permissions = interaction.appPermissions;
    if (!permissions.has(requiredPermissions)) {
      const missing = permissions.missing(requiredPermissions);
      await replyPermissionError(
        interaction,
        `❌ I need the following permission(s) in this channel: **${formatPermissions(missing)}**.`,
      );
      return false;
    }

    return true;
  }
}

export const RequiredBotPermission = (...permissions: PermissionResolvable[]) =>
  applyDecorators(UseGuards(RequireBotPermissionGuard), SetMetadata(REQUIRED_BOT_PERMISSIONS_KEY, permissions));
