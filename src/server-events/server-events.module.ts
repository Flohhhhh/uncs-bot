import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { ServerEventsController } from "./server-events.controller";
import { ServerEventsService } from "./server-events.service";
import { ServerEventsStore } from "./server-events.store";

@Module({
  imports: [AdminModule],
  controllers: [ServerEventsController],
  providers: [ServerEventsService, ServerEventsStore],
})
export class ServerEventsModule {}
