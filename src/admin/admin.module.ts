import {
  HttpException,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { AdminAuth, AdminGuard, AdminServerGuard } from "./admin.auth";
import { AdminApiController, AdminGameController, AdminExceptionFilter, AdminPageController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import { GameServers } from "./game-servers";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "dist", "src", "admin", "public", "assets"),
      serveRoot: "/admin/assets",
      // Only public build assets are served here. API/auth/unknown paths never fall back to HTML.
      serveStaticOptions: { index: false, redirect: false, fallthrough: false, dotfiles: "deny", cacheControl: false },
    }),
  ],
  providers: [
    AdminSettings,
    AdminStore,
    AdminAuth,
    AdminGuard,
    AdminServerGuard,
    AdminService,
    GameServers,
    AdminExceptionFilter,
  ],
  controllers: [AdminPageController, AdminApiController, AdminGameController],
  exports: [AdminSettings, AdminStore, AdminAuth, AdminGuard, AdminServerGuard, AdminService, GameServers],
})
export class AdminModule implements NestModule, OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: AdminAuth,
  ) {}

  onModuleInit() {
    // A missing or refused asset fails inside express.static, and that error's message holds the server's
    // filesystem path. ServeStaticModule's own error hook (registered first, as this module imports it) and
    // Nest's handler (registered after every module's init) would both pass it to the browser, so this hook
    // answers asset errors with a fixed body. Server-side failures still go on to the exception filter.
    const adapter = this.adapterHost.httpAdapter;
    if (adapter?.getType() !== "express") return;
    adapter.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
      const failure = (error ?? {}) as { status?: unknown; statusCode?: unknown };
      const status =
        error instanceof HttpException
          ? error.getStatus()
          : typeof failure.status === "number"
            ? failure.status
            : typeof failure.statusCode === "number"
              ? failure.statusCode
              : 500;
      if (!/^\/admin\/assets(?:\/|$)/i.test(req.originalUrl) || res.headersSent || status >= 500) {
        next(error);
        return;
      }
      if (status === 403) res.status(403).json({ message: "Forbidden." });
      else res.status(404).json({ message: "Not found." });
    });
  }

  configure(consumer: MiddlewareConsumer) {
    const traffic = new Map<string, { until: number; count: number }>();
    // Only sessions AdminAuth verified get a bucket here, so anonymous callers can neither add entries nor fill it.
    const staffTraffic = new Map<string, { until: number; count: number }>();
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
          for (const counters of [traffic, staffTraffic]) {
            for (const [key, counter] of counters) if (counter.until <= now) counters.delete(key);
          }
          // Never trust caller-supplied X-Forwarded-For. When deployed behind a proxy the peer address is
          // the proxy's, so the address bucket is shared by every caller; configure client limits at that
          // trusted edge as well. A session AdminAuth verified at sign-in or in the last few minutes is counted
          // in its own bucket instead, keyed by its token hash, so anonymous traffic cannot use up staff capacity.
          // Unknown, forged or signed-out cookies, revoked ones once a request has found them out, and every
          // sign-in request count by address.
          const session = isAuth ? undefined : this.auth.verifiedSession(req);
          const counters = session ? staffTraffic : traffic;
          const key = session ?? `${isAuth ? "auth" : "api"}:${req.socket.remoteAddress ?? "unknown"}`;
          let counter = counters.get(key);
          if (!counter && counters.size < 5000) {
            counter = { until: now + 60_000, count: 0 };
            counters.set(key, counter);
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
