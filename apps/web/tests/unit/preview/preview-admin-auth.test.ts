// @vitest-environment node
import { expect, test, vi } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { PreviewAdminIdentity } from "../../../../../scripts/preview-admin-auth";
const req = (method = "GET", headers: Record<string, string> = {}) => ({ method, headers }) as Request;
const res = () => ({ cookie: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() }) as unknown as Response;
test("automatic preview remains default and validates write origins and CSRF", () => {
  const auth = new PreviewAdminIdentity(4320);
  expect(auth.authenticate(req()).demo).toBe(true);
  expect(auth.authenticate(req("POST", { origin: "http://localhost:3000", "x-csrf-token": "local-preview" })).id).toBe(
    "preview",
  );
  expect(() =>
    auth.authenticate(req("POST", { origin: "https://evil.example", "x-csrf-token": "local-preview" })),
  ).toThrow(ForbiddenException);
});
test("session preview login, reload, CSRF, logout and stale-cookie rejection", () => {
  const auth = new PreviewAdminIdentity(4320, true);
  expect(() => auth.authenticate(req())).toThrow(UnauthorizedException);
  const response = res();
  auth.login(response);
  const [name, token, options] = (response.cookie as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  const cookie = `${name}=${token}`;
  const staff = auth.authenticate(req("GET", { cookie }));
  expect(auth.authenticate(req("GET", { cookie }))).toEqual(staff);
  expect(() => auth.logout(req("POST", { cookie, origin: "http://127.0.0.1:3000" }), response)).toThrow(
    ForbiddenException,
  );
  expect(
    auth.logout(req("POST", { cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": staff.csrf }), response),
  ).toEqual({ ok: true });
  expect(response.clearCookie).toHaveBeenCalled();
  expect(() => auth.authenticate(req("GET", { cookie }))).toThrow(UnauthorizedException);
});
test("preview sessions expire and unrelated cookies do not authenticate", () => {
  const auth = new PreviewAdminIdentity(4320, true);
  const response = res();
  auth.login(response);
  const [name, token] = (response.cookie as ReturnType<typeof vi.fn>).mock.calls[0];
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 9 * 60 * 60 * 1000);
  try {
    expect(() => auth.authenticate(req("GET", { cookie: `${name}=${token}` }))).toThrow(UnauthorizedException);
    expect(() => auth.authenticate(req("GET", { cookie: "other=abc" }))).toThrow(UnauthorizedException);
  } finally {
    vi.restoreAllMocks();
  }
});
