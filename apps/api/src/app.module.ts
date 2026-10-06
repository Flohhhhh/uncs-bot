import { BusinessModule } from "./internal/business.controller";
import { TransportModule } from "./internal/transport";
import { Module } from "@nestjs/common";
import { EnvModule } from "./env/env.module";
import { DatabaseModule } from "./database/database.module";
import { AdminModule } from "./admin/admin.module";
import { ApplicationsModule } from "./applications/applications.module";
import { TelemModule } from "./telemetry/telemetry.module";
import { SupportersModule } from "./supporters/supporters.module";
import { ServerCommunityModule } from "./server-community/server-community.module";
import { ServerEventsModule } from "./server-events/server-events.module";
import { DiscordRolesModule } from "./discord-roles/discord-roles.module";
import { WeeklyLeaderboardModule } from "./weekly-leaderboard/weekly-leaderboard.module";
import { StaffAlertsMonitorModule } from "./staff-alerts/staff-alerts-monitor.module";
import { PatronLinkModule } from "./patron-link/patron-link.module";
import { MapVotesModule } from "./map-votes/map-votes.module";
import { RuntimeModule } from "./internal/runtime";

@Module({
  imports: [
    BusinessModule,
    TransportModule,
    EnvModule,
    DatabaseModule,
    AdminModule,
    ApplicationsModule,
    TelemModule,
    SupportersModule,
    ServerCommunityModule,
    ServerEventsModule,
    DiscordRolesModule,
    WeeklyLeaderboardModule,
    StaffAlertsMonitorModule,
    PatronLinkModule,
    MapVotesModule,
    RuntimeModule,
  ],
})
export class AppModule {}
