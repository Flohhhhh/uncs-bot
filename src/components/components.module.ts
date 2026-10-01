import { Module, type Provider } from "@nestjs/common";
import { MapVotesModule } from "../map-votes/map-votes.module";
import { MapVotesComponent } from "./handlers/map-votes.component";

const HANDLERS: Provider[] = [MapVotesComponent];

@Module({
  imports: [MapVotesModule],
  providers: [...HANDLERS],
})
export class ComponentsModule {}
