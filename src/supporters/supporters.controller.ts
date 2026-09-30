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
  Req,
  UseFilters,
  UseGuards,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AdminGuard, type StaffRequest } from "../admin/admin.auth";
import { SupportersService } from "./supporters.service";

@Catch()
@Injectable()
export class SupportersExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(error instanceof HttpException ? error.getStatus() : 503)
      .json({
        message:
          error instanceof HttpException
            ? error.message
            : "Supporter records are temporarily unavailable. No access change was sent.",
      });
  }
}
@Controller("supporters/webhooks")
@UseFilters(SupportersExceptionFilter)
export class PatreonWebhookController {
  constructor(private readonly service: SupportersService) {}
  @Post("patreon")
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-patreon-signature") signature: unknown,
    @Headers("x-patreon-event") trigger: unknown,
  ) {
    return this.service.webhook(req.rawBody, signature, trigger);
  }
}
@Controller("admin/api/supporters")
@UseFilters(SupportersExceptionFilter)
@UseGuards(AdminGuard)
export class SupportersAdminController {
  constructor(private readonly service: SupportersService) {}
  @Get()
  list(@Req() req: StaffRequest) {
    return this.service.list(req.staff);
  }
  @Post(":id/link")
  link(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.mutate(req.staff, id, "link", body);
  }
  @Post(":id/payment")
  payment(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.mutate(req.staff, id, "payment", body);
  }
  @Post(":id/founder")
  founder(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.mutate(req.staff, id, "founder", body);
  }
  @Post(":id/review")
  review(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.mutate(req.staff, id, "review", body);
  }
}
