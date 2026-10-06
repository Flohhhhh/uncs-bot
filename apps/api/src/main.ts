import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { EnvService } from "./env/env.service";

async function bootstrap() {
  for (const key of ["API_WORKERS_ENABLED", "API_MUTATIONS_ENABLED"])
    if (process.env[key] && !["true", "false"].includes(process.env[key]!)) throw new Error("Invalid runtime control.");
  if (process.env.NODE_ENV === "production" && process.env.BACKEND_GAME_MODE === "sample")
    throw new Error("Sample mode is development-only.");
  if (process.env.API_WORKERS_ENABLED === "true" && process.env.API_MUTATIONS_ENABLED !== "true")
    throw new Error("Active workers require operational mutations to be enabled.");
  if (process.env.API_WORKERS_ENABLED === "true" || process.env.API_MUTATIONS_ENABLED === "true") {
    const credentials = [process.env.BOT_TO_API_TOKEN, process.env.API_TO_BOT_TOKEN];
    if (credentials.some((value) => !value || !/^[!-~]{32,512}$/.test(value)) || credentials[0] === credentials[1])
      throw new Error("Configure separate internal service credentials before enabling active operation.");
    if (!process.env.BOT_ORIGIN)
      throw new Error("Configure the remote service origin before enabling active operation.");
  }
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  await app.listen(app.get(EnvService).get("PORT"), "0.0.0.0");
}
void bootstrap().catch(() => {
  console.error("API startup failed. Check service configuration and database connectivity.");
  process.exitCode = 1;
});
