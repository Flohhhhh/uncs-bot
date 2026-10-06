import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { EnvService } from "./env/env.service";
async function bootstrap() {
  if (process.env.BOT_GATEWAY_ENABLED && !["true", "false"].includes(process.env.BOT_GATEWAY_ENABLED))
    throw new Error("Invalid gateway control.");
  if (process.env.BOT_GATEWAY_ENABLED === "true") {
    const credentials = [process.env.BOT_TO_API_TOKEN, process.env.API_TO_BOT_TOKEN];
    if (credentials.some((value) => !value || !/^[!-~]{32,512}$/.test(value)) || credentials[0] === credentials[1])
      throw new Error("Configure separate internal service credentials before enabling active operation.");
    if (!process.env.API_ORIGIN)
      throw new Error("Configure the remote service origin before enabling active operation.");
  }
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(app.get(EnvService).get("PORT"), "0.0.0.0");
}
void bootstrap().catch(() => {
  console.error("Bot startup failed. Check its service configuration.");
  process.exitCode = 1;
});
