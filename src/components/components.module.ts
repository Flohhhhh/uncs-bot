import { Module, type Provider } from "@nestjs/common";
import { MapVotesModule } from "../map-votes/map-votes.module";
import { SeedingModule } from "../seeding/seeding.module";
import { MapVotesComponent } from "./handlers/map-votes.component";
import { SeedingComponent } from "./handlers/seeding.component";

const HANDLERS: Provider[] = [MapVotesComponent, SeedingComponent];

@Module({
  imports: [MapVotesModule, SeedingModule],
  providers: [...HANDLERS],
})
export class ComponentsModule {}
