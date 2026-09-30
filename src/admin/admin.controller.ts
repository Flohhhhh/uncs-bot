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
  NotFoundException,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { join } from "node:path";
import { AdminAuth, AdminGuard, type StaffRequest } from "./admin.auth";
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
  @Get()
  page(@Res() res: Response) {
    res.sendFile(join(__dirname, "public", "index.html"));
  }
  @Get("app.js")
  script(@Res() res: Response) {
    res.sendFile(join(__dirname, "public", "app.js"));
  }
  @Get("style.css")
  style(@Res() res: Response) {
    res.sendFile(join(__dirname, "public", "style.css"));
  }
  @Get("assets/:file")
  asset(@Param("file") file: string, @Res() res: Response) {
    const assets: Record<string, string> = {
      "uncs-mascot.png": "image/png",
      "barlow-condensed-bold.ttf": "font/ttf",
      "barlow-condensed-extrabold.ttf": "font/ttf",
      "dm-sans.ttf": "font/ttf",
    };
    if (!Object.hasOwn(assets, file)) throw new NotFoundException("Asset not found.");
    res.type(assets[file]).sendFile(join(__dirname, "public", "assets", file));
  }
  @Get("auth/login")
  login(@Res() res: Response) {
    this.auth.login(res);
  }
  @Get("auth/callback")
  callback(@Req() req: Request, @Res() res: Response) {
    return this.auth.callback(req, res);
  }
}

@Controller("admin/api")
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard)
export class AdminApiController {
  constructor(
    private readonly service: AdminService,
    private readonly auth: AdminAuth,
  ) {}
  @Get("me")
  me(@Req() req: StaffRequest) {
    return req.staff;
  }
  @Post("logout")
  logout(@Req() req: StaffRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }
  @Post("actions")
  act(@Req() req: StaffRequest, @Body() body: unknown) {
    return this.service.act(req.staff, body);
  }
  @Get(["overview", "bans", "whitelist", "catalog", "rotation", "audit"])
  read(@Req() req: Request) {
    const resource = req.path.replace(/\/$/, "").split("/").at(-1) ?? "";
    return this.service.read(resource);
  }
}
