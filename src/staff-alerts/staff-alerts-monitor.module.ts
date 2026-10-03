import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { TelemModule } from "../telemetry/telemetry.module";
import { FEED_CONTEXT, TelemetryFeedContext } from "./feed-context";
import { EnvWatchlistSource, NETWORK_BAN_SOURCES } from "./network-bans";
import { StaffAlertsController } from "./staff-alerts.controller";
import { StaffAlertsModule } from "./staff-alerts.module";
import { StaffAlertsMonitor } from "./staff-alerts.monitor";

/**
 * Health, seeding, performance and watch-list monitoring. Kept apart from StaffAlertsModule so a
 * feature can raise staff alerts without importing AdminModule and the monitor.
 */
@Module({
  imports: [AdminModule, StaffAlertsModule, TelemModule],
  providers: [
    StaffAlertsMonitor,
    EnvWatchlistSource,
    {
      provide: NETWORK_BAN_SOURCES,
      useFactory: (watchlist: EnvWatchlistSource) => [watchlist],
      inject: [EnvWatchlistSource],
    },
    { provide: FEED_CONTEXT, useClass: TelemetryFeedContext },
  ],
  controllers: [StaffAlertsController],
})
export class StaffAlertsMonitorModule {}
