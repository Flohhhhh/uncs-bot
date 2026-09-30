import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AdminModule } from "../admin/admin.module";
import {
  TelemetryAdminController,
  TelemetryExceptionFilter,
  TelemetryIngestController,
  TelemetryPublicController,
} from "./telemetry.controller";
import { TelemetryService } from "./telemetry.service";
import { TelemetryStore } from "./telemetry.store";

@Module({
  imports: [AdminModule],
  providers: [TelemetryService, TelemetryStore, TelemetryExceptionFilter],
  controllers: [TelemetryIngestController, TelemetryPublicController, TelemetryAdminController],
  exports: [TelemetryService, TelemetryStore],
})
export class TelemModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Feed delivery must not compete with public/staff reads behind one proxy.
    const feeds = new Map<string, { until: number; count: number }>();
    const reads = new Map<string, { until: number; count: number }>();
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
        const peers = /^\/api\/ingest(?:\/|$)/i.test(req.originalUrl) ? feeds : reads;
        const now = Date.now();
        for (const [key, value] of peers) if (value.until <= now) peers.delete(key);
        const key = req.socket.remoteAddress ?? "unknown";
        let peer = peers.get(key);
        if (!peer && peers.size < 5000) {
          peer = { until: now + 60_000, count: 0 };
          peers.set(key, peer);
        }
        if (!peer || ++peer.count > 300) {
          res
            .set("Retry-After", "60")
            .status(429)
            .json({ message: "Too many game tracking requests. Try again shortly." });
          return;
        }
        next();
      })
      .forRoutes(TelemetryIngestController, TelemetryPublicController, TelemetryAdminController);
  }
}
export { TelemModule as TelemetryModule };
