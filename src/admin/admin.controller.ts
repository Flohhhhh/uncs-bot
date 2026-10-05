import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Injectable,
  Logger,
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
    // A locally raised validation error may name the field it refers to, so forms can highlight it.
    const response = error instanceof HttpException ? error.getResponse() : null;
    const path =
      response && typeof response === "object" && "path" in response && Array.isArray(response.path)
        ? response.path
        : null;
    const field =
      path && path.length <= 10 && path.every((part) => typeof part === "string" || typeof part === "number")
        ? path.map((part) => String(part).slice(0, 60))
        : null;
    res.status(status).json(field ? { message, path: field } : { message });
  }
}

@Controller("admin")
@UseFilters(AdminExceptionFilter)
export class AdminPageController {
  private readonly logger = new Logger(AdminPageController.name);
  constructor(private readonly auth: AdminAuth) {}
  @Get([
    "",
    "overview",
    "activity",
    "players",
    "combat",
    "whitelist",
    "applications",
    "supporters",
    "discord-roles",
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
    // Without a callback a missing dashboard build goes to Express's error chain as an fs error, and that
    // chain writes its message, the server's path, to the browser. These pages need no session.
    res.sendFile(
      join(process.cwd(), "dist", "src", "admin", "public", "index.html"),
      (error?: Error & { code?: string }) => {
        if (!error || error.code === "ECONNABORTED") return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        this.logger.error(`The dashboard page could not be sent: ${error.message}`);
        res.status(503).json({ message: "The dashboard is unavailable." });
      },
    );
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
  @Get("settings/rotation-check")
  rotationCheck(@Req() req: StaffRequest) {
    return this.service.rotationCheck(req.staff);
  }
  @Get("game-log")
  gameLog(@Req() req: StaffRequest) {
    return this.service.gameLog(req.staff);
  }
  @Post("actions")
  act(@Req() req: StaffRequest, @Body() body: unknown) {
    return this.service.act(req.staff, body);
  }
  @Get([
    "overview",
    "activity",
    "bans",
    "whitelist",
    "catalog",
    "rotation",
    "audit",
    "audit-notable",
    "server-identity",
  ])
  read(@Req() req: StaffRequest) {
    const resource = req.path.replace(/\/$/, "").split("/").at(-1) ?? "";
    return this.service.read(resource, req.staff.serverId);
  }
  @Get("audit/:id")
  receipt(@Req() req: StaffRequest, @Param("id") id: string) {
    return this.service.receipt(id, req.staff.serverId);
  }
  @Get("moderation/repeat-offenders")
  repeatOffenders(@Req() req: StaffRequest) {
    return this.service.repeatOffenders(req.staff.serverId);
  }
  @Get("moderation/players/:steamId")
  moderation(@Req() req: StaffRequest, @Param("steamId") steamId: string) {
    return this.service.moderation(steamId, req.staff.serverId);
  }
}
