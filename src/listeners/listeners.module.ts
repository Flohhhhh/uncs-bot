import { Module, type Provider } from "@nestjs/common";
import { ClientReadyListener } from "./handlers/client-ready.listener";
import { GuildMemberAddListener } from "./handlers/guildMemberAdd.listener";
import { WelcomeModule } from "src/welcome/welcome.module";

const HANDLERS: Provider[] = [ClientReadyListener, GuildMemberAddListener];

@Module({
  imports: [WelcomeModule],
  providers: [...HANDLERS],
})
export class ListenersModule {}
