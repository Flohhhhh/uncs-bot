import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { resolve } from "node:path";
import { BackendModule } from "./backend.module";
import { EnvService } from "../../../src/env/env.service";

async function bootstrap() {
  const app = await NestFactory.create(BackendModule.register(resolve(process.cwd(), ".env")));
  app.enableShutdownHooks();
  await app.listen(app.get(EnvService).get("PORT"), "127.0.0.1");
}
void bootstrap().catch(() => {
  // Avoid logging database URLs, OAuth credentials or upstream diagnostics.
  console.error("Development backend could not start. Check apps/backend/.env and development database connectivity.");
  process.exitCode = 1;
});
