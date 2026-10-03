import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { AdminAuth, hash } from "./admin.auth";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";

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

describe("verified sessions for the dashboard traffic limit", () => {
  afterEach(() => jest.restoreAllMocks());
  const roles = (...ids: string[]) =>
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ roles: ids })));
  const withCookie = (token: string) =>
    ({ method: "GET", headers: { cookie: `__Host-uncs_admin_session=${token}` } }) as unknown as Request;

  it("trusts a session only after it passes the staff check, and only by its token hash", async () => {
    const { auth, req } = fixture();
    const read = { ...req, method: "GET" } as Request;
    roles("admin-role");
    expect(auth.verifiedSession(read)).toBeUndefined();
    await auth.authenticate(read);
    expect(auth.verifiedSession(read)).toBe(hash("b".repeat(64)));
    // A well-formed cookie that never passed the check gets nothing, even while another session is trusted.
    expect(auth.verifiedSession(withCookie("d".repeat(64)))).toBeUndefined();
    expect(auth.verifiedSession(withCookie("not-a-token"))).toBeUndefined();
  });

  it("trusts the session a staff sign-in creates from its first request, until that session expires", async () => {
    const { auth, store, session } = fixture();
    roles("admin-role");
    const { req, res } = loginCallback(auth);
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: session.userId, username: "Staff", mfa_enabled: true })),
      );
    const start = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(start);
    await auth.callback(req, res as unknown as Response);
    const [, token] = res.cookie.mock.calls[1];
    expect(store.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: hash(token), expiresAt: new Date(start + 8 * 3_600_000) }),
    );
    expect(auth.verifiedSession(withCookie(token))).toBe(hash(token));
    jest.mocked(Date.now).mockReturnValue(start + 5 * 60_000);
    expect(auth.verifiedSession(withCookie(token))).toBeUndefined();
  });

  it.each<[string, (context: ReturnType<typeof fixture>) => Promise<unknown>]>([
    ["signed out", ({ auth, req }) => auth.logout(req, { clearCookie: jest.fn() } as unknown as Response)],
    [
      "replaced by a new sign-in",
      ({ auth, session }) => {
        const { req, res } = loginCallback(auth, `__Host-uncs_admin_session=${"b".repeat(64)}`);
        jest
          .mocked(fetch)
          .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ id: session.userId, username: "Staff", mfa_enabled: true })),
          );
        return auth.callback(req, res as unknown as Response);
      },
    ],
    [
      "missing from storage",
      ({ auth, store, req }) => {
        store.session.mockResolvedValue(undefined);
        return expect(auth.authenticate(req)).rejects.toThrow("Your session expired");
      },
    ],
    [
      "expired",
      ({ auth, req, session }) => {
        session.expiresAt = new Date(Date.now() - 1);
        return expect(auth.authenticate(req)).rejects.toThrow("Your session expired");
      },
    ],
    [
      "refused staff access by Discord",
      ({ auth, req }) => {
        roles();
        return expect(auth.authenticate(req)).rejects.toThrow("does not have dashboard access");
      },
    ],
  ])("stops trusting a session once it is %s", async (_case, end) => {
    const context = fixture();
    const read = { ...context.req, method: "GET" } as Request;
    roles("admin-role");
    await context.auth.authenticate(read);
    expect(context.auth.verifiedSession(read)).toBe(hash("b".repeat(64)));
    await end(context);
    expect(context.auth.verifiedSession(read)).toBeUndefined();
  });

  it.each<[string, (context: ReturnType<typeof fixture>) => Promise<unknown>]>([
    [
      "Discord is unavailable",
      ({ auth, req }) => {
        jest.mocked(fetch).mockImplementation(async () => new Response("upstream", { status: 503 }));
        return expect(auth.authenticate(req)).rejects.toThrow("Discord is unavailable");
      },
    ],
    [
      "a request fails the origin or CSRF check",
      ({ auth, req }) =>
        expect(
          auth.authenticate({ ...req, headers: { ...req.headers, "x-csrf-token": "forged" } } as Request),
        ).rejects.toThrow("dashboard session"),
    ],
    [
      "the per-user limit refuses a request",
      async ({ auth, req }) => {
        for (let count = 0; count < 30; count++) await auth.authenticate(req);
        await expect(auth.authenticate(req)).rejects.toMatchObject({ status: 429 });
      },
    ],
  ])("keeps trusting a verified session when %s, since the session itself is still valid", async (_case, fail) => {
    const context = fixture();
    const read = { ...context.req, method: "GET" } as Request;
    roles("admin-role");
    await context.auth.authenticate(read);
    await fail(context);
    expect(context.auth.verifiedSession(read)).toBe(hash("b".repeat(64)));
  });

  it("ends trust five minutes after the last check, or sooner when the session itself expires", async () => {
    const { auth, req, session } = fixture();
    const read = { ...req, method: "GET" } as Request;
    roles("admin-role");
    const start = Date.now();
    await auth.authenticate(read);
    jest.spyOn(Date, "now").mockReturnValue(start + 61_000);
    // The fixture's session expires after one minute.
    expect(auth.verifiedSession(read)).toBeUndefined();
    jest.mocked(Date.now).mockReturnValue(start);
    session.expiresAt = new Date(start + 8 * 3_600_000);
    await auth.authenticate(read);
    jest.mocked(Date.now).mockReturnValue(start + 5 * 60_000 - 1);
    expect(auth.verifiedSession(read)).toBe(hash("b".repeat(64)));
    jest.mocked(Date.now).mockReturnValue(start + 5 * 60_000);
    expect(auth.verifiedSession(read)).toBeUndefined();
  });

  it("keeps at most 1000 trusted sessions, dropping the least recently verified", async () => {
    const { auth, store, session } = fixture();
    roles("admin-role");
    const tokens = Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, "0"));
    const users = new Map(tokens.map((token, index) => [hash(token), `12345678901234560${index % 10}`]));
    // Spread the sessions over ten users so the per-user request limit is not what stops them.
    store.session.mockImplementation(async (key: string) => ({ ...session, userId: users.get(key) }));
    for (const token of tokens.slice(0, 1000)) await auth.authenticate(withCookie(token));
    await auth.authenticate(withCookie(tokens[0]));
    await auth.authenticate(withCookie(tokens[1000]));
    expect(auth.verifiedSession(withCookie(tokens[1]))).toBeUndefined();
    for (const token of [tokens[0], tokens[2], tokens[1000]])
      expect(auth.verifiedSession(withCookie(token))).toBe(hash(token));
  });
});
