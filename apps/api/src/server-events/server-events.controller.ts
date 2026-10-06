import { Body, Controller, Get, Param, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { AdminExceptionFilter } from "../admin/admin.controller";
import { ServerEventsService } from "./server-events.service";

@Controller(["admin/api/events", "admin/api/servers/:serverId/events"])
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class ServerEventsController {
  constructor(private readonly service: ServerEventsService) {}
  @Get() list(@Req() request: StaffRequest) {
    return this.service.list(request.staff);
  }
  @Get(":id/operations") operations(@Req() request: StaffRequest, @Param("id") id: string) {
    return this.service.history(request.staff, id);
  }
  @Post() start(@Req() request: StaffRequest, @Body() body: unknown) {
    return this.service.start(request.staff, body);
  }
  @Post(":id/stop") stop(@Req() request: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.stop(request.staff, id, body);
  }
  @Post(":id/restore") restore(@Req() request: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.restore(request.staff, id, body);
  }
}
