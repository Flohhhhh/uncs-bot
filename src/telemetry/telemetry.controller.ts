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
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AdminGuard } from "../admin/admin.auth";
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

@Controller("api/ingest")
@UseFilters(TelemetryExceptionFilter)
export class TelemetryIngestController {
  constructor(private readonly service: TelemetryService) {}
  @Post("events")
  ingest(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    return this.service.ingest(authorization, body);
  }
}

@Controller("community/api")
@UseFilters(TelemetryExceptionFilter)
export class TelemetryPublicController {
  constructor(private readonly service: TelemetryService) {}
  @Get("leaderboard")
  leaderboard(@Query("period") period: unknown) {
    return this.service.leaderboard(period);
  }
}

@Controller("admin/api/combat")
@UseFilters(TelemetryExceptionFilter)
@UseGuards(AdminGuard)
export class TelemetryAdminController {
  constructor(private readonly service: TelemetryService) {}
  @Get()
  combat(@Query("period") period: unknown) {
    return this.service.combat(period);
  }
  @Get("players/:steamId")
  player(@Param("steamId") steamId: string, @Query("period") period: unknown) {
    return this.service.player(steamId, period);
  }
}
