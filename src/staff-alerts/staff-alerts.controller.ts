import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminGuard, AdminServerGuard, type StaffRequest } from "../admin/admin.auth";
import { AdminExceptionFilter } from "../admin/admin.controller";
import { canReviewAlerts, REVIEW_DECISIONS, SNOOZE_CATEGORIES } from "../common/staff-alerts";
import { StaffAlertsMonitor } from "./staff-alerts.monitor";
import { StaffAlerts } from "./staff-alerts.service";

const reviewSchema = z.object({ decision: z.enum(REVIEW_DECISIONS) }).strict();
const snoozeSchema = z
  .object({
    category: z.enum(SNOOZE_CATEGORIES),
    minutes: z
      .number()
      .int()
      .refine(
        (value) => value === 0 || (value >= 15 && value <= 1440),
        "Snooze for 15 to 1440 minutes, or 0 to clear.",
      ),
  })
  .strict();
const ALERT_ID = /^[a-f0-9]{12}$/;

/**
 * Staff alerts API. Any staff role with access to the server reads it; moderators and
 * administrators review and snooze. Reviews and snoozes live in memory and write no
 * admin_actions rows; the game is never changed from here.
 */
@Controller(["admin/api/staff-alerts", "admin/api/servers/:serverId/staff-alerts"])
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard, AdminServerGuard)
export class StaffAlertsController {
  constructor(
    private readonly monitor: StaffAlertsMonitor,
    private readonly alerts: StaffAlerts,
  ) {}

  @Get() status(@Req() request: StaffRequest) {
    return this.monitor.status(request.staff.serverId);
  }

  @Post("snooze") snooze(@Req() request: StaffRequest, @Body() body: unknown) {
    if (!canReviewAlerts(request.staff.role))
      throw new ForbiddenException("Only moderators and administrators can snooze staff alerts.");
    const parsed = snoozeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Choose a category and 15 to 1440 minutes, or 0 to clear.");
    return {
      snoozes: this.alerts.snooze(
        request.staff.serverId!,
        parsed.data.category,
        parsed.data.minutes,
        request.staff.name,
      ),
    };
  }

  @Post(":alertId/review") review(
    @Req() request: StaffRequest,
    @Param("alertId") alertId: string,
    @Body() body: unknown,
  ) {
    if (!canReviewAlerts(request.staff.role))
      throw new ForbiddenException("Only moderators and administrators can review staff alerts.");
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Choose ack, legit or never.");
    if (!ALERT_ID.test(alertId))
      throw new NotFoundException(
        "This alert is no longer available. Alerts are kept in memory until Gramps restarts.",
      );
    return this.alerts.review(request.staff.serverId!, alertId, parsed.data.decision, request.staff);
  }
}
