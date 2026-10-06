import { Module } from "@nestjs/common";
import { DiscordRolesService } from "./discord-roles.service";
@Module({ providers: [DiscordRolesService], exports: [DiscordRolesService] })
export class DiscordRolesModule {}
