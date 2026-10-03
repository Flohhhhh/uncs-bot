import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { SeedingService } from "./seeding.service";

/** Shared by the /seeding command and the panel buttons, so both see one in-memory ping cooldown. */
@Module({
  imports: [AdminModule],
  providers: [SeedingService],
  exports: [SeedingService],
})
export class SeedingModule {}
