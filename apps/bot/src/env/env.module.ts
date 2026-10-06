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
        const parsedEnv = Env.safeParse(values);
        if (parsedEnv.success === false) {
          throw new Error(
            `Invalid bot configuration fields: ${parsedEnv.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
          );
        }
        return parsedEnv.data;
      },
      isGlobal: true,
    }),
  ],
  providers: [EnvService],
  exports: [EnvService],
})
export class EnvModule {}
