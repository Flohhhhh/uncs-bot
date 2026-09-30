import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
            : url.endsWith("/overview")
              ? overview
              : {},
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
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
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
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
    fireEvent.click(screen.getByRole("button", { name: "↻ Refresh" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Continue with Discord/ })).toBeInTheDocument());
    expect(screen.queryByText("Simulated UNCs")).not.toBeInTheDocument();
  });
});
