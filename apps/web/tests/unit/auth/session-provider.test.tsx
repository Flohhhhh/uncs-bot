import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "~/components/session-provider";
import { AdminSessionGate } from "~/components/admin-session-gate";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
const staff = { id: "123", name: "Staff", role: "admin", csrf: "token" };
let fetcher: ReturnType<typeof vi.fn>;
function Controls() {
  const session = useSession();
  return (
    <>
      <button onClick={() => void session.refresh()}>Refresh</button>
      <button onClick={() => void session.signOut()}>Logout</button>
      <AdminSessionGate>
        <div>Private content</div>
      </AdminSessionGate>
    </>
  );
}
beforeEach(() => {
  fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(staff)));
  vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
it.each([401, 403])("removes protected children when permissions return %i", async (status) => {
  render(
    <SessionProvider>
      <Controls />
    </SessionProvider>,
  );
  await screen.findByText("Private content");
  fetcher.mockResolvedValue(new Response(null, { status }));
  fireEvent.click(screen.getByText("Refresh"));
  await waitFor(() => expect(screen.queryByText("Private content")).not.toBeInTheDocument());
  expect(replace).toHaveBeenCalledWith(status === 401 ? "/sign-in" : "/access-denied");
});
it("removes protected children on a malformed response and offers retry", async () => {
  render(
    <SessionProvider>
      <Controls />
    </SessionProvider>,
  );
  await screen.findByText("Private content");
  fetcher.mockResolvedValueOnce(Response.json({ role: "admin" }));
  fireEvent.click(screen.getByText("Refresh"));
  await screen.findByRole("alert");
  expect(screen.queryByText("Private content")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
  await screen.findByText("Private content");
});
it("polls only authenticated visible tabs and rechecks on focus", async () => {
  vi.useFakeTimers();
  try {
    render(
      <SessionProvider>
        <Controls />
      </SessionProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
it("rechecks signed-out sessions on focus", async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  render(
    <SessionProvider>
      <Controls />
    </SessionProvider>,
  );
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  fireEvent(window, new Event("focus"));
  await screen.findByText("Private content");
});
it("hides protected content throughout uncertain logout and only retries manually", async () => {
  render(
    <SessionProvider>
      <Controls />
    </SessionProvider>,
  );
  await screen.findByText("Private content");
  fetcher.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByText("Logout"));
  expect(screen.queryByText("Private content")).not.toBeInTheDocument();
  await screen.findByRole("button", { name: "Retry sign-out" });
  fireEvent(window, new Event("focus"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
  fireEvent.click(screen.getByRole("button", { name: "Retry sign-out" }));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  expect(screen.queryByText("Private content")).not.toBeInTheDocument();
});
