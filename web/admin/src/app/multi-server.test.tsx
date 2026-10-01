import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./app";

const choices = [
  { id: "primary", name: "Primary", version: "1".repeat(64), role: "admin" },
  { id: "event", name: "Events", version: "2".repeat(64), role: "viewer" },
];
const json = (value: unknown) => new Response(JSON.stringify(value));
const overview = (name: string) => ({
  observedAt: new Date().toISOString(),
  status: { serverName: name, map: "Europe", players: { current: 1, max: 100 }, factionScores: [] },
  players: [{ name: `${name} player`, steamId: "76561198000000001" }],
  capabilities: { routes: ["POST /v1/broadcast", "PATCH /v1/players/{id}"] },
});
function mount(
  path: string,
  read = async (url: string): Promise<Response> => json(overview(url.includes("/event/") ? "Events" : "Primary")),
) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith("/me")
      ? json({ id: "staff", name: "Staff", role: "admin", csrf: "test" })
      : url.endsWith("/servers")
        ? json({ legacy: false, servers: choices })
        : read(url),
  );
  vi.stubGlobal("fetch", fetcher);
  const router = createMemoryRouter([{ path: "/*", element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { fetcher, router };
}
afterEach(() => vi.unstubAllGlobals());

it("requires an explicit selection before any game read and hides inaccessible game controls", async () => {
  const { fetcher } = mount("/players");
  expect(await screen.findByRole("heading", { name: "Choose a server" })).toBeInTheDocument();
  expect(fetcher.mock.calls).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox", { name: "Game server" }), { target: { value: "event" } });
  await screen.findByText("Events player");
  expect(screen.queryByRole("link", { name: /Server settings/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Applications/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Supporters/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review move" })).not.toBeInTheDocument();
});
it("cancels a previous server read and ignores its late response after a switch", async () => {
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const { fetcher } = mount("/players?server=primary", (url) =>
    url.includes("/primary/") ? pending : Promise.resolve(json(overview("Events"))),
  );
  fireEvent.change(await screen.findByRole("combobox", { name: "Game server" }), { target: { value: "event" } });
  await screen.findByText("Events player");
  const first = fetcher.mock.calls.find(([url]) => url.includes("/primary/overview"))!;
  expect(first[1]?.signal?.aborted).toBe(true);
  await act(async () => {
    complete(json(overview("Primary")));
  });
  expect(screen.queryByText("Primary player")).not.toBeInTheDocument();
  expect(screen.getByText("Events player")).toBeInTheDocument();
});
it("clears a player selection on switching servers even when both rosters contain the same SteamID", async () => {
  mount("/players?server=primary");
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Primary player" }));
  expect(screen.getByText("1 selected")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Game server" }), { target: { value: "event" } });
  await screen.findByText("Events player");
  expect(screen.getByText("0 selected")).toBeInTheDocument();
});
it("does not silently fall back when an unavailable server is in a deep link", async () => {
  const { fetcher } = mount("/players?server=missing");
  await screen.findByText("That server is unavailable or outside your staff access.");
  await waitFor(() => expect(fetcher.mock.calls).toHaveLength(2));
});
it("preserves the server and opens Rotation from the match shortcut", async () => {
  const { router } = mount("/match?server=primary", async (url) =>
    url.endsWith("/rotation") ? json({ mode: "Ordered", enabled: true, entries: [] }) : json(overview("Primary")),
  );
  const link = await screen.findByRole("link", { name: "Edit rotation & queue next map →" });
  expect(link).toHaveAttribute("href", "/settings?server=primary#rotation");
  // The target is a real fragment, not a percent-encoded pathname.
  expect(router.state.location.search).toBe("?server=primary");
});
