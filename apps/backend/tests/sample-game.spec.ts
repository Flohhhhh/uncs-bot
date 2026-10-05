import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendModule } from "../src/backend.module";
import { validateBackendEnvironment } from "../src/environment";
import { AdminStore } from "../../../src/admin/admin.store";
import { GameServers } from "../../../src/admin/game-servers";
import { createPreviewGame } from "../../../scripts/preview-game";

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }), end: jest.fn() })),
}));
const cookie = `uncs_admin_session=${"a".repeat(64)}`;
let app: INestApplication;
let directory: string;
const store = {
  session: jest.fn().mockResolvedValue({
    userId: "123456789012345678",
    displayName: "Real Staff",
    csrf: "csrf",
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
  deleteSession: jest.fn().mockResolvedValue(undefined),
};
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "uncs-sample-test-"));
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
      "BACKEND_GAME_MODE=sample",
      "BACKEND_SAMPLE_SCENARIO=full-server",
      // Must be ignored in sample mode, rather than making outbound game requests.
      "WARDOGS_RCON_URL=https://live-game.invalid",
      "WARDOGS_RCON_PASSWORD=live-secret",
    ].join("\n"),
  );
  jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (!String(url).startsWith("https://discord.com/api/v10/guilds/")) throw new Error("Unexpected network request");
    return Response.json({ roles: ["123456789012345680"], pending: false });
  });
  const module = await Test.createTestingModule({ imports: [BackendModule.register(file)] })
    .overrideProvider(AdminStore)
    .useValue(store)
    .compile();
  app = module.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app?.close();
  jest.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
test("sample game mode retains real sessions, identity and Discord permissions", async () => {
  await request(app.getHttpServer()).get("/admin/api/me").expect(401);
  const response = await request(app.getHttpServer()).get("/admin/api/me").set("Cookie", cookie).expect(200);
  expect(response.body).toEqual({
    id: "123456789012345678",
    name: "Real Staff",
    csrf: "csrf",
    role: "admin",
    gameMode: "sample",
  });
  expect(response.body.demo).toBeUndefined();
  expect(store.session).toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalled();
});
test("exposes two sample servers and full player rosters without game network calls", async () => {
  const response = await request(app.getHttpServer()).get("/admin/api/servers").set("Cookie", cookie).expect(200);
  expect(response.body.servers.map((server: { id: string }) => server.id)).toEqual(["primary", "event"]);
  for (const id of ["primary", "event"]) {
    const overview = await request(app.getHttpServer())
      .get(`/admin/api/servers/${id}/overview`)
      .set("Cookie", cookie)
      .expect(200);
    expect(overview.body.players).toHaveLength(100);
    expect(overview.body.players[0]).toMatchObject({ name: "UncDap", kills: 18, pingMs: 32 });
    expect(overview.body.status.players.current).toBe(100);
    expect(overview.body.capabilities.routes.every((route: string) => route.startsWith("GET "))).toBe(true);
    expect(JSON.stringify(overview.body)).not.toContain("live-secret");
  }
});
test.each(["bans", "whitelist", "catalog", "rotation", "activity", "settings", "game-log"])(
  "reads sample %s through the real API contract",
  async (resource) => {
    await request(app.getHttpServer()).get(`/admin/api/servers/primary/${resource}`).set("Cookie", cookie).expect(200);
  },
);
test("keeps sample game writes blocked at HTTP and transport boundaries", async () => {
  await request(app.getHttpServer())
    .post("/admin/api/servers/primary/actions")
    .set("Cookie", cookie)
    .send({ action: "restart" })
    .expect(403);
  const game = app.get(GameServers).get("primary");
  await expect(game.request("POST", "/v1/match/restart")).rejects.toThrow("read-only");
});
test("sample data reset and mutation remain isolated between instances", async () => {
  const original = createPreviewGame("Old preview", false);
  const isolated = createPreviewGame("Sample backend", false, { readOnly: true });
  await original.game.request("POST", `/v1/players/${original.players[0].steamId}/kick`);
  expect(original.players).toHaveLength(5);
  expect(isolated.players).toHaveLength(6);
  expect((await isolated.game.overview()).players).toHaveLength(6);
});
test("live remains the default and invalid sample settings fail validation", () => {
  const env = { DATABASE_URL: "postgresql://dev:dev@localhost/development", DISCORD_BOT_TOKEN: "token" };
  expect(validateBackendEnvironment(env).BACKEND_GAME_MODE).toBe("live");
  expect(() => validateBackendEnvironment({ ...env, BACKEND_GAME_MODE: "unknown" })).toThrow("BACKEND_GAME_MODE");
  expect(() => validateBackendEnvironment({ ...env, BACKEND_SAMPLE_SCENARIO: "unknown" })).toThrow(
    "BACKEND_SAMPLE_SCENARIO",
  );
});

test("waiting sample status and player roster agree", async () => {
  const game = createPreviewGame("Waiting sample", false, { mode: "pre-round", readOnly: true }).game;
  const overview = await game.overview();
  expect(overview.players).toHaveLength(1);
  expect(overview.status.players.current).toBe(1);
});
test("sample mode does not grant access to Discord accounts without a staff role", async () => {
  store.session.mockResolvedValueOnce({
    userId: "123456789012345699",
    displayName: "Denied Staff",
    csrf: "csrf",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  jest.mocked(global.fetch).mockResolvedValueOnce(Response.json({ roles: [], pending: false }));
  const response = await request(app.getHttpServer()).get("/admin/api/me").set("Cookie", cookie).expect(403);
  expect(response.body.gameMode).toBeUndefined();
});
