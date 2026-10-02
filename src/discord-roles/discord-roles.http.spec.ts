import { Global, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { hash } from "../admin/admin.auth";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { WardogsClient } from "../admin/wardogs.client";
import { EnvService } from "../env/env.service";
import { DiscordRolesDiscord } from "./discord-roles.discord";
import { DiscordRolesModule } from "./discord-roles.module";
import { DiscordRolesStore } from "./discord-roles.store";

const values: Record<string, unknown> = {
  DISCORD_ROLES_ENABLED: false,
  ADMIN_GUILD_ID: "100000000000000001",
  DISCORD_MEMBER_ROLE_ID: "200000000000000001",
  DISCORD_FOUNDER_ROLE_ID: "200000000000000002",
};
@Global()
@Module({
  providers: [{ provide: EnvService, useValue: { get: (key: string) => values[key] } }],
  exports: [EnvService],
})
class TestEnvModule {}

describe("Discord roles HTTP boundary", () => {
  let app: INestApplication;
  const sessionToken = "d".repeat(64);
  const config = {
    origin: "https://admin.example.test",
    clientId: "123",
    clientSecret: "private",
    secret: "s".repeat(40),
    guildId: "guild",
    botToken: "bot-token",
    ownerIds: [],
    adminRoleIds: ["staff"],
    moderatorRoleIds: ["moderator"],
    viewerRoleIds: ["viewer"],
    secure: true,
  };
  const store = {
    desired: jest.fn(async () => ({ member: new Map([["300000000000000001", "application"]]), founder: new Map() })),
    revokedBasis: jest.fn(async () => new Map()),
    lastEffective: jest.fn(async () => null),
    begin: jest.fn(),
    note: jest.fn(),
    summary: jest.fn(async () => ({ memberEligible: 1, founders: 0, foundersWithoutDiscord: 0 })),
    foundersWithoutDiscord: jest.fn(async () => []),
    recent: jest.fn(async () => []),
  };
  const discord = {
    ready: () => true,
    check: jest.fn(async () => ({
      manageRoles: true,
      highestRolePosition: 9,
      roles: {
        member: { id: values.DISCORD_MEMBER_ROLE_ID, assignable: true, problem: null },
        founder: { id: values.DISCORD_FOUNDER_ROLE_ID, assignable: true, problem: null },
      },
    })),
    member: jest.fn(async () => ({ id: "300000000000000001", joinedAt: null, has: () => false })),
  };
  const adminStore = { session: jest.fn() };
  beforeEach(async () => {
    jest.clearAllMocks();
    adminStore.session.mockImplementation(async (key) =>
      key === hash(sessionToken)
        ? { userId: "123456789012345678", displayName: "Admin", csrf: "csrf", expiresAt: new Date(Date.now() + 60_000) }
        : undefined,
    );
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ roles: ["staff"] })));
    const module = await Test.createTestingModule({ imports: [TestEnvModule, DiscordRolesModule] })
      .overrideProvider(AdminSettings)
      .useValue({ get: () => config })
      .overrideProvider(AdminStore)
      .useValue(adminStore)
      .overrideProvider(WardogsClient)
      .useValue({})
      .overrideProvider(DiscordRolesStore)
      .useValue(store)
      .overrideProvider(DiscordRolesDiscord)
      .useValue(discord)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  const cookie = `__Host-uncs_admin_session=${sessionToken}`;

  it("lets signed-in administrators read the role status without caching it", async () => {
    await request(app.getHttpServer()).get("/admin/api/discord-roles").expect(401);
    const response = await request(app.getHttpServer())
      .get("/admin/api/discord-roles")
      .set("Cookie", cookie)
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ enabled: false, ready: true, summary: { memberEligible: 1 } });
  });

  it.each(["moderator", "viewer"])("refuses the role status to %s staff", async (role) => {
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: [role] })));
    await request(app.getHttpServer()).get("/admin/api/discord-roles").set("Cookie", cookie).expect(403);
    expect(store.summary).not.toHaveBeenCalled();
  });

  it("requires same-origin CSRF for a role check and allows only a preview while switched off", async () => {
    const endpoint = "/admin/api/discord-roles/reconcile";
    const body = { id: randomUUID(), reason: "Preview the role changes", dryRun: true };
    await request(app.getHttpServer()).post(endpoint).set("Cookie", cookie).send(body).expect(403);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", cookie)
      .set("Origin", "https://other.example")
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: ["moderator"] })));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", cookie)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(403);
    expect(discord.member).not.toHaveBeenCalled();
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ roles: ["staff"] })));
    const preview = await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", cookie)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send(body)
      .expect(201);
    expect(preview.body.summary.plan).toEqual([
      { discordUserId: "300000000000000001", roleKind: "member", op: "add", why: "desired" },
    ]);
    expect(store.begin).not.toHaveBeenCalled();
    const refused = await request(app.getHttpServer())
      .post(endpoint)
      .set("Cookie", cookie)
      .set("Origin", config.origin)
      .set("X-CSRF-Token", "csrf")
      .send({ ...body, id: randomUUID(), dryRun: false })
      .expect(503);
    expect(refused.body).toEqual({ message: "Discord roles are switched off (DISCORD_ROLES_ENABLED=false)." });
  });

  it("does not reveal database or Discord error details", async () => {
    store.summary.mockRejectedValueOnce(new Error("postgres://secret@private-db bot-token"));
    const response = await request(app.getHttpServer())
      .get("/admin/api/discord-roles")
      .set("Cookie", cookie)
      .expect(503);
    expect(response.text).not.toMatch(/postgres|secret|private-db|bot-token/);
  });
});
