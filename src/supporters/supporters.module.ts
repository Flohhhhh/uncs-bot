import { type MiddlewareConsumer, Module, type NestModule, type RawBodyRequest } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AdminModule } from "../admin/admin.module";
import { DiscordRolesModule } from "../discord-roles/discord-roles.module";
import {
  PatreonWebhookController,
  SupportersAdminController,
  SupportersExceptionFilter,
} from "./supporters.controller";
import { PatreonClient } from "./patreon.client";
import { PatreonSyncService } from "./patreon-sync.service";
import { SupportersService } from "./supporters.service";
import { SupportersStore } from "./supporters.store";

@Module({
  imports: [AdminModule, DiscordRolesModule],
  providers: [SupportersService, SupportersStore, SupportersExceptionFilter, PatreonClient, PatreonSyncService],
  controllers: [PatreonWebhookController, SupportersAdminController],
  exports: [SupportersService, SupportersStore, PatreonSyncService],
})
export class SupportersModule implements NestModule {
  constructor(private readonly service: SupportersService) {}

  configure(consumer: MiddlewareConsumer) {
    // Webhooks carrying a valid Patreon signature count in their own bucket, so unsigned traffic
    // behind one proxy can neither use up Patreon's allowance nor fill the address map and lock
    // the webhooks out.
    const traffic = new Map<string, { until: number; count: number }>();
    const signed = new Map<string, { until: number; count: number }>();
    consumer
      .apply((req: RawBodyRequest<Request>, res: Response, next: NextFunction) => {
        res.set({
          "Cache-Control": "no-store",
          "CDN-Cache-Control": "no-store",
          "Vercel-CDN-Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Strict-Transport-Security": "max-age=31536000",
        });
        const webhook = /^\/supporters\/webhooks(?:\/|$)/i.test(req.originalUrl);
        const patreon = webhook && this.service.signedWebhook(req.rawBody, req.headers["x-patreon-signature"]);
        const counters = patreon ? signed : traffic;
        const now = Date.now();
        for (const [key, value] of counters) if (value.until <= now) counters.delete(key);
        const key = patreon ? "patreon" : `${webhook ? "webhook" : "staff"}:${req.socket.remoteAddress ?? "unknown"}`;
        let counter = counters.get(key);
        // The signed bucket holds one entry, so it needs no size cap.
        if (!counter && (patreon || counters.size < 5000)) {
          counter = { until: now + 60_000, count: 0 };
          counters.set(key, counter);
        }
        if (!counter || ++counter.count > 180) {
          res.set("Retry-After", "60").status(429).json({ message: "Too many supporter requests. Try again shortly." });
          return;
        }
        next();
      })
      .forRoutes(PatreonWebhookController, SupportersAdminController);
  }
}
