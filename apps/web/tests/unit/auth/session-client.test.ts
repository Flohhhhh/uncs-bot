import { describe, expect, it, vi } from "vitest";
import { endSession, readSession, SessionError } from "~/lib/session/client";

const staff = { id: "123", name: "Staff", role: "admin", csrf: "token", demo: true };
describe("session client", () => {
  it("validates staff and sends same-origin credentials without caching", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(staff));
    vi.stubGlobal("fetch", fetcher);
    expect(await readSession(new AbortController().signal)).toEqual(staff);
    expect(fetcher).toHaveBeenCalledWith(
      "/admin/api/me",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }),
    );
  });
  it.each([{ ...staff, role: "owner" }, { ...staff, csrf: "" }, { id: "123" }])(
    "rejects malformed staff %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(readSession(new AbortController().signal)).rejects.toThrow();
    },
  );
  it.each([401, 403])("preserves %i without waiting for an error body", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream(), { status })));
    await expect(readSession(new AbortController().signal)).rejects.toEqual(new SessionError(status));
  });
  it("limits requests to ten seconds and propagates a timeout", async () => {
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const result = readSession(new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("Timed out");
    timeout.abort(new Error("Timed out"));
    await rejected;
    expect(timer).toHaveBeenCalledWith(10_000);
  });
  it("forwards CSRF on one logout POST and validates confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await endSession("token", new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/admin/api/logout",
      expect.objectContaining({ method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": "token" } }),
    );
    fetcher.mockResolvedValue(Response.json({ ok: false }));
    await expect(endSession("token", new AbortController().signal)).rejects.toThrow();
  });
});
