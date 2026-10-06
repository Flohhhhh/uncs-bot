import { Body, Controller, Post, UseGuards, UseFilters } from "@nestjs/common";
import { weeklyRenderRequest } from "@uncs/contracts";
import { InternalGuard, parse } from "./transport";
import { InternalExceptionFilter } from "./errors";
import { renderWeeklyBoard } from "../weekly-leaderboard/weekly-render";
/** Pure message formatting remains available during passive verification, without a Discord client. */
@Controller("internal/v1/weekly")
@UseGuards(InternalGuard)
@UseFilters(InternalExceptionFilter)
export class RenderController {
  @Post("render") render(@Body() input: unknown) {
    const body = parse(weeklyRenderRequest, input);
    const window = {
      ...body.window,
      start: new Date(body.window.start),
      end: new Date(body.window.end),
      since: new Date(body.window.since),
      until: new Date(body.window.until),
    };
    return renderWeeklyBoard({
      ...body,
      window,
      trackingStartedAt: body.trackingStartedAt ? new Date(body.trackingStartedAt) : null,
    });
  }
}
