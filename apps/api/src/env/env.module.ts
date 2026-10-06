import { sampleServerDefinitions } from "../development/preview-game";
import { Global, Module } from "@nestjs/common";
import { EnvService } from "./env.service";
import { ConfigModule } from "@nestjs/config";
import { Env } from "./env";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      ignoreEnvFile: process.env.NODE_ENV === "production",
      validate: (env) => {
        const values = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
        if (
          (values.NODE_ENV === "production" || values.NEST_ENV === "production") &&
          values.BACKEND_GAME_MODE === "sample"
        )
          throw new Error("Sample mode is development-only.");
        if (
          values.BACKEND_GAME_MODE === "sample" &&
          (values.API_MUTATIONS_ENABLED === "true" || values.API_WORKERS_ENABLED === "true")
        )
          throw new Error("Sample mode requires passive read-only operation.");
        const parsedEnv = Env.safeParse({
          ...values,
          ...(values.BACKEND_GAME_MODE === "sample"
            ? { WARDOGS_SERVERS: JSON.stringify(sampleServerDefinitions) }
            : {}),
        });
        if (!parsedEnv.success)
          throw new Error(
            `Invalid API configuration fields: ${parsedEnv.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
          );
        return parsedEnv.data;
      },
      isGlobal: true,
    }),
  ],
  providers: [EnvService],
  exports: [EnvService],
})
export class EnvModule {}
