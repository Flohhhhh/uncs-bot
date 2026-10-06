import { RenderController } from "./internal/render.controller";
import { Controller, Get, Module, ServiceUnavailableException } from "@nestjs/common";
import { ConditionalModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { APP_FILTER } from "@nestjs/core";
import { Client } from "discord.js";
import { EnvModule } from "./env/env.module";
import { BotModule } from "./bot/bot.module";
import { CommandsModule } from "./commands/commands.module";
import { ListenersModule } from "./listeners/listeners.module";
import { ComponentsModule } from "./components/components.module";
import { LoggingModule } from "./common/logging/logging.module";
import { AppExceptionFilter } from "./common/filters/app-exception.filter";
import { PatronLinkCommandsModule, patronLinkCommandsEnabled } from "./patron-link/patron-link-commands.module";
import { TransportModule } from "./internal/transport";
import { DeliveryController } from "./internal/delivery.controller";
import { DiscordRolesDiscord } from "./discord-roles/discord-roles.discord";
import { MapVotesDiscord } from "./map-votes/map-votes.discord";
import { WeeklyLeaderboardDiscord } from "./weekly-leaderboard/weekly-leaderboard.discord";
import { StaffAlertsDiscord } from "./staff-alerts/staff-alerts.discord";
const active = process.env.BOT_GATEWAY_ENABLED === "true";
@Controller("health")
class PassiveHealth {
  @Get("live") live() {
    return { status: "ok" };
  }
  @Get("ready") ready() {
    return { status: "passive", gateway: false };
  }
}
@Controller("health")
class ActiveHealth {
  constructor(private readonly client: Client) {}
  @Get("live") live() {
    return { status: "ok" };
  }
  @Get("ready") ready() {
    if (!this.client.isReady()) throw new ServiceUnavailableException("Discord gateway is not ready.");
    return { status: "ready", gateway: true };
  }
}
@Module({
  imports: [
    EnvModule,
    TransportModule,
    ...(active
      ? [
          ScheduleModule.forRoot(),
          BotModule,
          CommandsModule,
          ListenersModule,
          ComponentsModule,
          LoggingModule,
          ConditionalModule.registerWhen(PatronLinkCommandsModule, patronLinkCommandsEnabled),
        ]
      : []),
  ],
  controllers: active ? [ActiveHealth, DeliveryController, RenderController] : [PassiveHealth, RenderController],
  providers: active
    ? [
        DiscordRolesDiscord,
        MapVotesDiscord,
        WeeklyLeaderboardDiscord,
        StaffAlertsDiscord,
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ]
    : [],
})
export class AppModule {}
