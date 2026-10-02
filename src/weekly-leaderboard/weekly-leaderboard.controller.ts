import { Body, Controller, Get, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { AdminExceptionFilter } from "../admin/admin.controller";
import { WeeklyLeaderboardService } from "./weekly-leaderboard.service";

@Controller(["admin/api/weekly-leaderboard", "admin/api/servers/:serverId/weekly-leaderboard"])
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class WeeklyLeaderboardController {
  constructor(private readonly service: WeeklyLeaderboardService) {}
  @Get() status(@Req() request: StaffRequest) {
    return this.service.status(request.staff);
  }
  @Get("preview") preview(@Req() request: StaffRequest, @Query("week") week: unknown) {
    return this.service.preview(request.staff, week);
  }
  @Post("post") post(@Req() request: StaffRequest, @Body() body: unknown) {
    return this.service.post(request.staff, body);
  }
}
