import { type MiddlewareConsumer, Module, type NestModule, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { AdminModule } from "../admin/admin.module";
import {
  TelemetryAdminController,
  TelemetryExceptionFilter,
  TelemetryIngestController,
  TelemetryPublicController,
} from "./telemetry.controller";
import { TelemetryDeliveries } from "./telemetry.deliveries";
import { TelemetryService } from "./telemetry.service";
import { TelemetryStore } from "./telemetry.store";

@Module({
  imports: [AdminModule],
  providers: [TelemetryService, TelemetryStore, TelemetryDeliveries, TelemetryExceptionFilter],
  controllers: [TelemetryIngestController, TelemetryPublicController, TelemetryAdminController],
  exports: [TelemetryService, TelemetryStore],
})
export class TelemModule implements NestModule, OnModuleInit {
  constructor(
    private readonly deliveries: TelemetryDeliveries,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  onModuleInit() {
    // Body parsing (malformed JSON, oversized bodies) fails before any route or Nest middleware
    // runs. This error hook sits ahead of Nest's own handler, which still writes the response.
    const adapter = this.adapterHost.httpAdapter;
    if (adapter?.getType() !== "express") return;
    adapter.use((error: unknown, req: Request, _res: Response, next: NextFunction) => {
      const failure = (error ?? {}) as { status?: unknown; statusCode?: unknown; type?: unknown };
      const status =
        typeof failure.status === "number"
          ? failure.status
          : typeof failure.statusCode === "number"
            ? failure.statusCode
            : error instanceof SyntaxError || error instanceof URIError
              ? 400
              : 500;
      const reason =
        failure.type === "entity.too.large"
          ? "too large"
          : failure.type === "entity.parse.failed" || error instanceof SyntaxError
            ? "invalid JSON"
            : "unreadable request";
      this.deliveries.rejectedRequest(req.originalUrl, status, reason);
      next(error);
    });
  }

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
          if (peers === feeds) this.deliveries.rejectedRequest(req.originalUrl, 429, "rate limited");
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
