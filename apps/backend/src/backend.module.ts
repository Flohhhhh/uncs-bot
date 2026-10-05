import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule, RequestMethod } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AdminAuth } from "../../../src/admin/admin.auth";
import { GameServers } from "../../../src/admin/game-servers";
import { BackendAuth, BackendGameServers } from "./game-data";
import { AdminModule } from "../../../src/admin/admin.module";
import { BackendEnvironmentModule } from "./environment";
import { BackendDatabaseModule } from "./database.module";

@Module({})
export class BackendModule implements NestModule {
  static register(envFilePath: string): DynamicModule {
    return {
      module: BackendModule,
      imports: [
        BackendEnvironmentModule.register(envFilePath),
        BackendDatabaseModule,
        {
          module: AdminModule,
          providers: [
            { provide: GameServers, useClass: BackendGameServers },
            { provide: AdminAuth, useClass: BackendAuth },
          ],
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request, res: Response, next: NextFunction) => {
        const path = req.originalUrl.split("?")[0];
        if (
          ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
          (req.method === "POST" && /^\/admin\/api\/logout\/?$/i.test(path))
        ) {
          next();
          return;
        }
        res.status(403).json({ message: "This development backend allows reads and sign-out only." });
      })
      .forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
