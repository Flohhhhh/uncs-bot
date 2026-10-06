import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { AdminAuth, hash } from "../src/admin/admin.auth";
import { AdminSettings } from "../src/admin/admin.settings";
import { AdminStore } from "../src/admin/admin.store";

const config = {
  origin: "https://admin.example.test",
  clientId: "123",
  clientSecret: "oauth-secret",
  secret: "a".repeat(40),
  guildId: "82988952587337728",
  botToken: "bot-secret",
  ownerIds: [],
  adminRoleIds: ["admin-role"],
  moderatorRoleIds: ["mod-role"],
  viewerRoleIds: ["viewer-role"],
  secure: true,
};
function fixture(ownerIds: string[] = []) {
  const session = {
    userId: "123456789012345678",
    displayName: "Test staff",
    csrf: "csrf-secret",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const store = { session: jest.fn().mockResolvedValue(session), createSession: jest.fn(), deleteSession: jest.fn() };
  const settings = { get: () => ({ ...config, ownerIds }) } as unknown as AdminSettings;
  const auth = new AdminAuth(settings, store as unknown as AdminStore);
  const req = {
    method: "POST",
    headers: {
      cookie: `__Host-uncs_admin_session=${"b".repeat(64)}`,
      origin: config.origin,
      "x-csrf-token": session.csrf,
    },
  } as unknown as Request;
  return { auth, store, req, session };
}

function loginCallback(auth: AdminAuth, sessionCookie = "") {
  const res = { cookie: jest.fn(), redirect: jest.fn(), clearCookie: jest.fn() };
  auth.login(res as unknown as Response);
  const [name, value] = res.cookie.mock.calls[0];
  const state = new URL(res.redirect.mock.calls[0][0]).searchParams.get("state");
  const req = {
    headers: { cookie: `${name}=${value}${sessionCookie ? `; ${sessionCookie}` : ""}` },
    query: { state, code: "one-use-code" },
  } as unknown as Request;
  return { req, res };
}
describe("Discord dashboard access", () => {
  afterEach(() => jest.restoreAllMocks());
  it("rejects missing sessions, foreign origins and missing CSRF tokens", async () => {
    const { auth, store, req } = fixture();
    await expect(auth.authenticate({ ...req, headers: {} } as Request)).rejects.toThrow("Sign in");
    expect(store.session).not.toHaveBeenCalled();
    await expect(
      auth.authenticate({ ...req, headers: { ...req.headers, origin: "https://evil.example" } } as Request),
    ).rejects.toThrow("dashboard session");
    await expect(
      auth.authenticate({ ...req, headers: { ...req.headers, "x-csrf-token": undefined } } as unknown as Request),
    ).rejects.toThrow("dashboard session");
  });
  it("rechecks membership before every mutation, even after a cached read", async () => {
    const { auth, req } = fixture();
    const network = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ["admin-role"] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: [] })));
    expect((await auth.authenticate({ ...req, method: "GET" } as Request)).role).toBe("admin");
    await expect(auth.authenticate(req)).rejects.toThrow("does not have dashboard access");
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("requires explicit staff roles and uses hashed session lookup", async () => {
    const { auth, store, req } = fixture();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ roles: ["mod-role"] })));
    expect((await auth.authenticate(req)).role).toBe("moderator");
    expect(store.session).toHaveBeenCalledWith(hash("b".repeat(64)));
  });
  it.each([
    ["a staff role", [], ["admin-role"]],
    ["an owner ID", ["123456789012345678"], []],
  ])("refuses a member still in membership screening who has %s", async (_case, ownerIds, roles) => {
    const { auth, store, req, session } = fixture(ownerIds);
    const screening = "Complete the Discord server membership screening first.";
    const network = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ roles, pending: true })));
    await expect(auth.authenticate({ ...req, method: "GET" } as Request)).rejects.toThrow(screening);
    // Nothing was cached, so the next read asks Discord again.
    await expect(auth.authenticate({ ...req, method: "GET" } as Request)).rejects.toThrow(screening);
    expect(network).toHaveBeenCalledTimes(2);
    const login = loginCallback(auth);
    network
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: session.userId, username: "Staff", mfa_enabled: true })),
      );
    await expect(auth.callback(login.req, login.res as unknown as Response)).rejects.toThrow(screening);
    expect(store.createSession).not.toHaveBeenCalled();
    expect(login.res.cookie).toHaveBeenCalledTimes(1);
  });
  it("rejects expired sessions even if returned by storage", async () => {
    const { auth, req, session } = fixture();
    session.expiresAt = new Date(Date.now() - 1);
    const network = jest.spyOn(globalThis, "fetch");
    await expect(auth.authenticate(req)).rejects.toThrow("Your session expired");
    expect(network).not.toHaveBeenCalled();
  });
  it("fails closed when Discord cannot verify fresh membership", async () => {
    const { auth, req } = fixture();
    const network = jest.spyOn(globalThis, "fetch");
    network.mockResolvedValueOnce(new Response(JSON.stringify({ roles: ["admin-role"] })));
    expect((await auth.authenticate({ ...req, method: "GET" } as Request)).role).toBe("admin");
    network.mockResolvedValue(new Response("upstream secret", { status: 503 }));
    await expect(auth.authenticate(req)).rejects.toThrow("Discord is unavailable");
    await expect(auth.authenticate({ ...req, method: "GET" } as Request)).rejects.toThrow("Discord is unavailable");
    expect(network).toHaveBeenCalledTimes(3);
  });
  it("bounds per-user mutations before contacting Discord again", async () => {
    const { auth, req } = fixture();
    const network = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ roles: ["mod-role"] })));
    // Each network response body can be consumed once.
    network.mockImplementation(async () => new Response(JSON.stringify({ roles: ["mod-role"] })));
    for (let count = 0; count < 30; count++) await auth.authenticate(req);
    await expect(auth.authenticate(req)).rejects.toMatchObject({ status: 429 });
    expect(network).toHaveBeenCalledTimes(30);
  });
  it("uses state-bound, expiring OAuth login cookies", () => {
    const { auth } = fixture();
    const res = { cookie: jest.fn(), redirect: jest.fn() };
    auth.login(res as unknown as Response);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe("__Host-uncs_admin_oauth");
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 300_000 });
    expect(options.domain).toBeUndefined();
    const [nonce, time, signature] = value.split(".");
    expect(signature).toBe(createHmac("sha256", config.secret).update(`${nonce}.${time}`).digest("hex"));
    expect(new URL(res.redirect.mock.calls[0][0]).searchParams.get("state")).toBe(nonce);
  });
  it("rejects forged OAuth callbacks without contacting Discord", async () => {
    const { auth } = fixture();
    const res = { clearCookie: jest.fn() };
    const network = jest.spyOn(globalThis, "fetch");
    await expect(
      auth.callback(
        {
          headers: { cookie: "__Host-uncs_admin_oauth=bad.0.forged" },
          query: { code: "code", state: "bad" },
        } as unknown as Request,
        res as unknown as Response,
      ),
    ).rejects.toThrow("Sign-in expired");
    expect(network).not.toHaveBeenCalled();
  });
  it.each([false, undefined])("requires Discord two-factor enabled, including when the field is %s", async (mfa) => {
    const { auth, store, session } = fixture();
    const { req, res } = loginCallback(auth);
    const network = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: session.userId, mfa_enabled: mfa })));
    await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow("two-factor authentication");
    expect(store.createSession).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("rotates an existing session after a successful MFA-enabled staff login", async () => {
    const { auth, store, session } = fixture();
    const { req, res } = loginCallback(auth, `__Host-uncs_admin_session=${"b".repeat(64)}`);
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: session.userId, username: "Staff", mfa_enabled: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ["admin-role"] })));
    await auth.callback(req, res as unknown as Response);
    expect(store.deleteSession).toHaveBeenCalledWith(hash("b".repeat(64)));
    const [, token, options] = res.cookie.mock.calls[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(store.createSession).toHaveBeenCalledWith(expect.objectContaining({ tokenHash: hash(token) }));
    expect(JSON.stringify(store.createSession.mock.calls)).not.toContain("private-oauth-token");
  });
  it("rejects an expired signed OAuth state before exchanging credentials", async () => {
    const { auth } = fixture();
    const { req, res } = loginCallback(auth);
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
    const network = jest.spyOn(globalThis, "fetch");
    await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow("Sign-in expired");
    expect(network).not.toHaveBeenCalled();
  });
  it("revokes the server-side session on logout", async () => {
    const { auth, store, req } = fixture();
    const res = { clearCookie: jest.fn() };
    await auth.logout(req, res as unknown as Response);
    expect(store.deleteSession).toHaveBeenCalledWith(hash("b".repeat(64)));
    expect(res.clearCookie).toHaveBeenCalled();
  });
});
