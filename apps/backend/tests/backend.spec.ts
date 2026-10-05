import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ModulesContainer } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { BackendModule } from "../src/backend.module";
import { validateBackendEnvironment } from "../src/environment";
import { EnvService } from "../../../src/env/env.service";
import { AdminStore } from "../../../src/admin/admin.store";

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }), end: jest.fn() })),
}));
const token = "a".repeat(64);
const store = {
  session: jest.fn().mockResolvedValue({
    userId: "123456789012345678",
    displayName: "Development Staff",
    csrf: "csrf",
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
  deleteSession: jest.fn().mockResolvedValue(undefined),
};
let app: INestApplication;
let directory: string;
let previousDatabase: string | undefined;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "uncs-backend-test-"));
  const file = join(directory, ".env");
  writeFileSync(
    file,
    [
      "DATABASE_URL=postgresql://dev:dev@localhost/development",
      "DISCORD_BOT_TOKEN=development-rest-token",
      "ADMIN_ORIGIN=http://localhost:3000",
      "ADMIN_DISCORD_CLIENT_ID=123456789012345678",
      "ADMIN_DISCORD_CLIENT_SECRET=development-client-secret",
      `ADMIN_SESSION_SECRET=${"s".repeat(32)}`,
      "ADMIN_GUILD_ID=123456789012345679",
      "ADMIN_ADMIN_ROLE_IDS=123456789012345680",
    ].join("\n"),
  );
  previousDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://production.invalid/live";
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ roles: ["123456789012345680"], pending: false }));
  const module = await Test.createTestingModule({ imports: [BackendModule.register(file)] })
    .overrideProvider(AdminStore)
    .useValue(store)
    .compile();
  app = module.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app?.close();
  if (previousDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabase;
  jest.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
test("loads only the dedicated environment and starts no bot/background modules", () => {
  expect(app.get(EnvService).get("DATABASE_URL")).toBe("postgresql://dev:dev@localhost/development");
  expect(Pool).toHaveBeenCalledWith(
    expect.objectContaining({ connectionString: "postgresql://dev:dev@localhost/development" }),
  );
  const names = [...app.get(ModulesContainer).values()].map((module) => module.metatype.name);
  expect(names).toContain("AdminModule");
  expect(names).not.toEqual(expect.arrayContaining(["BotModule"]));
  expect(names.some((name) => /Schedule|Monitor|Listeners|Commands/.test(name))).toBe(false);
});
test("login uses existing Discord OAuth and the Next.js callback origin", async () => {
  const response = await request(app.getHttpServer()).get("/admin/auth/login").expect(302);
  const destination = new URL(response.headers.location);
  expect(destination.origin).toBe("https://discord.com");
  expect(destination.searchParams.get("redirect_uri")).toBe("http://localhost:3000/admin/auth/callback");
  expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
});
test("session reads require a cookie and retain real Discord role validation", async () => {
  await request(app.getHttpServer()).get("/admin/api/me").expect(401);
  const response = await request(app.getHttpServer())
    .get("/admin/api/me")
    .set("Cookie", `uncs_admin_session=${token}`)
    .expect(200);
  expect(response.body).toEqual({
    id: "123456789012345678",
    name: "Development Staff",
    role: "admin",
    csrf: "csrf",
    gameMode: "live",
  });
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining("/guilds/123456789012345679/members/123456789012345678"),
    expect.objectContaining({ headers: { Authorization: "Bot development-rest-token" } }),
  );
});
test("blocks game writes before they can reach shared handlers", async () => {
  const response = await request(app.getHttpServer())
    .post("/admin/api/actions")
    .send({ action: "restart" })
    .expect(403);
  expect(response.body.message).toContain("reads and sign-out only");
});
test("allows logout while preserving existing origin and CSRF checks", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/logout")
    .set("Cookie", `uncs_admin_session=${token}`)
    .set("Origin", "http://localhost:3000")
    .expect(403);
  const response = await request(app.getHttpServer())
    .post("/admin/api/logout")
    .set("Cookie", `uncs_admin_session=${token}`)
    .set("Origin", "http://localhost:3000")
    .set("X-CSRF-Token", "csrf")
    .expect(201);
  expect(response.body).toEqual({ ok: true });
  expect(store.deleteSession).toHaveBeenCalled();
  expect(response.headers["set-cookie"][0]).toContain("Expires=Thu, 01 Jan 1970");
});
test("configuration errors name fields without exposing credentials", () => {
  expect(() => validateBackendEnvironment({ DATABASE_URL: "private-invalid-url", DISCORD_BOT_TOKEN: "token" })).toThrow(
    "DATABASE_URL",
  );
  expect(() =>
    validateBackendEnvironment({ DATABASE_URL: "private-invalid-url", DISCORD_BOT_TOKEN: "token" }),
  ).not.toThrow("private-invalid-url");
});
