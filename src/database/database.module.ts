import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { EnvModule } from "src/env/env.module";
import { EnvService } from "src/env/env.service";
import * as schema from "./schema";

export const DATABASE = Symbol("DATABASE");
const DATABASE_POOL = Symbol("DATABASE_POOL");

export type Database = NodePgDatabase<typeof schema>;

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown, OnModuleInit {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    try {
      await this.pool.query("select 1");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Database connection failed: ${message}`, { cause: error });
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  imports: [EnvModule],
  providers: [
    {
      provide: DATABASE_POOL,
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
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
