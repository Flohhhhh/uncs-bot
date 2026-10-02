import { Module } from "@nestjs/common";
import { StaffAlerts } from "./staff-alerts.service";

@Module({
  providers: [StaffAlerts],
  exports: [StaffAlerts],
})
export class StaffAlertsModule {}
