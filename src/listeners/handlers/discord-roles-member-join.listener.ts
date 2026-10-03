import { Injectable } from "@nestjs/common";
import { Events } from "discord.js";
import { Context, type ContextOf, On } from "necord";
import { DiscordRolesService } from "../../discord-roles/discord-roles.service";

/** A rejoining member gets their earned roles back. The event interceptor already logs the join. */
@Injectable()
export class DiscordRolesMemberJoinListener {
  constructor(private readonly roles: DiscordRolesService) {}

  @On(Events.GuildMemberAdd)
  handleGuildMemberAdd(@Context() [member]: ContextOf<Events.GuildMemberAdd>) {
    // Only ADMIN_GUILD_ID counts; the service ignores other guilds and does nothing while switched off.
    this.roles.memberJoined(member.guild.id, member.id);
  }
}
