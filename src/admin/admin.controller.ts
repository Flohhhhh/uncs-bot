import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { join } from "node:path";
import { AdminAuth, AdminGuard, AdminServerGuard, type StaffRequest } from "./admin.auth";
import { AdminService } from "./admin.service";

@Catch()
@Injectable()
export class AdminExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 503;
    // Upstream exceptions can contain authorization headers or entire config
    // documents. Neither their stack nor their response belongs in a browser/log.
    const message =
      error instanceof HttpException
        ? error.message
        : "The dashboard is unavailable. Check its connection and database setup.";
    res.status(status).json({ message });
  }
}

@Controller("admin")
@UseFilters(AdminExceptionFilter)
export class AdminPageController {
  constructor(private readonly auth: AdminAuth) {}
  @Get([
    "",
    "overview",
    "players",
    "combat",
    "whitelist",
    "applications",
    "supporters",
    "bans",
    "announcements",
    "match",
    "audit",
    "settings",
    "permissions",
    "votes",
    "events",
  ])
  page(@Res() res: Response) {
    res.sendFile(join(process.cwd(), "dist", "src", "admin", "public", "index.html"));
  }
  @Get("auth/login")
  login(@Res() res: Response) {
    this.auth.login(res);
  }
  @Get("auth/callback")
  callback(@Req() req: Request, @Res() res: Response) {
    return this.auth.callback(req, res);
  }
  @Post("api/logout")
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }
}

@Controller("admin/api")
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard)
export class AdminApiController {
  constructor(private readonly auth: AdminAuth) {}
  @Get("me")
  me(@Req() req: StaffRequest) {
    return req.staff;
  }
  @Get("servers")
  servers(@Req() req: StaffRequest) {
    return this.auth.serverList(req.staff);
  }
}

@Controller(["admin/api", "admin/api/servers/:serverId"])
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class AdminGameController {
  constructor(private readonly service: AdminService) {}
  @Get("settings")
  settings(@Req() req: StaffRequest) {
    return this.service.configuration(req.staff);
  }
  @Get("catalog/maps/:map")
  mapOptions(@Req() req: StaffRequest, @Param("map") map: string) {
    return this.service.mapOptions(map, req.staff.serverId);
  }
  @Post("actions")
  act(@Req() req: StaffRequest, @Body() body: unknown) {
    return this.service.act(req.staff, body);
  }
  @Get(["overview", "bans", "whitelist", "catalog", "rotation", "audit"])
  read(@Req() req: StaffRequest) {
    const resource = req.path.replace(/\/$/, "").split("/").at(-1) ?? "";
    return this.service.read(resource, req.staff.serverId);
  }
  @Get("audit/:id")
  receipt(@Req() req: StaffRequest, @Param("id") id: string) {
    return this.service.receipt(id, req.staff.serverId);
  }
}
