import { afterEach, describe, expect, it, vi } from "vitest";
import { api, configureSession } from "./client";
afterEach(() => {
  configureSession("");
  vi.unstubAllGlobals();
});
describe("staff API boundary", () => {
  it("keeps credentials same-origin and attaches CSRF only to submitted JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: "accepted" })));
    vi.stubGlobal("fetch", fetcher);
    configureSession("csrf");
    await api("actions", { method: "POST", body: JSON.stringify({ id: "action-id" }) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("/admin/api/actions");
    expect(request.credentials).toBe("same-origin");
    expect(request.redirect).toBe("error");
    expect(request.headers.get("X-CSRF-Token")).toBe("csrf");
  });
  it.each([401, 403])("clears private session even when denial %s is not JSON", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Access denied", { status })));
    const denied = vi.fn();
    configureSession("csrf", denied);
    await expect(api("applications")).rejects.toMatchObject({ status });
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it("rejects data that finishes parsing after logout", async () => {
    let release!: (data: unknown) => void;
    const body = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body }));
    configureSession("old-session");
    const request = api("supporters");
    await Promise.resolve();
    configureSession("");
    release({ privateEmail: "private@example.test" });
    await expect(request).rejects.toMatchObject({ status: 401 });
  });
  it("does not retry uncertain writes", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetcher);
    await expect(api("actions", { method: "POST", body: "{}" })).rejects.toThrow("before confirmation");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a foreign URL before any network request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(api("https://evil.example/test")).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
