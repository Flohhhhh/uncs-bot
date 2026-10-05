/** Isolated demo identity; never used by the real Nest application. */
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { Staff } from "../src/admin/admin.types";

const cookieName = "uncs_preview_session";
const lifetime = 8 * 60 * 60 * 1000;
type PreviewStaff = Staff & { demo: true };

export class PreviewAdminIdentity {
  private readonly sessions = new Map<string, { staff: PreviewStaff; expires: number }>();
  private readonly origins: Set<string>;
  constructor(
    port: number,
    private readonly sessionMode = false,
  ) {
    this.origins = new Set(
      [4317, 4318, 4319, port, 3000].flatMap((value) => [`http://127.0.0.1:${value}`, `http://localhost:${value}`]),
    );
  }
  private token(req: Request) {
    return (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  }
  authenticate(req: Request): PreviewStaff {
    let staff: PreviewStaff = { id: "preview", name: "UNC Staff", role: "admin", csrf: "local-preview", demo: true };
    if (this.sessionMode) {
      const token = this.token(req);
      const session = token ? this.sessions.get(token) : undefined;
      if (!session || session.expires <= Date.now()) {
        if (token) this.sessions.delete(token);
        throw new UnauthorizedException("Preview session expired");
      }
      staff = session.staff;
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (!this.origins.has(req.headers.origin ?? "") || req.headers["x-csrf-token"] !== staff.csrf)
    )
      throw new ForbiddenException("Preview origin or CSRF rejected");
    return staff;
  }
  login(res: Response) {
    if (this.sessionMode) {
      for (const [token, session] of this.sessions) if (session.expires <= Date.now()) this.sessions.delete(token);
      const token = randomBytes(32).toString("hex");
      this.sessions.set(token, {
        staff: { id: "preview", name: "UNC Staff", role: "admin", csrf: randomBytes(32).toString("hex"), demo: true },
        expires: Date.now() + lifetime,
      });
      res.cookie(cookieName, token, { httpOnly: true, sameSite: "lax", path: "/admin", maxAge: lifetime });
    }
    res.redirect("/admin");
  }
  logout(req: Request, res: Response) {
    this.authenticate(req);
    const token = this.token(req);
    if (token) this.sessions.delete(token);
    if (this.sessionMode) res.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/admin" });
    return { ok: true };
  }
}
