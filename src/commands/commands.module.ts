import { Module, type Provider } from "@nestjs/common";
import { PingCommand } from "./handlers/ping.command";
import { WhatisCommand } from "./handlers/whatis.command";
import { PurgeCommand } from "./handlers/purge.command";
import { UptimeCommand } from "./handlers/uptime.command";
import { WelcomeCommandHandler } from "./handlers/welcome.command";
import { WelcomeModule } from "src/welcome/welcome.module";

// You can easily disable commands by removing them from this array.
// This way, you can keep the code as reference but not have it active.
// Alternatively, you could just delete the files and refer to the GitHub history if needed.
const HANDLERS: Provider[] = [PingCommand, WhatisCommand, PurgeCommand, UptimeCommand, WelcomeCommandHandler];

@Module({
  imports: [WelcomeModule],
  providers: [...HANDLERS],
})
export class CommandsModule {}
