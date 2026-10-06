import { StaffAlertsDiscord } from "./staff-alerts.discord";
import { Module } from "@nestjs/common";
import { StaffAlerts } from "./staff-alerts.service";

@Module({
  providers: [StaffAlerts, StaffAlertsDiscord],
  exports: [StaffAlerts],
})
export class StaffAlertsModule {}
