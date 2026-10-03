import { Global, Injectable, Module, type INestApplication, type OnApplicationBootstrap } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "discord.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AppController } from "../app.controller";
import { BotModule } from "../bot/bot.module";
import { EnvService } from "../env/env.service";
import { startApplication } from "./startup";

const env: Record<string, unknown> = { PORT: 0, DISCORD_BOT_TOKEN: "not-a-real-token", NEST_ENV: "production" };

@Global()
@Module({ providers: [{ provide: EnvService, useValue: { get: (key: string) => env[key] } }], exports: [EnvService] })
class TestEnvModule {}

/** Stands in for the feature workers (community, staff alerts, votes, ...) that start in their bootstrap hooks. */
const worker = { startedAfterSignIn: undefined as boolean | undefined };
let signedIn = false;
@Injectable()
class WorkerProbe implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    worker.startedAfterSignIn = signedIn;
  }
}
@Module({ providers: [WorkerProbe] })
class WorkerModule {}

describe("startup before the Discord sign-in", () => {
  let app: INestApplication;
  let listeningAtSignIn: boolean | undefined;

  const server = () => app.getHttpServer() as Server;
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${(server().address() as AddressInfo).port}/health`);
    return { status: response.status, body: await response.json() };
  };
  /** Replaces Necord's real Discord sign-in, recording whether the HTTP port was already open when it began. */
  const signIn = (result: () => Promise<string>) => {
    let begun!: () => void;
    const started = new Promise<void>((resolve) => (begun = resolve));
    jest.spyOn(Client.prototype, "login").mockImplementation(() => {
      listeningAtSignIn = server().listening;
      begun();
      return result();
    });
    return started;
  };

  beforeEach(async () => {
    worker.startedAfterSignIn = undefined;
    signedIn = false;
    listeningAtSignIn = undefined;
    const module = await Test.createTestingModule({
      imports: [TestEnvModule, BotModule, WorkerModule],
      controllers: [AppController],
    }).compile();
    app = module.createNestApplication({ logger: false });
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it("serves HTTP while the sign-in is pending and reports healthy only once startup finishes", async () => {
    let finishSignIn!: () => void;
    const pending = new Promise<string>((resolve) => (finishSignIn = () => resolve("not-a-real-token")));
    const begun = signIn(() => pending.then((token) => ((signedIn = true), token)));
    const exit = jest.fn();

    const startup = startApplication(app, exit);
    await begun;
    expect(listeningAtSignIn).toBe(true);
    expect(await health()).toEqual({ status: 503, body: { status: "starting" } });
    // Workers still wait for the sign-in, exactly as before.
    expect(worker.startedAfterSignIn).toBeUndefined();

    finishSignIn();
    await startup;
    expect(worker.startedAfterSignIn).toBe(true);
    expect(await health()).toEqual({ status: 200, body: { status: "ok" } });
    expect(exit).not.toHaveBeenCalled();
  });

  it("still logs and exits with code 1 when the sign-in fails, although HTTP is already open", async () => {
    const begun = signIn(() => Promise.reject(new Error("An invalid token was provided.")));
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = jest.fn();

    await startApplication(app, exit);
    await begun;
    expect(listeningAtSignIn).toBe(true);
    expect(logged).toHaveBeenCalledWith(
      "💥 Failed to bootstrap the application:",
      expect.objectContaining({ message: "An invalid token was provided." }),
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(worker.startedAfterSignIn).toBeUndefined();
    expect(await health()).toEqual({ status: 503, body: { status: "starting" } });
  });
});
