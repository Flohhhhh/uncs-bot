import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AdminModule } from "./admin.module";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import { WardogsClient } from "./wardogs.client";
import { hash } from "./admin.auth";

describe("action receipt HTTP access", () => {
  let app: INestApplication;
  const token = "e".repeat(64);
  const id = randomUUID();
  const record = {
    id,
    actorName: "Earlier staff",
    action: "kick",
    target: "76561198000000001",
    details: { reason: "Resolved connection" },
    state: "unknown",
    message: "Game result was not confirmed.",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const store = { session: jest.fn(), receipt: jest.fn(), history: jest.fn() };
  const game = { overview: jest.fn(), execute: jest.fn() };
  beforeEach(async () => {
    jest.clearAllMocks();
    store.session.mockImplementation(async (key) =>
      key === hash(token)
        ? {
            userId: "123456789012345678",
            displayName: "Staff",
            csrf: "fixture",
            expiresAt: new Date(Date.now() + 60_000),
          }
        : undefined,
    );
    store.receipt.mockResolvedValue(record);
    store.history.mockResolvedValue(
      Array.from({ length: 100 }, () => ({ ...record, id: randomUUID(), createdAt: "2026-09-30T00:00:00.000Z" })),
    );
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ roles: ["admin"] })));
    const adapter = new ExpressAdapter();
    const adapterHost = new HttpAdapterHost();
    adapterHost.httpAdapter = adapter;
    const module = await Test.createTestingModule({ imports: [AdminModule] })
      .overrideProvider(HttpAdapterHost)
      .useValue(adapterHost)
      .overrideProvider(AdminSettings)
      .useValue({
        get: () => ({
          origin: "https://admin.example.test",
          clientId: "123",
          clientSecret: "private",
          secret: "s".repeat(40),
          guildId: "guild",
          botToken: "bot-token",
          secure: true,
          ownerIds: [],
          adminRoleIds: ["admin"],
          moderatorRoleIds: ["moderator"],
          viewerRoleIds: ["viewer"],
        }),
      })
      .overrideProvider(AdminStore)
      .useValue(store)
      .overrideProvider(WardogsClient)
      .useValue(game)
      .compile();
    app = module.createNestApplication(adapter);
    app.useLogger(false);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it("retrieves an older receipt absent from the latest 100 without any game request", async () => {
    const recent = await request(app.getHttpServer())
      .get("/admin/api/audit")
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(200);
    expect(recent.body).toHaveLength(100);
    expect(recent.body.some((item: { id: string }) => item.id === id)).toBe(false);
    const response = await request(app.getHttpServer())
      .get(`/admin/api/audit/${id}`)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(200);
    expect(response.body).toEqual({ record });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(store.receipt).toHaveBeenCalledWith(id);
    expect(game.overview).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it.each(["viewer", "moderator", "admin"])(
    "keeps receipt reads available to the existing %s history role",
    async (role) => {
      jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: [role] })));
      await request(app.getHttpServer())
        .get(`/admin/api/audit/${id.toUpperCase()}`)
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .expect(200, { record });
      expect(store.receipt).toHaveBeenCalledWith(id);
    },
  );
  it("rejects anonymous and unauthorized accounts before reading any receipt", async () => {
    await request(app.getHttpServer()).get(`/admin/api/audit/${id}`).expect(401);
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ roles: [] })));
    await request(app.getHttpServer())
      .get(`/admin/api/audit/${id}`)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(403);
    expect(store.receipt).not.toHaveBeenCalled();
  });
  it.each(["not-a-uuid", "12345678-1234-0234-1234-123456789012", "<private-input>"])(
    "rejects malformed action IDs without echoing input or querying storage",
    async (value) => {
      await request(app.getHttpServer())
        .get(`/admin/api/audit/${encodeURIComponent(value)}`)
        .set("Cookie", `__Host-uncs_admin_session=${token}`)
        .expect(400, { message: "Enter a valid action ID." });
      expect(store.receipt).not.toHaveBeenCalled();
    },
  );
  it("distinguishes an absent receipt from a storage failure without leaking database errors", async () => {
    store.receipt.mockResolvedValueOnce(null);
    await request(app.getHttpServer())
      .get(`/admin/api/audit/${id}`)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(200, { record: null });
    store.receipt.mockRejectedValueOnce(new Error("postgres://private:secret@db/credentials"));
    const response = await request(app.getHttpServer())
      .get(`/admin/api/audit/${id}`)
      .set("Cookie", `__Host-uncs_admin_session=${token}`)
      .expect(503);
    expect(response.body).toEqual({ message: "The action receipt could not be loaded. Try again shortly." });
    expect(game.execute).not.toHaveBeenCalled();
  });
});
