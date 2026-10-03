import { Module, type Provider } from "@nestjs/common";
import { ClientReadyListener } from "./handlers/client-ready.listener";
import { GuildMemberAddListener } from "./handlers/guildMemberAdd.listener";
import { WelcomeModule } from "src/welcome/welcome.module";
import { DiscordRolesModule } from "../discord-roles/discord-roles.module";
import { DiscordRolesMemberJoinListener } from "./handlers/discord-roles-member-join.listener";

const HANDLERS: Provider[] = [ClientReadyListener, GuildMemberAddListener, DiscordRolesMemberJoinListener];

@Module({
  imports: [WelcomeModule, DiscordRolesModule],
  providers: [...HANDLERS],
})
export class ListenersModule {}
