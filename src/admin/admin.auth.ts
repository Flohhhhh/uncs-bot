import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { AdminSettings } from "./admin.settings";
import { AdminStore } from "./admin.store";
import type { Staff, StaffRole } from "./admin.types";
import { restrictedServerRole, type GameServerSummary } from "../common/game-server";
import { GameServers } from "./game-servers";

export type StaffRequest = Request & { staff: Staff };
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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
/** How long a session that passed the staff check keeps its own /admin traffic bucket before it must pass again. */
const verifiedSessionTtl = 5 * 60_000;
const verifiedSessionLimit = 1000;

@Injectable()
export class AdminAuth {
  private readonly memberCache = new Map<string, { expires: number; role: StaffRole; roles: string[] }>();
  private readonly requestCounts = new Map<string, { until: number; reads: number; writes: number }>();
  // Session token hashes (never the token) that recently passed the staff check at sign-in or in authenticate(),
  // with when that trust ends, in least-recently-verified order. Only the traffic limiters read it; it grants no
  // access.
  private readonly verifiedSessions = new Map<string, number>();
  constructor(
    private readonly settings: AdminSettings,
    private readonly store: AdminStore,
  ) {}

  private cookieOptions() {
    const secure = this.settings.get().secure;
    return { httpOnly: true, secure, sameSite: "lax" as const, path: secure ? "/" : "/admin" };
  }

  private cookieName(kind: "oauth" | "session") {
    // __Host- rejects Domain cookies injected by a sibling subdomain. Its
    // required root path is intentional; staff sessions stay on ADMIN_ORIGIN.
    return `${this.settings.get().secure ? "__Host-" : ""}uncs_admin_${kind}`;
  }

  private limit(userId: string, mutation: boolean) {
    const now = Date.now();
    for (const [id, counter] of this.requestCounts) {
      if (counter.until <= now) this.requestCounts.delete(id);
    }
    let counter = this.requestCounts.get(userId);
    if (!counter) {
      if (this.requestCounts.size >= 1000) throw new HttpException("The dashboard is busy. Try again shortly.", 429);
      counter = { until: now + 60_000, reads: 0, writes: 0 };
      this.requestCounts.set(userId, counter);
    }
    const field = mutation ? "writes" : "reads";
    if (++counter[field] > (mutation ? 30 : 240))
      throw new HttpException("Too many dashboard requests. Wait a minute before trying again.", 429);
  }

  /**
   * The stored hash of this request's session token if that session passed the staff check (at sign-in or on a
   * request) in the last few minutes and has not since been signed out, replaced, found missing or expired, or
   * refused staff access. A session ended outside the dashboard stays here until one of its requests finds that
   * out, or a few minutes pass. The /admin traffic limiter counts such a session in its own bucket. Any other
   * cookie, including a forged one, returns undefined and is counted by address. This only reads memory; it
   * never queries storage.
   */
  verifiedSession(req: Request): string | undefined {
    if (this.verifiedSessions.size === 0) return undefined;
    const token = cookie(req, this.cookieName("session"));
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    const tokenHash = hash(token);
    const until = this.verifiedSessions.get(tokenHash);
    if (until === undefined) return undefined;
    if (until > Date.now()) return tokenHash;
    this.verifiedSessions.delete(tokenHash);
    return undefined;
  }

  private trustSession(tokenHash: string, expiresAt: Date) {
    const now = Date.now();
    // Re-inserting moves the session to the end, so the first entry is always the least recently verified.
    this.verifiedSessions.delete(tokenHash);
    if (this.verifiedSessions.size >= verifiedSessionLimit) {
      for (const [key, until] of this.verifiedSessions) if (until <= now) this.verifiedSessions.delete(key);
      for (const key of this.verifiedSessions.keys()) {
        if (this.verifiedSessions.size < verifiedSessionLimit) break;
        this.verifiedSessions.delete(key);
      }
    }
    this.verifiedSessions.set(tokenHash, Math.min(now + verifiedSessionTtl, expiresAt.getTime()));
  }

