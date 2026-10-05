import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Injectable,
  Logger,
  Query,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";
import { PATRON_LINK_PATHS } from "./patron-link.oauth";
import { PATRON_LINK_FAILED, PatronLinkService, type PatronLinkStep } from "./patron-link.service";
import { PATRON_LINK_STAGE_MS } from "./patron-link.state";

/**
 * The sign-in's own cookie: host-only, HTTPS-only (browsers treat localhost as secure too), sent on the providers'
 * top-level redirects back here and on nothing cross-site else. It holds only the random flow ID.
 */
export const PATRON_LINK_COOKIE = "__Host-uncs_patron_link";
const cookieOptions: CookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };
/** Each leg must come back within its stage window (10 minutes), so the cookie lives that long and is set again. */
const COOKIE_MAX_AGE_MS = PATRON_LINK_STAGE_MS;

/** The flow ID in the sign-in cookie, or null. */
export function flowCookie(req: Request) {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${PATRON_LINK_COOKIE}=`))
      ?.slice(PATRON_LINK_COOKIE.length + 1) ?? null
  );
}
const done = (outcome: string) => `${PATRON_LINK_PATHS.done}?${new URLSearchParams({ r: outcome })}`;

/**
 * Any failure ends on the "didn't answer" page with fixed text. Nothing from the request, the error or a provider is
 * echoed or logged.
 */
@Catch()
@Injectable()
export class PatronLinkExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("PatronLink");
  constructor(private readonly service: PatronLinkService) {}

  catch(_error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    this.logger.warn(PATRON_LINK_FAILED);
    if (response.headersSent) return;
    if (/^\/supporters\/link\/done\/?$/i.test(request.path))
      response.status(200).type("html").send(this.service.page("unavailable"));
    else response.redirect(303, done("unavailable"));
  }
}

/** "Link Patreon" on the dashboard's origin. Every route is a plain GET a browser follows; none needs a session. */
@Controller("supporters/link")
@UseFilters(PatronLinkExceptionFilter)
export class PatronLinkController {
  constructor(private readonly service: PatronLinkService) {}

  @Get("start")
  start(@Query("t") ticket: unknown, @Res() res: Response) {
    this.follow(res, this.service.start(ticket));
  }

  @Get("discord/callback")
  async discord(@Req() req: Request, @Res() res: Response) {
    this.follow(res, await this.service.discordCallback(flowCookie(req), req.query));
  }

  @Get("patreon/callback")
  async patreon(@Req() req: Request, @Res() res: Response) {
    this.follow(res, await this.service.patreonCallback(flowCookie(req), req.query));
  }

  /** Fixed text for one outcome. The sign-in is over, so its cookie goes. */
  @Get("done")
  done(@Query("r") outcome: unknown, @Res() res: Response) {
    res.clearCookie(PATRON_LINK_COOKIE, cookieOptions);
    res.status(200).type("html").send(this.service.page(outcome));
  }

  private follow(res: Response, step: PatronLinkStep) {
    if ("outcome" in step) {
      res.redirect(303, done(step.outcome));
      return;
    }
    if (step.flowId) res.cookie(PATRON_LINK_COOKIE, step.flowId, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_MS });
    res.redirect(303, step.location);
  }
}
