import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { BotModule } from "./bot/bot.module";
import { CommandsModule } from "./commands/commands.module";
import { EnvModule } from "./env/env.module";
import { ListenersModule } from "./listeners/listeners.module";
import { APP_FILTER } from "@nestjs/core";
import { AppExceptionFilter } from "./common/filters/app-exception.filter";
import { ComponentsModule } from "./components/components.module";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggingModule } from "./common/logging/logging.module";
import { DatabaseModule } from "./database/database.module";
import { AdminModule } from "./admin/admin.module";
import { ApplicationsModule } from "./applications/applications.module";
import { TelemModule } from "./telemetry/telemetry.module";
import { SupportersModule } from "./supporters/supporters.module";
import { ServerCommunityModule } from "./server-community/server-community.module";
import { ServerEventsModule } from "./server-events/server-events.module";
import { DiscordRolesModule } from "./discord-roles/discord-roles.module";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    EnvModule,
    DatabaseModule,
    BotModule,
    CommandsModule,
    ListenersModule,
    ComponentsModule,
    LoggingModule,
    AdminModule,
    ApplicationsModule,
    TelemModule,
    SupportersModule,
    ServerCommunityModule,
    ServerEventsModule,
    DiscordRolesModule,
  ],
  providers: [AppService, { provide: APP_FILTER, useClass: AppExceptionFilter }],
  controllers: [AppController],
})
export class AppModule {}
