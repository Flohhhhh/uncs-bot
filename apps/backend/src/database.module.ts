import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { EnvService } from "../../../src/env/env.service";
import { DATABASE } from "../../../src/database/database.types";
import * as schema from "../../../src/database/schema";

const BACKEND_POOL = Symbol("BACKEND_POOL");

@Injectable()
class BackendDatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(BACKEND_POOL) private readonly pool: Pool) {}
  async onModuleInit() {
    // Connectivity only; schema/migrations remain human-owned.
    await this.pool.query("select 1");
  }
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

/** Own the connection wiring so the shared DatabaseModule cannot load root environment settings. */
@Global()
@Module({
  providers: [
    {
      provide: BACKEND_POOL,
      inject: [EnvService],
      useFactory: (env: EnvService) =>
        new Pool({
          connectionString: env.get("DATABASE_URL"),
          max: 5,
          connectionTimeoutMillis: 10_000,
        }),
    },
    {
      provide: DATABASE,
      inject: [BACKEND_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    BackendDatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class BackendDatabaseModule {}
