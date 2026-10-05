import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Logger } from "@nestjs/common";
import { startApplication } from "./startup/startup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();

  // HTTP opens during startup, before the Discord sign-in; /health reports ok once startup completes.
  await startApplication(app);
}
bootstrap().catch((err) => {
  console.error("💥 Failed to bootstrap the application:", err);
  process.exitCode = 1;
});

// Prevent the bot from crashing when deep errors occur
const processLogger = new Logger("process");
process
  .on("unhandledRejection", (err) => {
    processLogger.error("💥 Unhandled Rejection:", err);
  })
  .on("uncaughtException", (err) => {
    processLogger.error("💥 Uncaught Exception:", err);
  });
