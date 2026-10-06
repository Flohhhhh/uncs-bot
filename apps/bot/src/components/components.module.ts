import { Module, type Provider } from "@nestjs/common";
import { MapVotesModule } from "../map-votes/map-votes.module";
import { PatronLinkModule } from "../patron-link/patron-link.module";
import { SeedingModule } from "../seeding/seeding.module";
import { MapVotesComponent } from "./handlers/map-votes.component";
import { PatronLinkComponent } from "./handlers/patron-link.component";
import { SeedingComponent } from "./handlers/seeding.component";

const HANDLERS: Provider[] = [MapVotesComponent, SeedingComponent, PatronLinkComponent];

@Module({
  imports: [MapVotesModule, SeedingModule, PatronLinkModule],
  providers: [...HANDLERS],
})
export class ComponentsModule {}
