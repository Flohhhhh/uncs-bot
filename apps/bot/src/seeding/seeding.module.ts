import { Module } from "@nestjs/common";
import { SeedingBusiness } from "./seeding.business";
import { SeedingService } from "./seeding.service";

/** Shared by the /seeding command and the panel buttons, so both see one in-memory ping cooldown. */
@Module({
  providers: [SeedingService, SeedingBusiness],
  exports: [SeedingService, SeedingBusiness],
})
export class SeedingModule {}
