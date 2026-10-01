import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { MapVotesController } from "./map-votes.controller";
import { MapVotesService } from "./map-votes.service";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";

@Module({
  imports: [AdminModule],
  providers: [MapVotesStore, MapVotesDiscord, MapVotesService],
  controllers: [MapVotesController],
  exports: [MapVotesService],
})
export class MapVotesModule {}
