import { Global, Module, type DynamicModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { z } from "zod";
import { Env } from "../../../src/env/env";
import { sampleServerDefinitions } from "../../../scripts/preview-game";
import { EnvService } from "../../../src/env/env.service";

/** Reuse shared validation without loading the bot's EnvModule or root dotenv file. */
export const backendEnvironment = Env.extend({
  NEST_ENV: z.literal("development").default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4321),
  ADMIN_ENABLED: z
    .literal("true")
    .default("true")
    .transform(() => true),
  BACKEND_GAME_MODE: z.enum(["live", "sample"]).default("live"),
  BACKEND_SAMPLE_SCENARIO: z.enum(["standard", "full-server", "pre-round"]).default("standard"),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
});

export function validateBackendEnvironment(input: Record<string, unknown>) {
  // Blank optional fields in the template behave like omitted variables.
  const values = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== ""));
  const parsed = backendEnvironment.safeParse({
    ...values,
    ...(values.BACKEND_GAME_MODE === "sample" ? { WARDOGS_SERVERS: JSON.stringify(sampleServerDefinitions) } : {}),
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Configure apps/backend/.env: invalid or missing ${fields.join(", ")}.`);
  }
  return parsed.data;
}

@Global()
@Module({})
export class BackendEnvironmentModule {
  static register(envFilePath: string): DynamicModule {
    return {
      module: BackendEnvironmentModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath,
          validatePredefined: false,
          skipProcessEnv: true,
          validate: validateBackendEnvironment,
        }),
      ],
      providers: [EnvService],
      exports: [EnvService],
    };
  }
}
