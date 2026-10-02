import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { TelemModule } from "../telemetry/telemetry.module";
import { WeeklyLeaderboardController } from "./weekly-leaderboard.controller";
import { WeeklyLeaderboardDiscord } from "./weekly-leaderboard.discord";
import { WeeklyLeaderboardService } from "./weekly-leaderboard.service";

@Module({
  imports: [AdminModule, TelemModule],
  providers: [WeeklyLeaderboardDiscord, WeeklyLeaderboardService],
  controllers: [WeeklyLeaderboardController],
})
export class WeeklyLeaderboardModule {}
