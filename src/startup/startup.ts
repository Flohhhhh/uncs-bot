import { Global, Injectable, Logger, Module, type INestApplication, type OnApplicationBootstrap } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Server } from "node:http";
import { EnvService } from "../env/env.service";

/**
 * Set once Nest's startup has finished: Discord is signed in and every worker has started. Until then /health
 * answers 503, so a deployment reports healthy at the same moment it used to start answering HTTP at all.
 */
@Injectable()
export class StartupState {
  private finished = false;
  get complete() {
    return this.finished;
  }
  finish() {
    this.finished = true;
  }
}

/**
 * Opens the HTTP port before the Discord sign-in.
 *
 * Necord signs in from NecordModule.onApplicationBootstrap, and Nest awaits every bootstrap hook inside
 * app.init(). app.listen() binds the port only after that, so a slow or rate-limited Discord sign-in kept the
 * dashboard, the kill-feed ingest, the community API and the Patreon webhooks offline. (A sign-in that fails
 * outright still ends the process; see startApplication.) Nest runs global modules' hooks first, in import order,
 * and BotModule imports StartupModule ahead of NecordModule. The port therefore opens after every onModuleInit
 * (database check, error handlers) and route registration, but before the sign-in. The sign-in, and every feature
 * module's bootstrap hook after it, keep their order.
 */
@Injectable()
export class OpenHttpBeforeDiscord implements OnApplicationBootstrap {
  private readonly logger = new Logger("Startup");
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap() {
    const adapter = this.adapterHost.httpAdapter;
    const server = adapter.getHttpServer() as Server;
    const port = this.env.get("PORT");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      adapter.listen(port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.adapterHost.listening = true;
    this.logger.log(`HTTP is listening on port ${port}; /health reports ok once Discord is signed in.`);
  }
}

@Global()
@Module({ providers: [StartupState, OpenHttpBeforeDiscord], exports: [StartupState] })
export class StartupModule {}

/**
 * Runs Nest's startup (which now opens HTTP, then signs in to Discord and starts the workers) and marks it complete.
 * A failure is handled as before: log it and exit with code 1 so Railway restarts the service. The exit is explicit
 * because the already-open HTTP port would otherwise keep the process alive without Discord or its workers.
 */
export async function startApplication(
  app: INestApplication,
  exit: (code: number) => void = (code) => process.exit(code),
) {
  try {
    await app.init();
  } catch (error) {
    console.error("💥 Failed to bootstrap the application:", error);
    exit(1);
    return;
  }
  app.get(StartupState).finish();
}
