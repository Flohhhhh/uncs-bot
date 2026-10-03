import { Controller, Get, Logger, NotFoundException, type INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
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

  it("still returns an HttpException's own response", async () => {
    const response = await request(app.getHttpServer()).get("/probe/http").expect(404);
    expect(response.body).toEqual({ statusCode: 404, message: "No such vote.", error: "Not Found" });
  });
});
