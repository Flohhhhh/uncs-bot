import { Body, Controller, Get, Param, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { AdminExceptionFilter } from "../admin/admin.controller";
import { MapVotesService } from "./map-votes.service";

@Controller(["admin/api/map-votes", "admin/api/servers/:serverId/map-votes"])
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class MapVotesController {
  constructor(private readonly service: MapVotesService) {}
  @Get() list(@Req() request: StaffRequest) {
    return this.service.list(request.staff);
  }
  @Post() start(@Req() request: StaffRequest, @Body() body: unknown) {
    return this.service.start(request.staff, body);
  }
  @Post(":id/cancel") cancel(@Req() request: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.cancel(request.staff, id, body);
  }
}
