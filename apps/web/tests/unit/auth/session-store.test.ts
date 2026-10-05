import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, endSession, SessionError, type Staff } from "~/lib/session/client";
import { SessionStore } from "~/lib/session/store";
vi.mock("~/lib/session/client", async (original) => ({
  ...(await original<typeof import("~/lib/session/client")>()),
  readSession: vi.fn(),
  endSession: vi.fn(),
}));
const staff: Staff = { id: "123", name: "Staff", role: "admin", csrf: "token" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.mocked(readSession).mockReset().mockResolvedValue(staff);
  vi.mocked(endSession).mockReset().mockResolvedValue(undefined);
});
describe("session lifecycle", () => {
  it.each([
    [401, "signed-out"],
    [403, "denied"],
  ])("clears staff immediately for %i", async (code, status) => {
    const store = new SessionStore();
    await store.check();
    vi.mocked(readSession).mockRejectedValue(new SessionError(Number(code)));
    await store.check();
    expect(store.getSnapshot()).toMatchObject({ status, user: null });
  });
  it("hides staff on connection failure and permits manual recovery", async () => {
    const store = new SessionStore();
    await store.check();
    vi.mocked(readSession).mockRejectedValueOnce(new Error("offline"));
    await store.check();
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", user: null, failure: "session" });
    await store.check();
    expect(store.getSnapshot().status).toBe("authenticated");
  });
  it("ignores older checks, including responses from transports that ignore abort", async () => {
    const older = deferred<Staff>();
    vi.mocked(readSession).mockReturnValueOnce(older.promise).mockRejectedValueOnce(new SessionError(403));
    const store = new SessionStore();
    const pending = store.check();
    await store.check();
    older.resolve(staff);
    await pending;
    expect(store.getSnapshot().status).toBe("denied");
  });
  it("unmounts staff during logout, deduplicates it, and ignores a pending session read", async () => {
    const store = new SessionStore();
    await store.check();
    const read = deferred<Staff>();
    const logout = deferred<void>();
    vi.mocked(readSession).mockReturnValueOnce(read.promise);
    vi.mocked(endSession).mockReturnValueOnce(logout.promise);
    const pendingRead = store.check();
    const pendingLogout = store.signOut();
    expect(store.getSnapshot()).toMatchObject({ status: "checking", user: null });
    await store.signOut();
    store.pauseChecks(); // switching tabs must not discard the logout result
    read.resolve(staff);
    await pendingRead;
    logout.resolve();
    await pendingLogout;
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).toBe("signed-out");
  });
  it("never repeats an uncertain logout automatically; manual retry retains only its CSRF", async () => {
    const store = new SessionStore();
    await store.check();
    vi.mocked(endSession).mockRejectedValueOnce(new Error("offline"));
    await store.signOut();
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", failure: "logout", user: null });
    await store.check();
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
    await store.signOut();
    expect(endSession).toHaveBeenLastCalledWith("token", expect.any(AbortSignal));
    expect(store.getSnapshot().status).toBe("signed-out");
  });
  it("treats an expired logout as signed out", async () => {
    const store = new SessionStore();
    await store.check();
    vi.mocked(endSession).mockRejectedValue(new SessionError(401));
    await store.signOut();
    expect(store.getSnapshot().status).toBe("signed-out");
  });
});
