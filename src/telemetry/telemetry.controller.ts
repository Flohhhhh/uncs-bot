import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Headers,
  HttpException,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { TelemetryService } from "./telemetry.service";

@Catch()
@Injectable()
export class TelemetryExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(error instanceof HttpException ? error.getStatus() : 503).json({
      message:
        error instanceof HttpException
          ? error.message
          : "Game event tracking is unavailable. Check its connection and database setup.",
    });
  }
}

@Controller(["api/ingest", "api/ingest/servers/:serverId"])
@UseFilters(TelemetryExceptionFilter)
export class TelemetryIngestController {
  constructor(private readonly service: TelemetryService) {}
  @Post("events")
  ingest(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
    @Param("serverId") serverId?: string,
  ) {
    return this.service.ingest(authorization, body, serverId);
  }
}

@Controller("community/api")
@UseFilters(TelemetryExceptionFilter)
export class TelemetryPublicController {
  constructor(private readonly service: TelemetryService) {}
  @Get("servers")
  servers() {
    return { servers: this.service.serversList() };
  }
  @Get(["leaderboard", "servers/:serverId/leaderboard"])
  leaderboard(@Query("period") period: unknown, @Param("serverId") serverId?: string) {
    return this.service.leaderboard(period, serverId);
  }
  @Get(["stats", "servers/:serverId/stats"])
  stats(@Query("period") period: unknown, @Param("serverId") serverId?: string) {
    return this.service.stats(period, serverId);
  }
}

@Controller(["admin/api/combat", "admin/api/servers/:serverId/combat"])
@UseFilters(TelemetryExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class TelemetryAdminController {
  constructor(private readonly service: TelemetryService) {}
  @Get()
  combat(@Query("period") period: unknown, @Req() req: StaffRequest) {
    return this.service.combat(period, req.staff.serverId);
  }
  @Get("players/:steamId")
  player(@Param("steamId") steamId: string, @Query("period") period: unknown, @Req() req: StaffRequest) {
    return this.service.player(steamId, period, req.staff.serverId);
  }
}
