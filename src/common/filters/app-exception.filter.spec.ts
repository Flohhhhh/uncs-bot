import { Body, Controller, Get, Logger, NotFoundException, Post, type INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { DiscordAPIError } from "discord.js";
import request from "supertest";
import { AppExceptionFilter } from "./app-exception.filter";

@Controller("probe")
class ProbeController {
  @Get("internal")
  internal() {
    throw new Error("ENOENT: no such file or directory, stat '/app/dist/src/admin/public/assets/missing.js'");
  }

  @Get("http")
  http() {
    throw new NotFoundException("No such vote.");
  }

  @Get("upstream")
  upstream() {
    throw Object.assign(new Error("Request failed with status code 404"), { status: 404 });
  }

  @Get("discord")
  discord() {
    throw new DiscordAPIError(
      { code: 50013, message: "Missing Permissions" },
      50013,
      403,
      "POST",
      "/channels/1/messages",
      {},
    );
  }

  @Get("http-error")
  httpError() {
    throw Object.assign(new Error("ENOTDIR: not a directory, stat '/app/x'"), {
      status: 404,
      statusCode: 404,
      expose: true,
    });
  }

  @Post("body")
  body(@Body() body: unknown) {
    return { received: typeof body };
  }
}

describe("AppExceptionFilter over HTTP", () => {
  let app: INestApplication;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    errorLog = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it("answers an unexpected error with a fixed 500 and keeps its message in the log only", async () => {
    const response = await request(app.getHttpServer()).get("/probe/internal").expect(500);
    expect(response.body).toEqual({ statusCode: 500, message: "Internal server error." });
    expect(response.text).not.toContain("/app/dist");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("/app/dist/src/admin/public/assets/missing.js"));
  });

  it("answers a body over the parser's limit with 413, not a server error", async () => {
    const response = await request(app.getHttpServer())
      .post("/probe/body")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ events: "x".repeat(120 * 1024) }))
      .expect(413);
    expect(response.body).toEqual({ statusCode: 413, message: "Request body too large." });
  });

  it.each([
    ["an unsupported content encoding", { "Content-Type": "application/json", "Content-Encoding": "klingon" }],
    ["an unsupported charset", { "Content-Type": "application/json; charset=klingon" }],
  ])("answers a body with %s with 415 and a fixed message", async (_case, headers) => {
    const response = await request(app.getHttpServer()).post("/probe/body").set(headers).send("{}").expect(415);
    expect(response.body).toEqual({ statusCode: 415, message: "Unsupported request encoding." });
    expect(response.text).not.toContain("klingon");
  });

  it("answers another client error from Express's middleware with its status and a fixed message", async () => {
    const response = await request(app.getHttpServer()).get("/probe/http-error").expect(404);
    expect(response.body).toEqual({ statusCode: 404, message: "Not Found." });
  });

  it.each([
    ["an upstream", "upstream"],
    ["a Discord", "discord"],
  ])("keeps %s error's status out of the reply: it is a plain 500", async (_name, path) => {
    const response = await request(app.getHttpServer()).get(`/probe/${path}`).expect(500);
    expect(response.body).toEqual({ statusCode: 500, message: "Internal server error." });
  });

  it("still returns an HttpException's own response", async () => {
    const response = await request(app.getHttpServer()).get("/probe/http").expect(404);
    expect(response.body).toEqual({ statusCode: 404, message: "No such vote.", error: "Not Found" });
  });
});
