import {
  ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  HttpException,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { ApplicantAuth, type ApplicantRequest } from "./applicant.auth";
import { ApplicationsService } from "./applications.service";
import { gameServerId } from "../common/game-server";

@Catch()
@Injectable()
export class ApplicationsExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = error instanceof HttpException ? error.getStatus() : 503;
    if (request.method === "GET" && /^\/apply\/auth\/(login|callback)\/?$/.test(request.path)) {
      // Return to the application with a fixed public code, never an OAuth code,
      // state value, upstream error body or caller-supplied redirect.
      const code = status === 401 ? "sign_in" : status === 403 ? "discord_access" : "unavailable";
      const query = new URLSearchParams({ auth: code });
      // Disabled login can fail before OAuth begins. Retain its bounded server
      // selection locally; a callback may use only the verified signed target.
      const target = gameServerId.safeParse(
        response.locals.applicantServer ??
          (/^\/apply\/auth\/login\/?$/.test(request.path) ? request.query.server : undefined),
      );
      if (target.success) query.set("server", target.data);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.redirect(303, `/whitelist?${query}`);
      return;
    }
    response.status(status).json({
      message:
        error instanceof HttpException
          ? error.message
          : "Applications are temporarily unavailable. Please try again on this website shortly.",
    });
  }
}

@Injectable()
export class ApplicationsEnabledGuard implements CanActivate {
  constructor(private readonly service: ApplicationsService) {}
  canActivate() {
    this.service.enabled();
    return true;
  }
}

@Injectable()
export class ApplicantGuard implements CanActivate {
  constructor(private readonly auth: ApplicantAuth) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ApplicantRequest>();
    request.applicant = await this.auth.authenticate(request);
    return true;
  }
}

@Controller("apply/auth")
@UseFilters(ApplicationsExceptionFilter)
@UseGuards(ApplicationsEnabledGuard)
export class ApplicantAuthController {
  constructor(private readonly auth: ApplicantAuth) {}
  @Get("login")
  login(@Req() req: Request, @Res() res: Response) {
    return this.auth.login(req, res);
  }
  @Get("callback")
  callback(@Req() req: Request, @Res() res: Response) {
    return this.auth.callback(req, res);
  }
  @Post("logout")
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // ApplicantAuth validates the session, origin and CSRF itself. A former
    // member must still be able to clear their cookie and sign out.
    return this.auth.logout(req, res);
  }
}

@Controller("apply/api")
@UseFilters(ApplicationsExceptionFilter)
@UseGuards(ApplicationsEnabledGuard, ApplicantGuard)
export class ApplicantApiController {
  constructor(private readonly service: ApplicationsService) {}
  @Get("me")
  me(@Req() req: ApplicantRequest, @Query("server") serverId?: string) {
    return this.service.me(req.applicant, serverId);
  }
  @Post("request")
  submit(@Req() req: ApplicantRequest, @Body() body: unknown) {
    return this.service.submit(req.applicant, body);
  }
}

@Controller(["admin/api/applications", "admin/api/servers/:serverId/applications"])
@UseFilters(ApplicationsExceptionFilter)
@UseGuards(ApplicationsEnabledGuard, AdminGuard, AdminServerGuard)
export class StaffApplicationsController {
  constructor(private readonly service: ApplicationsService) {}
  @Get()
  list(@Req() req: StaffRequest) {
    return this.service.list(req.staff);
  }
  @Post(":id/approve")
  approve(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.review(req.staff, id, "approve", body);
  }
  @Post(":id/decline")
  decline(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.review(req.staff, id, "decline", body);
  }
  @Post(":id/recheck")
  recheck(@Req() req: StaffRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.service.review(req.staff, id, "recheck", body);
  }
}
