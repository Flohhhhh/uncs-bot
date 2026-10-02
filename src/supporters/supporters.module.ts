import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AdminModule } from "../admin/admin.module";
import { DiscordRolesModule } from "../discord-roles/discord-roles.module";
import {
  PatreonWebhookController,
  SupportersAdminController,
  SupportersExceptionFilter,
} from "./supporters.controller";
import { SupportersService } from "./supporters.service";
import { SupportersStore } from "./supporters.store";

@Module({
  imports: [AdminModule, DiscordRolesModule],
  providers: [SupportersService, SupportersStore, SupportersExceptionFilter],
  controllers: [PatreonWebhookController, SupportersAdminController],
  exports: [SupportersService, SupportersStore],
})
export class SupportersModule implements NestModule {
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
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Strict-Transport-Security": "max-age=31536000",
        });
        const now = Date.now();
        for (const [key, value] of traffic) if (value.until <= now) traffic.delete(key);
        const webhook = /^\/supporters\/webhooks(?:\/|$)/i.test(req.originalUrl);
        const key = `${webhook ? "webhook" : "staff"}:${req.socket.remoteAddress ?? "unknown"}`;
        let counter = traffic.get(key);
        if (!counter && traffic.size < 5000) {
          counter = { until: now + 60_000, count: 0 };
          traffic.set(key, counter);
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
