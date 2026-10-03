import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { StaffAlertsModule } from "../staff-alerts/staff-alerts.module";
import { ServerEventsController } from "./server-events.controller";
import { ServerEventsService } from "./server-events.service";
import { ServerEventsStore } from "./server-events.store";

@Module({
  imports: [AdminModule, StaffAlertsModule],
  controllers: [ServerEventsController],
  providers: [ServerEventsService, ServerEventsStore],
  // Community ballots start and follow a voted 50v50 through this service.
  exports: [ServerEventsService],
})
export class ServerEventsModule {}
