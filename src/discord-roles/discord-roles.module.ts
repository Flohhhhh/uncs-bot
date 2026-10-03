import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { DiscordRolesController, DiscordRolesExceptionFilter } from "./discord-roles.controller";
import { DiscordRolesDiscord } from "./discord-roles.discord";
import { DiscordRolesService } from "./discord-roles.service";
import { DiscordRolesStore } from "./discord-roles.store";

/**
 * Reads application and supporter tables through its own store and imports neither feature module,
 * so Applications, Supporters and Listeners can all import this module without a cycle.
 */
@Module({
  imports: [AdminModule],
  providers: [DiscordRolesStore, DiscordRolesDiscord, DiscordRolesService, DiscordRolesExceptionFilter],
  controllers: [DiscordRolesController],
  exports: [DiscordRolesService],
})
export class DiscordRolesModule {}
