import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount(path = "/overview", role = "admin") {
  const fetcher = vi.fn(
    async (url: string) =>
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
  render(
    <RouterProvider router={createMemoryRouter([{ path: "/*", element: <App /> }], { initialEntries: [path] })} />,
  );
  return fetcher;
}
describe("React staff shell", () => {
  it("opens a protected deep link for a viewer without requesting private records", async () => {
    const fetcher = mount("/applications", "viewer");
    await screen.findByText("Simulated UNCs");
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
    expect(screen.getByText("Simulated UNCs")).toBeInTheDocument();
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
    await screen.findByText("Simulated UNCs");
    fetcher.mockImplementation(async () => new Response("Denied", { status: 403 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Continue with Discord/ })).toBeInTheDocument());
    expect(screen.queryByText("Simulated UNCs")).not.toBeInTheDocument();
  });
  it("loads and refreshes action history without querying the live game", async () => {
    vi.useFakeTimers();
    const fetcher = mount("/audit");
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
    expect(document.title).toBe("Action history · The UNCs Admin");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });
  it("announces a new page by focusing its heading instead of reading refreshed content aloud", async () => {
    mount("/players");
    await screen.findByText("Simulated UNCs");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(document.getElementById("page")?.closest("[aria-live]")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
    await waitFor(() => expect(document.title).toBe("Server activity · The UNCs Admin"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(document.getElementById("page")?.closest("[aria-live]")).toBeNull();
  });
  it("requires a fresh server check after returning from a records page", async () => {
    const fetcher = mount();
    await screen.findByText("Simulated UNCs");
    fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Action history" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeEnabled();
  });
  it("invalidates the old snapshot while a tab is hidden", async () => {
    mount();
    await screen.findByText("Simulated UNCs");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("button", { name: /Send an announcement/ })).toBeDisabled();
  });
  it("does not let a late read restore controls after the tab was hidden", async () => {
    const fetcher = mount();
    await screen.findByText("Simulated UNCs");
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
    await screen.findByText("Simulated UNCs");
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ unexpected: true })));
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await screen.findByRole("alert");
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
    await screen.findByText("receipt-unique");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "receipt-unique" } });
    expect(screen.getByText("Readback unavailable")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Round briefing" } });
    expect(screen.getByText("receipt-unique")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "not-this-receipt" } });
    expect(screen.getByText("No matching staff actions")).toBeInTheDocument();
  });
  it("finishes a 25-player team move that runs past the paused dashboard's 60-second snapshot expiry", async () => {
    vi.useFakeTimers();
    const players = Array.from({ length: 25 }, (_, index) => ({
      name: `Player ${index + 1}`,
      steamId: String(76561198000000101n + BigInt(index)),
      faction: "RED",
    }));
    const live: Overview = {
      ...overview,
      status: {
        ...overview.status,
        map: "Harbor",
        matchSeconds: 120,
        players: { current: players.length, max: 100 },
        factionScores: [
          { name: "Valkyra", colorHex: "#D86060", score: 0 },
          { name: "Lonestar", colorHex: "#5B95D8", score: 0 },
        ],
      },
      players,
      capabilities: { routes: ["PATCH /v1/players/{steamId}"] },
    };
    const moves: { steamId: string; at: number }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/actions")) {
          const action = JSON.parse(String(init?.body));
          moves.push({ steamId: action.steamId, at: Date.now() });
          // The server reads the roster, sends the change and reads it back before answering.
          await new Promise((resolve) => setTimeout(resolve, 500));
          return new Response(JSON.stringify({ id: action.id, state: "applied", changed: true, message: "Confirmed" }));
        }
        return new Response(
          JSON.stringify(
            url.endsWith("/me")
              ? { id: "staff", name: "Test staff", role: "admin", csrf: "csrf" }
              : url.endsWith("/servers")
                ? {
                    legacy: true,
                    servers: [{ id: "primary", name: "Test server", version: "0".repeat(64), role: "admin" }],
                  }
                : url.endsWith("/overview")
                  ? live
                  : [],
          ),
        );
      }),
    );
    render(
      <RouterProvider
        router={createMemoryRouter([{ path: "/*", element: <App /> }], { initialEntries: ["/players"] })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const loaded = Date.now();
    fireEvent.click(screen.getByLabelText("Select all shown players"));
    fireEvent.change(screen.getByRole("combobox", { name: "Destination team for selected players" }), {
      target: { value: "Lonestar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review move" }));
    // Reviewing 25 names takes a moment; the open dialog pauses the dashboard's own roster refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    fireEvent.click(screen.getByRole("button", { name: /^Move 25 players/ }));
    // A second at a time, so each state change renders as it would in the browser.
    for (let second = 0; second < 90; second++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    expect(moves.map((move) => move.steamId)).toEqual(players.map((player) => player.steamId));
    expect(moves.at(-1)!.at - loaded).toBeGreaterThan(60_000);
    expect(screen.getByRole("heading", { name: "Team requests complete" })).toBeInTheDocument();
  });
});
