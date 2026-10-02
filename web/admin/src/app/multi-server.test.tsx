import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
function switchServer(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Game server" }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${name} `) }));
}

it("requires an explicit selection before any game read and hides inaccessible game controls", async () => {
  const { fetcher } = mount("/players");
  expect(await screen.findByRole("heading", { name: "Choose a server" })).toBeInTheDocument();
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(screen.queryByRole("combobox", { name: "Game server" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Primary admin" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Events viewer" }));
  await screen.findByText("Events player");
  expect(screen.queryByRole("link", { name: /Server settings/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Applications/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Supporters/ })).toBeInTheDocument();
  const sections = within(screen.getByRole("combobox", { name: "Dashboard section" }));
  expect(sections.queryByRole("option", { name: "Server settings" })).not.toBeInTheDocument();
  expect(sections.queryByRole("option", { name: "Applications" })).not.toBeInTheDocument();
  expect(sections.getByRole("option", { name: "Supporters" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review move" })).not.toBeInTheDocument();
});
it("retains the selected server when using the compact section picker", async () => {
  const { router } = mount("/players?server=event");
  fireEvent.change(await screen.findByRole("combobox", { name: "Dashboard section" }), {
    target: { value: "permissions" },
  });
  await waitFor(() => expect(router.state.location.pathname).toBe("/permissions"));
  expect(router.state.location.search).toBe("?server=event");
  expect(screen.getByRole("combobox", { name: "Dashboard section" })).toHaveValue("permissions");
});
it("cancels a previous server read and ignores its late response after a switch", async () => {
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const { fetcher } = mount("/players?server=primary", (url) =>
    url.includes("/primary/") ? pending : Promise.resolve(json(overview("Events"))),
  );
  expect(await screen.findByText("Connecting…")).toBeInTheDocument();
  expect(screen.queryByText("Connection needs attention")).not.toBeInTheDocument();
  await screen.findByRole("combobox", { name: "Game server" });
  switchServer("Events");
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
  switchServer("Events");
  await screen.findByText("Events player");
  expect(screen.getByText("0 selected")).toBeInTheDocument();
});
it("moves through servers with the keyboard and switches only on Enter", async () => {
  const { router, fetcher } = mount("/players?server=primary");
  const switcher = await screen.findByRole("combobox", { name: "Game server" });
  await screen.findByText("Primary player");
  expect(switcher).toHaveTextContent("Primary");
  expect(switcher).toHaveAttribute("aria-expanded", "false");
  const eventReads = () => fetcher.mock.calls.filter(([url]) => url.includes("/servers/event/"));
  switcher.focus();
  fireEvent.keyDown(switcher, { key: "ArrowDown" });
  expect(switcher).toHaveAttribute("aria-expanded", "true");
  const options = within(screen.getByRole("listbox", { name: "Game server" })).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["Primary admin✓", "Events viewer"]);
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  expect(switcher).toHaveAttribute("aria-activedescendant", options[0].id);
  fireEvent.keyDown(switcher, { key: "ArrowDown" });
  expect(switcher).toHaveAttribute("aria-activedescendant", options[1].id);
  // Highlighting a server is not a switch.
  expect(router.state.location.search).toBe("?server=primary");
  expect(eventReads()).toHaveLength(0);
  fireEvent.keyDown(switcher, { key: "Escape" });
  expect(switcher).toHaveAttribute("aria-expanded", "false");
  expect(router.state.location.search).toBe("?server=primary");
  fireEvent.keyDown(switcher, { key: "ArrowDown" });
  fireEvent.keyDown(switcher, { key: "End" });
  fireEvent.keyDown(switcher, { key: "Tab" });
  expect(switcher).toHaveAttribute("aria-expanded", "false");
  expect(router.state.location.search).toBe("?server=primary");
  expect(eventReads()).toHaveLength(0);
  fireEvent.keyDown(switcher, { key: "ArrowDown" });
  fireEvent.keyDown(switcher, { key: "ArrowDown" });
  fireEvent.keyDown(switcher, { key: "Enter" });
  await waitFor(() => expect(router.state.location.search).toBe("?server=event"));
  await screen.findByText("Events player");
  expect(screen.getByRole("combobox", { name: "Game server" })).toHaveTextContent("Events");
});
it("closes on an outside click and keeps the current server when it is chosen again", async () => {
  const { router } = mount("/players?server=primary");
  await screen.findByText("Primary player");
  const switcher = screen.getByRole("combobox", { name: "Game server" });
  fireEvent.click(switcher);
  expect(switcher).toHaveAttribute("aria-expanded", "true");
  fireEvent.pointerDown(document.body);
  expect(switcher).toHaveAttribute("aria-expanded", "false");
  switchServer("Primary");
  expect(screen.getByRole("combobox", { name: "Game server" })).toHaveAttribute("aria-expanded", "false");
  expect(router.state.location.search).toBe("?server=primary");
  expect(screen.getByText("Primary player")).toBeInTheDocument();
});
it("does not silently fall back when an unavailable server is in a deep link", async () => {
  const { fetcher } = mount("/players?server=missing");
  await screen.findByText("That server is unavailable or outside your staff access.");
  await waitFor(() => expect(fetcher.mock.calls).toHaveLength(2));
});
it("keeps map editing and voting links on the explicitly selected server", async () => {
  const { router } = mount("/match?server=primary", async (url) =>
    url.endsWith("/map-votes")
      ? json({ enabled: false, votes: [], serverId: "primary" })
      : url.endsWith("/settings")
        ? json({
            revision: "r1",
            fields: [],
            rotation: {
              mode: "Ordered",
              enabled: true,
              editable: true,
              entries: [],
              currentIndex: null,
              currentMap: "Harbor",
            },
          })
        : url.endsWith("/catalog")
          ? json({ maps: [], experiences: [], lightings: [] })
          : json(overview("Primary")),
  );
  const link = await screen.findByRole("link", { name: "Voting controls & history →" });
  expect(link).toHaveAttribute("href", "/votes?server=primary");
  fireEvent.click(await screen.findByRole("button", { name: "Edit rotation" }));
  expect(screen.getByRole("button", { name: "Edit rotation" })).toHaveAttribute("aria-pressed", "true");
  expect(router.state.location.search).toBe("?server=primary");
});
