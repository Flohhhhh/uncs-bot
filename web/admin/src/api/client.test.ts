import { afterEach, describe, expect, it, vi } from "vitest";
import { api, configureSession, isReadPending, MUTATION_TIMEOUT_MS, READ_TIMEOUT_MS } from "./client";
import { rejectionState } from "../features/actions/policy";
afterEach(() => {
  configureSession("");
  vi.useRealTimers();
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
  it("allows dots in a query value but still refuses route traversal", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ supporters: [] })));
    vi.stubGlobal("fetch", fetcher);
    await expect(api(`supporters?search=${encodeURIComponent("Wait...")}`)).resolves.toEqual({ supporters: [] });
    expect(fetcher).toHaveBeenCalledWith("/admin/api/supporters?search=Wait...", expect.any(Object));
    for (const path of ["servers/../supporters", "supporters/..?search=x"])
      await expect(api(path)).rejects.toMatchObject({ message: "Invalid API path.", status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])("invalidates immediately on %s without waiting for an error body", async (status) => {
    const body = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, json: body }));
    const denied = vi.fn();
    configureSession("csrf", denied);
    await expect(api("supporters")).rejects.toMatchObject({ status });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
    expect(isReadPending()).toBe(false);
  });
  it.each(["headers", "body"])(
    "keeps an in-flight mutation uncertain when the session changes before %s completes",
    async (phase) => {
      vi.useFakeTimers();
      let release!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const response = {
        ok: true,
        status: 200,
        json: vi.fn(() => (phase === "body" ? pending : Promise.resolve({ state: "applied" }))),
      };
      const fetcher = vi.fn().mockReturnValue(phase === "headers" ? pending : Promise.resolve(response));
      vi.stubGlobal("fetch", fetcher);
      configureSession("old");
      const request = api("actions", { method: "POST", body: "{}" }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(response.json).toHaveBeenCalledTimes(phase === "body" ? 1 : 0);
      configureSession("new");
      release(phase === "headers" ? response : { state: "applied" });
      const error = await request;
      expect(error).toMatchObject({ status: 0 });
      expect(rejectionState(error)).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(isReadPending()).toBe(false);
    },
  );
  it("times out a stalled fetch, aborts it, and releases the pending-read counter", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const fetcher = vi.fn((_path, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetcher);
    const result = api("overview").catch((error) => error);
    expect(isReadPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(await result).toMatchObject({ status: 0, message: expect.stringContaining("timed out") });
    expect(signal.aborted).toBe(true);
    expect(isReadPending()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds reading a mutation response body and never claims timeout is a definite rejection", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    vi.stubGlobal("fetch", fetcher);
    const result = api("actions", { method: "POST", body: "{}" }).catch((error) => error);
    expect(isReadPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(MUTATION_TIMEOUT_MS);
    const error = await result;
    expect(error).toMatchObject({ message: expect.stringContaining("before confirmation") });
    expect(rejectionState(error)).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves caller cancellation during body reading and removes its listener", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const body = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: body }));
    const result = api("combat", { signal: caller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(body).toHaveBeenCalledTimes(1);
    const reason = new DOMException("Navigation changed", "AbortError");
    caller.abort(reason);
    expect(await result).toBe(reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(isReadPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not fetch or start a timer for a request already cancelled by its caller", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const caller = new AbortController();
    const reason = new DOMException("Navigation changed", "AbortError");
    caller.abort(reason);
    await expect(api("combat", { signal: caller.signal })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    expect(isReadPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("tracks concurrent reads until each finishes, including invalid JSON", async () => {
    let release!: (value: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn().mockReturnValueOnce(response).mockResolvedValueOnce(new Response("invalid JSON"));
    vi.stubGlobal("fetch", fetcher);
    const first = api("overview");
    await expect(api("audit")).rejects.toMatchObject({ status: 200 });
    expect(isReadPending()).toBe(true);
    release(new Response("{}"));
    await first;
    expect(isReadPending()).toBe(false);
  });
  it("does not let an old-session denial revoke a newer session", async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const previous = vi.fn();
    const current = vi.fn();
    configureSession("old", previous);
    const request = api("supporters");
    configureSession("new", current);
    release(new Response("Denied", { status: 403 }));
    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(previous).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(isReadPending()).toBe(false);
  });
});
