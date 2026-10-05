import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AdminModule } from "../admin/admin.module";
import { DiscordRolesModule } from "../discord-roles/discord-roles.module";
import { SupporterMatchModule } from "../supporters/supporter-match.module";
import { SupportersModule } from "../supporters/supporters.module";
import { PAGE_STYLE_SOURCE } from "./patron-link.copy";
import { PatronLinkController, PatronLinkExceptionFilter } from "./patron-link.controller";
import { PatronLinkOAuth } from "./patron-link.oauth";
import { PatronLinkService } from "./patron-link.service";
import { PatronLinkState } from "./patron-link.state";
import { PatronLinkStore } from "./patron-link.store";

/** Requests a minute per route per peer address before the sign-in pages say "Too many tries". */
export const PATRON_LINK_REQUESTS_PER_MINUTE = 60;
/** The result page allows its own style and nothing else: no script, form, frame or other origin. */
export const PATRON_LINK_CSP = `default-src 'none'; style-src ${PAGE_STYLE_SOURCE}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/**
 * "Link Patreon": the sign-in pages, the service the /patreon command and the panel button share, and its stores. The
 * pages always answer, saying linking is off while PATREON_LINK_ENABLED is off. The command is registered separately
 * (PatronLinkCommandsModule), only while it is on.
 */
@Module({
  imports: [AdminModule, SupportersModule, DiscordRolesModule, SupporterMatchModule],
  providers: [PatronLinkService, PatronLinkState, PatronLinkOAuth, PatronLinkStore, PatronLinkExceptionFilter],
  controllers: [PatronLinkController],
  exports: [PatronLinkService],
})
export class PatronLinkModule implements NestModule {
  constructor(private readonly service: PatronLinkService) {}

  configure(consumer: MiddlewareConsumer) {
    const traffic = new Map<string, { until: number; count: number }>();
    consumer
      .apply((req: Request, res: Response, next: NextFunction) => {
        res.set({
          "Cache-Control": "no-store",
          "CDN-Cache-Control": "no-store",
          "Vercel-CDN-Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": PATRON_LINK_CSP,
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Strict-Transport-Security": "max-age=31536000",
        });
        const now = Date.now();
        for (const [key, value] of traffic) if (value.until <= now) traffic.delete(key);
        // Express matches routes case-insensitively, so the route is read the same way.
        const path = req.originalUrl.split("?")[0].toLowerCase();
        const route = path.includes("/discord/")
          ? "discord"
          : path.includes("/patreon/")
            ? "patreon"
            : path.includes("/start")
              ? "start"
              : "done";
        // Peer-level aggregate guard. Spoofable forwarding headers are never read.
        const key = `${route}:${req.socket.remoteAddress ?? "unknown"}`;
        let counter = traffic.get(key);
        if (!counter && traffic.size < 5000) {
          counter = { until: now + 60_000, count: 0 };
          traffic.set(key, counter);
        }
        if (!counter || ++counter.count > PATRON_LINK_REQUESTS_PER_MINUTE) {
          res.set("Retry-After", "60").status(429).type("html").send(this.service.page("busy"));
          return;
        }
        next();
      })
      .forRoutes(PatronLinkController);
  }
}
