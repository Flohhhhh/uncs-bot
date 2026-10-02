import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { ApplicantAuth } from "./applicant.auth";
import type { AdminSettings } from "../admin/admin.settings";

const userId = "123456789012345678";
const config = {
  origin: "https://theuncs.example",
  clientId: "223456789012345678",
  clientSecret: "private-client-secret",
  secret: "a".repeat(40),
  guildId: "82988952587337728",
  botToken: "private-bot-token",
  secure: true,
};
const member = { user: { id: userId, bot: false }, roles: [], pending: false };

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn(), locals: {} as Record<string, unknown> };
}
function fixture(server?: string) {
  const settings = {
    applicant: () => ({ ...config }),
    servers: () => [{ id: "primary" }, { id: "event" }],
  } as unknown as AdminSettings;
  const auth = new ApplicantAuth(settings);
  const res = response();
  auth.login({ query: server === undefined ? {} : { server } } as Request, res as unknown as Response);
  const [name, value] = res.cookie.mock.calls[0];
  res.locals = {};
  const state = new URL(res.redirect.mock.calls[0][0]).searchParams.get("state");
  const req = {
    method: "GET",
    headers: { cookie: `${name}=${value}` },
    query: { code: "one-use-code", state },
  } as unknown as Request;
  return { auth, req, res, settings };
}
function validDiscord(identity = { id: userId, username: "Community applicant", bot: false, mfa_enabled: false }) {
  return jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
    .mockResolvedValueOnce(new Response(JSON.stringify(identity)))
    .mockResolvedValueOnce(new Response(JSON.stringify(member)));
}
async function signedIn() {
  const setup = fixture();
  const network = validDiscord();
  await setup.auth.callback(setup.req, setup.res as unknown as Response);
  const [name, value] = setup.res.cookie.mock.calls[1];
  const session = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString("utf8"));
  const req = { method: "GET", headers: { cookie: `${name}=${value}` } } as Request;
  return { ...setup, req, network, session, value };
}
function signedPayload(payload: Record<string, unknown>, purpose = "session") {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", config.secret)
    .update(`uncs-applicant:v1:${purpose}\n${config.origin}\n${config.guildId}\n${encoded}`)
    .digest("hex");
  return `${encoded}.${signature}`;
}

