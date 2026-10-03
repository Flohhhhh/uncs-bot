import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { ServerEventsModule } from "../server-events/server-events.module";
import { StaffAlertsModule } from "../staff-alerts/staff-alerts.module";
import { MapVotesController } from "./map-votes.controller";
import { MapVotesService } from "./map-votes.service";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";

@Module({
  // Events never import map votes; a winning 50v50 option starts its event through ServerEventsService.
  imports: [AdminModule, ServerEventsModule, StaffAlertsModule],
  providers: [MapVotesStore, MapVotesDiscord, MapVotesService],
  controllers: [MapVotesController],
  exports: [MapVotesService],
})
export class MapVotesModule {}
