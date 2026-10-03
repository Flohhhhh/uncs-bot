import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import type { Overview } from "../api/types";
const overview: Overview = {
  observedAt: "2026-09-30T12:00:00Z",
  status: { serverName: "Simulated UNCs", map: "Lonestar", players: { current: 0, max: 100 }, factionScores: [] },
  players: [],
  capabilities: { routes: ["POST /v1/broadcast"] },
};
/** The connection status in the header; "Live" alone also names a navigation group. */
const pill = { selector: ".status-pill > span" };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
let router: ReturnType<typeof createMemoryRouter>;
function mount(path = "/overview", role = "admin") {
  const fetcher = vi.fn(
    async (url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          url.endsWith("/me")
            ? { id: "staff", name: "Test staff", role, csrf: "csrf" }
            : url.endsWith("/servers")
              ? { legacy: true, servers: [{ id: "primary", name: "Test server", version: "0".repeat(64), role }] }
              : url.endsWith("/overview")
                ? overview
                : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  router = createMemoryRouter([{ path: "/*", element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return fetcher;
}
describe("React staff shell", () => {
  it("opens a protected deep link for a viewer without requesting private records", async () => {
    const fetcher = mount("/applications", "viewer");
    // The status names the game's own server name and the last successful check.
    expect((await screen.findByText("Live", pill)).closest(".status-pill")).toHaveAttribute(
      "title",
      expect.stringContaining("Simulated UNCs"),
    );
    expect(screen.queryByRole("link", { name: /Applications/ })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => url.includes("/applications"))).toBe(false);
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
  });
  it("shows Discord sign-in instead of staff data when session checking fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Sign in required" }), { status: 401 })),
    );
    render(<RouterProvider router={createMemoryRouter([{ path: "/*", element: <App /> }])} />);
    expect(await screen.findByRole("link", { name: /Continue with Discord/ })).toHaveAttribute(
      "href",
      "/admin/auth/login",
    );
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("has one refresh loop and pauses it while a confirmation is open or the tab is hidden", async () => {
    vi.useFakeTimers();
    const fetcher = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Live", pill)).toBeInTheDocument();
    const reads = () => fetcher.mock.calls.filter(([url]) => url.endsWith("/overview")).length;
    expect(reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(reads()).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /Send an announcement/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(reads()).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(reads()).toBe(2);
  });
  it("unmounts staff data on a later HTML403 response", async () => {
    const fetcher = mount();
    await screen.findByText("Live", pill);
    fetcher.mockImplementation(async () => new Response("Denied", { status: 403 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Continue with Discord/ })).toBeInTheDocument());
    expect(screen.queryByText("Live", pill)).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("loads and refreshes action history without querying the live game", async () => {
    vi.useFakeTimers();
    const fetcher = mount("/audit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(router.state.location.pathname).toBe("/activity");
    // Selecting the Action history view again is harmless when the hub already opened it.
    fireEvent.click(screen.getByText("Action history", { selector: "button" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("No recorded staff actions")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/audit"))).toHaveLength(3);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/overview"))).toBe(false);
    expect(document.title).toBe("Server activity · The UNCs Admin");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });
  it.each([
    ["/audit?server=primary&id=receipt-1", "/activity", { server: "primary", id: "receipt-1", view: "actions" }],
    ["/combat?server=primary", "/activity", { server: "primary", view: "combat" }],
    ["/votes?server=primary", "/match", { server: "primary", view: "voting" }],
    ["/events?server=primary", "/match", { server: "primary", view: "events" }],
    ["/audit", "/activity", { view: "actions" }],
  ])("redirects %s to its hub view and keeps the server", async (path, pathname, search) => {
    mount(path);
    await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual(search);
    // The old address is replaced, so Back does not bounce through the redirect.
    expect(router.state.historyAction).toBe("REPLACE");
  });
  it("announces a new page by focusing its heading instead of reading refreshed content aloud", async () => {
    mount("/players");
    await screen.findByText("Live", pill);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(document.getElementById("page")?.closest("[aria-live]")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
    await waitFor(() => expect(document.title).toBe("Server activity · The UNCs Admin"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(document.getElementById("page")?.closest("[aria-live]")).toBeNull();
  });
  it("requires a fresh server check after returning from a records page", async () => {
    const fetcher = mount();
    await screen.findByText("Live", pill);
    fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
    fireEvent.click(await screen.findByText("Action history", { selector: "button" }));
    await screen.findByText("No recorded staff actions");
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
    expect(screen.getByText("Stale", pill)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText(/Server details need a fresh check/)).toBeInTheDocument();
    await act(async () => {
      finish(new Response(JSON.stringify(overview)));
    });
  });
  it("expires an old confirmation snapshot while refresh is paused", async () => {
    vi.useFakeTimers();
    const fetcher = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /Send an announcement/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/overview"))).toHaveLength(1);
    expect(screen.getByText(/Server details need a fresh check/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/overview"))).toHaveLength(2);
    expect(screen.getByText("Live", pill)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeEnabled();
  });
  it("opens Action history for an unconfirmed result only after the review closes", async () => {
    const fetcher = mount("/overview?server=primary");
    await screen.findByText("Live", pill);
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith("/actions")
        ? new Response(JSON.stringify({ state: "unknown", message: "The game did not answer." }))
        : original(url, init),
    );
    fireEvent.click(screen.getByRole("button", { name: /Send an announcement/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /In-game message/ }), { target: { value: "GG" } });
    fireEvent.click(screen.getByRole("button", { name: "Send announcement" }));
    const outcome = await screen.findByRole("status", { name: "Action result" });
    const [, init] = fetcher.mock.calls.find(([url]) => url.endsWith("/actions"))!;
    const { id } = JSON.parse(String(init?.body));
    fireEvent.click(within(outcome).getByRole("link", { name: "Action history" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
      server: "primary",
      view: "actions",
      id,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/actions"))).toHaveLength(1);
  });
  it("keeps access, the game build and sign-out in the account menu", async () => {
    const fetcher = mount();
    fetcher.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/me")
              ? { id: "staff", name: "Test staff", role: "admin", csrf: "csrf" }
              : url.endsWith("/servers")
                ? {
                    legacy: true,
                    servers: [{ id: "primary", name: "Test server", version: "0".repeat(64), role: "admin" }],
                  }
                : url.endsWith("/overview")
                  ? { ...overview, capabilities: { ...overview.capabilities, build: "wardogs-1.4.2" } }
                  : [],
          ),
        ),
    );
    await screen.findByText("Live", pill);
    const account = screen.getByRole("button", { name: "Account: Test staff" });
    expect(account).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    fireEvent.click(account);
    expect(account).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Your access: admin", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("wardogs-1.4.2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View permissions" })).toHaveAttribute("href", "/permissions");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(account).toHaveAttribute("aria-expanded", "false");
    expect(account).toHaveFocus();
    fireEvent.click(account);
    fireEvent.pointerDown(document.body);
    expect(account).toHaveAttribute("aria-expanded", "false");
    // The old page chrome is gone: no subtitle, staff label or update footnote.
    expect(screen.queryByText("STAFF ONLY")).not.toBeInTheDocument();
    expect(screen.queryByText(/Updates every 20 seconds/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Server overview" })).toBeInTheDocument();
  });
  it("invalidates the old snapshot while a tab is hidden", async () => {
    mount();
    await screen.findByText("Live", pill);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
  });
  it("does not let a late read restore controls after the tab was hidden", async () => {
    const fetcher = mount();
    await screen.findByText("Live", pill);
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      finish(new Response(JSON.stringify(overview)));
    });
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
  });
  it("keeps a slow read alive instead of restarting it on every automatic refresh", async () => {
    vi.useFakeTimers();
    const fetcher = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/overview"))).toHaveLength(2);
    await act(async () => {
      finish(new Response(JSON.stringify(overview)));
    });
  });
  it("keeps controls locked and reports malformed server data without crashing the page", async () => {
    const fetcher = mount();
    await screen.findByText("Live", pill);
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ unexpected: true })));
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    // One notice carries the error and its retry; the last snapshot stays visible but dimmed.
    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByText("Stale", pill)).toBeInTheDocument();
    expect(document.getElementById("page")).toHaveAttribute("data-stale");
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });
  it("finds an uncertain action by its receipt ID or staff reason", async () => {
    const fetcher = mount("/audit");
    const entry = {
      id: "receipt-unique",
      actorName: "UNC Staff",
      action: "broadcast",
      target: "server",
      state: "unknown",
      message: "Readback unavailable",
      createdAt: "2026-09-30T12:00:00Z",
      details: { reason: "Round briefing" },
    };
    fetcher.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/me")
              ? { id: "staff", name: "Test staff", role: "admin", csrf: "csrf" }
              : url.endsWith("/servers")
                ? {
                    legacy: true,
                    servers: [{ id: "primary", name: "Test server", version: "0".repeat(64), role: "admin" }],
                  }
                : [entry],
          ),
        ),
    );
    fireEvent.click(await screen.findByText("Action history", { selector: "button" }));
    await screen.findByText("receipt-unique");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "receipt-unique" } });
    expect(screen.getByText("Readback unavailable")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Round briefing" } });
    expect(screen.getByText("receipt-unique")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "not-this-receipt" } });
    expect(screen.getByText("No matching staff actions")).toBeInTheDocument();
  });
});
