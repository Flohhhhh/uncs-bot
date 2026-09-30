import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AdminModule } from "../admin/admin.module";
import { ApplicantAuth } from "./applicant.auth";
import {
  ApplicantApiController,
  ApplicantAuthController,
  ApplicantGuard,
  ApplicationsEnabledGuard,
  ApplicationsExceptionFilter,
  StaffApplicationsController,
} from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { ApplicationsStore } from "./applications.store";

@Module({
  imports: [AdminModule],
  providers: [
    ApplicantAuth,
    ApplicantGuard,
    ApplicationsEnabledGuard,
    ApplicationsExceptionFilter,
    ApplicationsService,
    ApplicationsStore,
  ],
  controllers: [ApplicantAuthController, ApplicantApiController, StaffApplicationsController],
})
export class ApplicationsModule implements NestModule {
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
          "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Strict-Transport-Security": "max-age=31536000",
        });
        const now = Date.now();
        for (const [key, value] of traffic) if (value.until <= now) traffic.delete(key);
        const auth = req.originalUrl.split("?")[0].startsWith("/apply/auth/");
        const key = `${auth ? "auth" : "api"}:${req.socket.remoteAddress ?? "unknown"}`;
        let counter = traffic.get(key);
        if (!counter && traffic.size < 5000) {
          counter = { until: now + 60_000, count: 0 };
          traffic.set(key, counter);
        }
        // Peer-level aggregate guard. Do not accept spoofable forwarding headers;
        // production also needs client limits at the trusted reverse proxy.
        if (!counter || ++counter.count > (auth ? 30 : 180)) {
          res
            .set("Retry-After", "60")
            .status(429)
            .json({ message: "Too many application requests. Try again in a minute." });
          return;
        }
        next();
      })
      .forRoutes(ApplicantAuthController, ApplicantApiController, StaffApplicationsController);
  }
}
