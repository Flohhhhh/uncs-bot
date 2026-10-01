import { Controller, Get, Req, UseFilters, UseGuards } from "@nestjs/common";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { AdminExceptionFilter } from "../admin/admin.controller";
import { ServerCommunityService } from "./server-community.service";

@Controller(["admin/api/community-messages", "admin/api/servers/:serverId/community-messages"])
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class ServerCommunityController {
  constructor(private readonly service: ServerCommunityService) {}
  @Get() status(@Req() request: StaffRequest) {
    return this.service.status(request.staff.serverId);
  }
}
