import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { AdminAuth, AdminGuard } from "./admin.auth";
import { AdminApiController, AdminExceptionFilter, AdminPageController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import { WardogsClient } from "./wardogs.client";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "dist", "src", "admin", "public", "assets"),
      serveRoot: "/admin/assets",
      // Only public build assets are served here. API/auth/unknown paths never fall back to HTML.
      serveStaticOptions: { index: false, redirect: false, fallthrough: false, dotfiles: "deny", cacheControl: false },
    }),
  ],
  providers: [AdminSettings, AdminStore, AdminAuth, AdminGuard, AdminService, WardogsClient, AdminExceptionFilter],
  controllers: [AdminPageController, AdminApiController],
  exports: [AdminSettings, AdminStore, AdminAuth, AdminGuard, AdminService, WardogsClient],
})
export class AdminModule implements NestModule {
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
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Strict-Transport-Security": "max-age=31536000",
        });
        const path = req.originalUrl.split("?")[0];
        const isAuth = /^\/admin\/auth\/(login|callback)\/?$/i.test(path);
        if (isAuth || /^\/admin\/api(?:\/|$)/i.test(path)) {
          const now = Date.now();
          for (const [key, counter] of traffic) {
            if (counter.until <= now) traffic.delete(key);
          }
          // Never trust caller-supplied X-Forwarded-For. When deployed behind
          // a proxy this is an aggregate peer limit; configure client limits
          // at that trusted edge as well.
          const key = `${isAuth ? "auth" : "api"}:${req.socket.remoteAddress ?? "unknown"}`;
          let counter = traffic.get(key);
          if (!counter && traffic.size < 5000) {
            counter = { until: now + 60_000, count: 0 };
            traffic.set(key, counter);
          }
          if (!counter || ++counter.count > (isAuth ? 60 : 600)) {
            res
              .set("Retry-After", "60")
              .status(429)
              .json({ message: "Too many dashboard requests. Try again in a minute." });
            return;
          }
        }
        next();
      })
      .forRoutes({ path: "admin", method: RequestMethod.ALL }, { path: "admin/{*path}", method: RequestMethod.ALL });
  }
}