describe("public applicant Discord authentication", () => {
  afterEach(() => jest.restoreAllMocks());

  it("requests identify only with a distinct signed state and secure host-only cookie", () => {
    const { req, res } = fixture();
    const url = new URL(res.redirect.mock.calls[0][0]);
    expect(url.origin).toBe("https://discord.com");
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("redirect_uri")).toBe(`${config.origin}/apply/auth/callback`);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe("__Host-uncs_applicant_oauth");
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 300_000 });
    expect(options.domain).toBeUndefined();
    expect(value).toMatch(/^[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/);
    expect(req.query.state).toBe(value.split(".")[0]);
  });

  it("allows a real guild member without staff roles or MFA and stores no OAuth credential", async () => {
    const { auth, req, res, session, network } = await signedIn();
    expect(res.redirect).toHaveBeenLastCalledWith("/whitelist");
    const [name, , options] = res.cookie.mock.calls[1];
    expect(name).toBe("__Host-uncs_applicant_session");
    expect(options).toMatchObject({ httpOnly: true, secure: true, path: "/", maxAge: 1_800_000 });
    expect(Object.keys(session).sort()).toEqual(["csrf", "displayName", "expiresAt", "issuedAt", "userId"]);
    expect(session.expiresAt - session.issuedAt).toBe(1_800_000);
    expect(session.csrf).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(res.cookie.mock.calls)).not.toMatch(
      /private-oauth-token|private-bot-token|private-client-secret/,
    );
    await expect(auth.authenticate(req)).resolves.toEqual({
      userId,
      displayName: "Community applicant",
      csrf: session.csrf,
    });
    expect(network).toHaveBeenCalledTimes(3);
    expect(network.mock.calls[2][0]).toBe(`https://discord.com/api/v10/guilds/${config.guildId}/members/${userId}`);
    expect(network.mock.calls[2][1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bot ${config.botToken}` },
    });
    expect(network.mock.calls[2][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns to the server selected before sign-in, ignoring a callback target override", async () => {
    const { auth, req, res } = fixture("event");
    req.query.server = "primary";
    validDiscord();
    await auth.callback(req, res as unknown as Response);
    expect(res.redirect).toHaveBeenLastCalledWith("/whitelist?server=event");
  });

  it("rejects a changed server in the signed OAuth cookie before contacting Discord", async () => {
    const { auth, req, res } = fixture("event");
    req.headers.cookie = req.headers.cookie!.replace(".event.", ".primary.");
    const network = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Discord request"));
    await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow("Sign-in expired");
    expect(network).not.toHaveBeenCalled();
    expect(res.locals.applicantServer).toBeUndefined();
  });

  it("does not finish sign-in if the selected server was removed during OAuth", async () => {
    const { auth, req, res, settings } = fixture("event");
    jest.spyOn(settings, "servers").mockReturnValue([{ id: "primary", name: "The UNCs", version: "test" }]);
    const network = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Discord request"));
    await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow("Choose a configured game server");
    expect(network).not.toHaveBeenCalled();
    expect(res.locals.applicantServer).toBe("event");
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it.each(["", "missing", "//evil.example", ["event", "primary"]])(
    "rejects an invalid or unconfigured login target: %j",
    (server) => {
      const { auth } = fixture();
      const res = response();
      expect(() => auth.login({ query: { server } } as unknown as Request, res as unknown as Response)).toThrow(
        "Choose a configured game server",
      );
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "expired", "discord-unavailable"])(
    "retains the signed server for the error page when sign-in is %s",
    async (failure) => {
      const { auth, req, res } = fixture("event");
      res.locals = {};
      const network = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Discord unavailable"));
      if (failure === "cancelled") delete req.query.code;
      if (failure === "expired") jest.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
      await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow();
      expect(res.locals.applicantServer).toBe("event");
      if (failure !== "discord-unavailable") expect(network).not.toHaveBeenCalled();
    },
  );

  it.each(["forged", "wrong-state", "expired", "oversized-code", "array-code"])(
    "rejects %s OAuth callbacks before any Discord request",
    async (kind) => {
      const { auth, req, res } = fixture();
      if (kind === "forged") req.headers.cookie = "__Host-uncs_applicant_oauth=bad.0.forged";
      if (kind === "wrong-state") req.query.state = "f".repeat(64);
      if (kind === "expired") jest.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
      if (kind === "oversized-code") req.query.code = "a".repeat(2049);
      if (kind === "array-code") req.query.code = ["first", "second"];
      const network = jest.spyOn(globalThis, "fetch");
      await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow("Sign-in expired");
      expect(network).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith("__Host-uncs_applicant_oauth", expect.any(Object));
      expect(res.cookie).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects bot identities before checking guild membership", async () => {
    const { auth, req, res } = fixture();
    const network = validDiscord({ id: userId, username: "Bot", bot: true, mfa_enabled: false });
    await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow("personal Discord account");
    expect(network).toHaveBeenCalledTimes(2);
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it.each([
    { user: { id: "123456789012345679" }, pending: false },
    { user: { id: userId, bot: true }, pending: false },
    { roles: [] },
    { ...member, pending: true },
  ])("rejects unverified or pending guild membership: %j", async (invalidMember) => {
    const { auth, req, res } = fixture();
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-oauth-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: userId, username: "Applicant" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(invalidMember)));
    await expect(auth.callback(req, res as unknown as Response)).rejects.toMatchObject({ status: 403 });
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it("requires application cookies and never accepts a staff session", async () => {
    const { auth } = fixture();
    const network = jest.spyOn(globalThis, "fetch");
    await expect(
      auth.authenticate({
        method: "GET",
        headers: { cookie: `__Host-uncs_admin_session=${"b".repeat(64)}` },
      } as Request),
    ).rejects.toThrow("Sign in with Discord");
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects a tampered session, a cross-purpose signature, and excessive expiry", async () => {
    const { auth, req, session } = await signedIn();
    const variants = [
      `${Buffer.from(JSON.stringify({ ...session, userId: "123456789012345679" })).toString("base64url")}.${"b".repeat(64)}`,
      signedPayload(session, "oauth"),
      signedPayload({ ...session, expiresAt: session.expiresAt + 1 }),
      signedPayload({ ...session, role: "admin" }),
    ];
    for (const value of variants) {
      await expect(
        auth.authenticate({ ...req, headers: { cookie: `__Host-uncs_applicant_session=${value}` } } as Request),
      ).rejects.toMatchObject({ status: 401 });
    }
  });

  it("expires public sessions after thirty minutes without a sliding renewal", async () => {
    const { auth, req, session, res } = await signedIn();
    jest.spyOn(Date, "now").mockReturnValue(session.expiresAt);
    await expect(auth.authenticate(req)).rejects.toThrow("session expired");
    expect(res.cookie).toHaveBeenCalledTimes(2);
  });

  it("requires both the exact public origin and browser session CSRF before verifying a mutation", async () => {
    const { auth, req, session, network } = await signedIn();
    network.mockClear();
    for (const headers of [
      {},
      { origin: config.origin },
      { origin: "https://evil.example", "x-csrf-token": session.csrf, "x-forwarded-host": "theuncs.example" },
      { origin: "https://admin.theuncs.example", "x-csrf-token": session.csrf },
      { origin: config.origin, "x-csrf-token": "incorrect" },
    ]) {
      await expect(
        auth.authenticate({ ...req, method: "POST", headers: { ...req.headers, ...headers } } as Request),
      ).rejects.toThrow("application session");
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("rechecks real membership on every mutation and denies a member who has left", async () => {
    const { auth, req, session, network } = await signedIn();
    network.mockReset();
    network
      .mockResolvedValueOnce(new Response(JSON.stringify(member)))
      .mockResolvedValueOnce(new Response("private upstream response", { status: 404 }));
    const mutation = {
      ...req,
      method: "POST",
      headers: { ...req.headers, origin: config.origin, "x-csrf-token": session.csrf },
    } as unknown as Request;
    await expect(auth.authenticate(mutation)).resolves.toMatchObject({ userId });
    await expect(auth.authenticate(mutation)).rejects.toThrow("Discord access could not be verified");
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("does not expose network or Discord response secrets", async () => {
    const { auth, req, res } = fixture();
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Authorization: Bearer private-oauth-token at internal.example"));
    await expect(auth.callback(req, res as unknown as Response)).rejects.toThrow(
      "Discord is unavailable. Please try again shortly.",
    );
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it("only clears applicant cookies on a CSRF-checked POST logout", async () => {
    const { auth, req, res, session, network } = await signedIn();
    network.mockClear();
    res.clearCookie.mockClear();
    await expect(auth.logout(req, res as unknown as Response)).rejects.toMatchObject({ status: 403 });
    await expect(auth.logout({ ...req, method: "POST" } as Request, res as unknown as Response)).rejects.toThrow(
      "application session",
    );
    expect(res.clearCookie).not.toHaveBeenCalled();
    await expect(
      auth.logout(
        {
          ...req,
          method: "POST",
          headers: { ...req.headers, origin: config.origin, "x-csrf-token": session.csrf },
        } as unknown as Request,
        res as unknown as Response,
      ),
    ).resolves.toEqual({ ok: true });
    expect(res.clearCookie.mock.calls.map(([name]) => name)).toEqual([
      "__Host-uncs_applicant_session",
      "__Host-uncs_applicant_oauth",
    ]);
    expect(network).not.toHaveBeenCalled();
  });

  it("uses an application-only cookie path for the local development exception", () => {
    const auth = new ApplicantAuth({
      applicant: () => ({ ...config, origin: "http://127.0.0.1:4317", secure: false }),
    } as unknown as AdminSettings);
    const res = response();
    auth.login({} as Request, res as unknown as Response);
    expect(res.cookie).toHaveBeenCalledWith(
      "uncs_applicant_oauth",
      expect.any(String),
      expect.objectContaining({ path: "/apply", secure: false, httpOnly: true }),
    );
  });
});