  login(res: Response) {
    const config = this.settings.get();
    const nonce = randomBytes(32).toString("hex");
    const value = `${nonce}.${Date.now()}`;
    const signature = createHmac("sha256", config.secret).update(value).digest("hex");
    res.cookie(this.cookieName("oauth"), `${value}.${signature}`, { ...this.cookieOptions(), maxAge: 5 * 60_000 });
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: `${config.origin}/admin/auth/callback`,
      response_type: "code",
      scope: "identify",
      state: nonce,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  }

  private async discord(path: string, init: RequestInit) {
    try {
      const response = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404 || response.status === 401 || response.status === 403)
        throw new ForbiddenException("Discord membership could not be verified.");
      if (!response.ok) throw new ServiceUnavailableException("Discord is unavailable. Please try again shortly.");
      return await response.json();
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Discord is unavailable. Please try again shortly.");
    }
  }

  async role(userId: string, fresh = false): Promise<StaffRole> {
    const previous = this.memberCache.get(userId);
    if (!fresh && previous && previous.expires > Date.now()) return previous.role;
    this.memberCache.delete(userId);
    const config = this.settings.get();
    const member = await this.discord(`/guilds/${config.guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${config.botToken}` },
    });
    if (member.pending === true)
      throw new ForbiddenException("Complete the Discord server membership screening first.");
    const roles: string[] = Array.isArray(member.roles) ? member.roles.filter((role) => typeof role === "string") : [];
    const matches = (allowed: string[]) => roles.some((role) => allowed.includes(role));
    const role =
      config.ownerIds.includes(userId) || matches(config.adminRoleIds)
        ? "admin"
        : matches(config.moderatorRoleIds)
          ? "moderator"
          : matches(config.viewerRoleIds)
            ? "viewer"
            : undefined;
    if (!role) {
      this.memberCache.delete(userId);
      throw new ForbiddenException("Your Discord account does not have dashboard access.");
    }
    if (this.memberCache.size > 500) this.memberCache.clear();
    this.memberCache.set(userId, { expires: Date.now() + 30_000, role, roles });
    return role;
  }

  async serverStaff(staff: Staff, serverId: string, fresh = false): Promise<Staff> {
    const server = this.settings.servers().find((server) => server.id === serverId);
    if (!server) throw new ForbiddenException("This game server is not configured.");
    const globalRole = await this.role(staff.id, fresh);
    const role = this.settings.get().ownerIds.includes(staff.id)
      ? "admin"
      : restrictedServerRole(
          globalRole,
          this.memberCache.get(staff.id)?.roles ?? [],
          this.settings.serverRoles(serverId),
        );
    if (!role) throw new ForbiddenException("Your staff account does not have access to this game server.");
    return { ...staff, role, serverId, serverVersion: server.version };
  }

  async serverList(staff: Staff) {
    await this.role(staff.id);
    const servers: Array<GameServerSummary & { role: StaffRole }> = [];
    for (const server of this.settings.servers()) {
      try {
        servers.push({ ...server, role: (await this.serverStaff(staff, server.id)).role });
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    return { legacy: !this.settings.explicitServers(), servers };
  }

  async callback(req: Request, res: Response) {
    const config = this.settings.get();
    const [nonce, issued, signature, extra] = cookie(req, this.cookieName("oauth")).split(".");
    res.clearCookie(this.cookieName("oauth"), this.cookieOptions());
    const expected = createHmac("sha256", config.secret).update(`${nonce}.${issued}`).digest("hex");
    const age = Date.now() - Number(issued);
    if (
      !/^[a-f0-9]{64}$/.test(nonce ?? "") ||
      !/^[a-f0-9]{64}$/.test(signature ?? "") ||
      extra !== undefined ||
      !equal(signature, expected) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 300_000 ||
      typeof req.query.state !== "string" ||
      !equal(req.query.state, nonce) ||
      typeof req.query.code !== "string" ||
      req.query.code.length === 0 ||
      req.query.code.length > 2048
    ) {
      throw new UnauthorizedException("Sign-in expired. Start again from the dashboard.");
    }
    const tokens = await this.discord("/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: `${config.origin}/admin/auth/callback`,
      }).toString(),
    });
    if (typeof tokens.access_token !== "string") throw new UnauthorizedException("Discord sign-in failed.");
    const identity = await this.discord("/users/@me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (typeof identity.id !== "string" || !/^\d{17,20}$/.test(identity.id))
      throw new UnauthorizedException("Discord sign-in failed.");
    if (identity.bot === true || identity.mfa_enabled !== true)
      throw new ForbiddenException(
        "Enable two-factor authentication on your Discord account before signing in to staff tools.",
      );
    await this.role(identity.id, true);
    const previousToken = cookie(req, this.cookieName("session"));
    if (/^[a-f0-9]{64}$/.test(previousToken)) {
      const previousHash = hash(previousToken);
      this.verifiedSessions.delete(previousHash);
      await this.store.deleteSession(previousHash);
    }
    const token = randomBytes(32).toString("hex");
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + 8 * 3_600_000);
    await this.store.createSession({
      tokenHash,
      userId: identity.id,
      displayName: String(identity.global_name || identity.username || identity.id).slice(0, 100),
      csrf: randomBytes(32).toString("hex"),
      expiresAt,
    });
    // This sign-in has just passed the full staff check, so the new session's first request already counts in
    // its own traffic bucket. Counted by address, that request would be refused while anonymous traffic keeps
    // the shared bucket full, so the session could never be verified and staff could not get back in.
    this.trustSession(tokenHash, expiresAt);
    res.cookie(this.cookieName("session"), token, { ...this.cookieOptions(), maxAge: 8 * 3_600_000 });
    res.redirect("/admin");
  }

  private async readSession(req: Request) {
    const config = this.settings.get();
    const token = cookie(req, this.cookieName("session"));
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException("Sign in with Discord to continue.");
    const tokenHash = hash(token);
    const session = await this.store.session(tokenHash);
    if (!session || !(session.expiresAt instanceof Date) || session.expiresAt.getTime() <= Date.now()) {
      this.verifiedSessions.delete(tokenHash);
      throw new UnauthorizedException("Your session expired. Sign in again.");
    }
    const mutation = req.method !== "GET" && req.method !== "HEAD";
    if (
      mutation &&
      (req.headers.origin !== config.origin ||
        typeof req.headers["x-csrf-token"] !== "string" ||
        !equal(req.headers["x-csrf-token"], session.csrf))
    ) {
      throw new ForbiddenException("This request did not come from your dashboard session.");
    }
    return { session, tokenHash };
  }

  async authenticate(req: Request): Promise<Staff> {
    const { session, tokenHash } = await this.readSession(req);
    const mutation = req.method !== "GET" && req.method !== "HEAD";
    this.limit(session.userId, mutation);
    let role: StaffRole;
    try {
      role = await this.role(session.userId, mutation);
    } catch (error) {
      // Discord says this member no longer has staff access. A Discord outage does not end the trust.
      if (error instanceof ForbiddenException) this.verifiedSessions.delete(tokenHash);
      throw error;
    }
    this.trustSession(tokenHash, session.expiresAt);
    return { id: session.userId, name: session.displayName, csrf: session.csrf, role };
  }

  async logout(req: Request, res: Response) {
    if (req.method !== "POST") throw new ForbiddenException("Use the sign-out button to end this staff session.");
    // Revoking this browser's session must work after role removal or while
    // Discord is unavailable. Keep the same session, origin and CSRF checks.
    const { tokenHash } = await this.readSession(req);
    this.verifiedSessions.delete(tokenHash);
    await this.store.deleteSession(tokenHash);
    res.clearCookie(this.cookieName("session"), this.cookieOptions());
    res.clearCookie(this.cookieName("oauth"), this.cookieOptions());
    return { ok: true };
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuth) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<StaffRequest>();
    req.staff = await this.auth.authenticate(req);
    return true;
  }
}

/** Applies the configured server restriction after the normal session/origin/CSRF guard. */
@Injectable()
export class AdminServerGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuth,
    private readonly servers: GameServers,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<StaffRequest>();
    const id = this.servers.resolve(req.params.serverId as string | undefined);
    if (!["GET", "HEAD"].includes(req.method)) {
      const version = req.headers["x-uncs-server-version"];
      this.servers.checkVersion(id, typeof version === "string" ? version : undefined);
    }
    req.staff = await this.auth.serverStaff(req.staff, id);
    return true;
  }
}
