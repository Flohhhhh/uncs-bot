import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Injectable,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AdminGuard, type StaffRequest } from "../admin/admin.auth";
import { DiscordRolesService } from "./discord-roles.service";

@Catch()
@Injectable()
export class DiscordRolesExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    // Discord and database errors can carry tokens or member data; only a fixed message leaves the server.
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(error instanceof HttpException ? error.getStatus() : 503)
      .json({
        message:
          error instanceof HttpException
            ? error.message
            : "Discord roles are temporarily unavailable. No role change was sent.",
      });
  }
}

/** Admin-only. The AdminModule middleware adds no-store headers and the per-peer request limit. */
@Controller("admin/api/discord-roles")
@UseFilters(DiscordRolesExceptionFilter)
@UseGuards(AdminGuard)
export class DiscordRolesController {
  constructor(private readonly service: DiscordRolesService) {}
  @Get()
  status(@Req() req: StaffRequest) {
    return this.service.status(req.staff);
  }
  @Post("reconcile")
  reconcile(@Req() req: StaffRequest, @Body() body: unknown) {
    return this.service.reconcile(req.staff, body);
  }
}
