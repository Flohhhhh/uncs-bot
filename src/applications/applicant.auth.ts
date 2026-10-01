import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { AdminSettings } from "../admin/admin.settings";

const SESSION_MS = 30 * 60_000;
const OAUTH_MS = 5 * 60_000;
const hexToken = /^[a-f0-9]{64}$/;
const discordId = z.string().regex(/^\d{17,20}$/);
const identitySchema = z.object({
  id: discordId,
  username: z.string().min(1).max(100),
  global_name: z.string().max(100).nullable().optional(),
  bot: z.boolean().optional(),
});
const memberSchema = z.object({
  user: z.object({ id: discordId, bot: z.boolean().optional() }),
  pending: z.boolean().optional(),
});
const sessionSchema = z
  .object({
    userId: discordId,
    displayName: z.string().min(1).max(100),
    csrf: z.string().regex(hexToken),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type Applicant = Pick<z.infer<typeof sessionSchema>, "userId" | "displayName" | "csrf">;
export type ApplicantRequest = Request & { applicant: Applicant };

function equal(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(req: Request, name: string) {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  );
}

/** Public community identity. It never reads or creates a staff session. */
@Injectable()
export class ApplicantAuth {
  constructor(private readonly settings: AdminSettings) {}

  private cookieName(kind: "oauth" | "session") {
    return `${this.settings.applicant().secure ? "__Host-" : ""}uncs_applicant_${kind}`;
  }

  private cookieOptions() {
    const secure = this.settings.applicant().secure;
    return { httpOnly: true, secure, sameSite: "lax" as const, path: secure ? "/" : "/apply" };
  }

  private sign(purpose: "oauth" | "session", value: string) {
    const config = this.settings.applicant();
    // Different purposes, origin and guild are cryptographically bound. An
    // applicant signature cannot be substituted for a staff cookie or state.
    return createHmac("sha256", config.secret)
      .update(`uncs-applicant:v1:${purpose}\n${config.origin}\n${config.guildId}\n${value}`)
      .digest("hex");
  }

  login(_req: Request, res: Response) {
    const config = this.settings.applicant();
    const nonce = randomBytes(32).toString("hex");
    const value = `${nonce}.${Date.now()}`;
    res.cookie(this.cookieName("oauth"), `${value}.${this.sign("oauth", value)}`, {
      ...this.cookieOptions(),
      maxAge: OAUTH_MS,
    });
    const query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: `${config.origin}/apply/auth/callback`,
      response_type: "code",
      scope: "identify",
      state: nonce,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${query}`);
  }

  private async discord(path: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if ([400, 401, 403, 404].includes(response.status))
        throw new ForbiddenException("Discord access could not be verified. Join The UNCs Discord and sign in again.");
      if (!response.ok) throw new ServiceUnavailableException("Discord is unavailable. Please try again shortly.");
      return await response.json();
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof ServiceUnavailableException) throw error;
      // Do not expose upstream bodies, OAuth tokens, bot credentials or URLs.
      throw new ServiceUnavailableException("Discord is unavailable. Please try again shortly.");
    }
  }

  private async membership(userId: string) {
    const config = this.settings.applicant();
    const parsed = memberSchema.safeParse(
      await this.discord(`/guilds/${config.guildId}/members/${userId}`, {
        headers: { Authorization: `Bot ${config.botToken}` },
      }),
    );
    if (!parsed.success || parsed.data.user.id !== userId || parsed.data.user.bot === true)
      throw new ForbiddenException("Your Discord server membership could not be verified.");
    if (parsed.data.pending === true)
      throw new ForbiddenException("Complete The UNCs Discord membership screening before submitting an application.");
  }

  async callback(req: Request, res: Response) {
    const config = this.settings.applicant();
    const [nonce, issued, signature, extra] = cookie(req, this.cookieName("oauth")).split(".");
    res.clearCookie(this.cookieName("oauth"), this.cookieOptions());
    const age = Date.now() - Number(issued);
    if (
      !hexToken.test(nonce ?? "") ||
      !/^\d{13}$/.test(issued ?? "") ||
      !hexToken.test(signature ?? "") ||
      extra !== undefined ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > OAUTH_MS ||
      !equal(signature, this.sign("oauth", `${nonce}.${issued}`)) ||
      typeof req.query.state !== "string" ||
      !hexToken.test(req.query.state) ||
      !equal(req.query.state, nonce) ||
      typeof req.query.code !== "string" ||
      req.query.code.length === 0 ||
      req.query.code.length > 2048
    )
      throw new UnauthorizedException("Sign-in expired. Start again from the whitelist application.");

    const tokens = z.object({ access_token: z.string().min(1).max(4096) }).safeParse(
      await this.discord("/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: `${config.origin}/apply/auth/callback`,
        }).toString(),
      }),
    );
    if (!tokens.success) throw new UnauthorizedException("Discord sign-in failed. Please try again.");
    const identity = identitySchema.safeParse(
      await this.discord("/users/@me", {
        headers: { Authorization: `Bearer ${tokens.data.access_token}` },
      }),
    );
    if (!identity.success || identity.data.bot === true)
      throw new ForbiddenException("Sign in with your personal Discord account to apply.");
    await this.membership(identity.data.id);
    const issuedAt = Date.now();
    const session = {
      userId: identity.data.id,
      displayName: (identity.data.global_name || identity.data.username).slice(0, 100),
      csrf: randomBytes(32).toString("hex"),
      issuedAt,
      expiresAt: issuedAt + SESSION_MS,
    };
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    res.cookie(this.cookieName("session"), `${payload}.${this.sign("session", payload)}`, {
      ...this.cookieOptions(),
      maxAge: SESSION_MS,
    });
    res.redirect("/whitelist");
  }

  private readSession(req: Request) {
    const [payload, signature, extra] = cookie(req, this.cookieName("session")).split(".");
    if (
      !/^[A-Za-z0-9_-]{1,2048}$/.test(payload ?? "") ||
      !hexToken.test(signature ?? "") ||
      extra !== undefined ||
      !equal(signature, this.sign("session", payload))
    )
      throw new UnauthorizedException("Sign in with Discord to continue your application.");
    let parsed: ReturnType<typeof sessionSchema.safeParse>;
    try {
      const bytes = Buffer.from(payload, "base64url");
      if (bytes.toString("base64url") !== payload) throw new Error("Invalid encoding");
      parsed = sessionSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new UnauthorizedException("Your application session is invalid. Sign in again.");
    }
    const now = Date.now();
    if (
      !parsed.success ||
      parsed.data.issuedAt > now ||
      parsed.data.expiresAt <= now ||
      parsed.data.expiresAt - parsed.data.issuedAt !== SESSION_MS
    )
      throw new UnauthorizedException("Your application session expired. Sign in again.");
    return parsed.data;
  }

  private checkMutation(req: Request, session: Applicant) {
    if (
      req.headers.origin !== this.settings.applicant().origin ||
      typeof req.headers["x-csrf-token"] !== "string" ||
      !equal(req.headers["x-csrf-token"], session.csrf)
    )
      throw new ForbiddenException("This request did not come from your application session.");
  }

  async authenticate(req: Request): Promise<Applicant> {
    const session = this.readSession(req);
    if (!["GET", "HEAD"].includes(req.method)) {
      this.checkMutation(req, session);
      // Joining the Discord does not establish clan membership, friend status,
      // or ownership of a submitted SteamID. Those remain application claims.
      await this.membership(session.userId);
    }
    return { userId: session.userId, displayName: session.displayName, csrf: session.csrf };
  }

  async logout(req: Request, res: Response) {
    if (req.method !== "POST") throw new ForbiddenException("Use the sign-out button to end this application session.");
    const session = this.readSession(req);
    this.checkMutation(req, session);
    // Signed public sessions have no database record to revoke. Clearing the
    // browser cookie logs this browser out; a copied cookie expires in 30 min.
    res.clearCookie(this.cookieName("session"), this.cookieOptions());
    res.clearCookie(this.cookieName("oauth"), this.cookieOptions());
    return { ok: true };
  }
}
