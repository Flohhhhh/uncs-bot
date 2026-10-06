import {
  Controller,
  Get,
  Module,
  type NestModule,
  type MiddlewareConsumer,
  RequestMethod,
  Inject,
} from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { DATABASE, type Database } from "../database/database.types";
import { sql } from "drizzle-orm";

@Controller("health")
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  @Get("live") live() {
    return { status: "ok" };
  }
  @Get("ready") async ready() {
    await this.db.execute(sql`select 1`);
    return { status: process.env.API_WORKERS_ENABLED === "true" ? "ready" : "passive" };
  }
}
export class RuntimeControls implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request, res: Response, next: NextFunction) => {
        if (
          process.env.API_MUTATIONS_ENABLED !== "true" &&
          !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
          !/^\/admin\/api\/logout\/?(?:\?|$)/.test(req.originalUrl) &&
          !/^\/internal\/v1\/(roles\/member-joined|seeding\/authorize)\/?(?:\?|$)/.test(req.originalUrl)
        ) {
          res.status(403).json({ message: "Operational mutations are disabled for this API service." });
          return;
        }
        next();
      })
      .forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
@Module({ controllers: [HealthController] })
export class RuntimeModule extends RuntimeControls {}
