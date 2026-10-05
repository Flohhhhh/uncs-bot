// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forwardAuth } from "~/lib/auth-forwarding";
vi.mock("~/lib/backend-url", () => ({ getBackendUrl: () => "http://127.0.0.1:4320" }));
const fetcher = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetcher));
const request = () =>
  new Request("http://localhost:3000/admin/auth/callback?code=private-code&state=private-state", {
    headers: { cookie: "state=abc; session=def" },
  });
describe("OAuth forwarding", () => {
  it("forwards cookies and callback query, preserves all cookies, and lands on admin", async () => {
    const headers = new Headers({ Location: "/admin" });
    headers.append("Set-Cookie", "state=; Max-Age=0; Path=/admin");
    headers.append("Set-Cookie", "session=abc; HttpOnly; Path=/admin; Expires=Wed, 07 Oct 2026 00:00:00 GMT");
    fetcher.mockResolvedValue(new Response(null, { status: 302, headers }));
    const response = await forwardAuth(request(), "callback");
    expect(response.headers.get("location")).toBe("/admin");
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4320/admin/auth/callback?code=private-code&state=private-state"),
      expect.objectContaining({ redirect: "manual", cache: "no-store", headers: { Cookie: "state=abc; session=def" } }),
    );
  });
  it("preserves the Discord authorization redirect", async () => {
    const location = "https://discord.com/oauth2/authorize?client_id=123&state=abc";
    fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { Location: location } }));
    expect((await forwardAuth(request(), "login")).headers.get("location")).toBe(location);
    expect(String(fetcher.mock.calls[0][0])).toBe("http://127.0.0.1:4320/admin/auth/login");
  });
  it.each([
    [401, "/sign-in?reason=expired"],
    [403, "/access-denied"],
    [503, "/sign-in?reason=unavailable"],
  ])("maps %i and preserves cookie deletion without diagnostics", async (status, location) => {
    fetcher.mockResolvedValue(
      new Response("sensitive upstream diagnostics", {
        status: Number(status),
        headers: { "Set-Cookie": "state=; Max-Age=0; Path=/admin" },
      }),
    );
    const response = await forwardAuth(request(), "callback");
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.getSetCookie()).toEqual(["state=; Max-Age=0; Path=/admin"]);
    expect(await response.text()).toBe("");
  });
  it("rejects an unexpected external redirect", async () => {
    fetcher.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://example.com/?code=secret" } }),
    );
    expect((await forwardAuth(request(), "callback")).headers.get("location")).toBe("/sign-in?reason=unavailable");
  });
  it("allows 45 seconds and maps timeout to a safe message", async () => {
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    fetcher.mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("secret")))),
    );
    const pending = forwardAuth(request(), "callback");
    timeout.abort();
    expect((await pending).headers.get("location")).toBe("/sign-in?reason=unavailable");
    expect(timer).toHaveBeenCalledWith(45_000);
  });
});
