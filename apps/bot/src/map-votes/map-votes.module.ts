import { Module } from "@nestjs/common";
import { MapVotesService } from "./map-votes.service";
@Module({ providers: [MapVotesService], exports: [MapVotesService] })
export class MapVotesModule {}
