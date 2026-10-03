import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context, overview } from "../players/test-fixtures";
import { MatchPage } from "./match-page";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const rotation = { enabled: true, mode: "Ordered", entries: [{ index: 0, map: "Saved map", status: "now" }] };
const settings = {
  revision: "r1",
  writable: true,
  fields: [],
  notice: "",
  scoreTick: null,
  rotation: {
    ...rotation,
    editable: true,
    currentIndex: 0,
    currentMap: "Kavkazi",
    entries: [
      { map: "Kavkazi", experiences: [] },
      { map: "Europe", experiences: [] },
    ],
  },
};
let search = "";
function Location() {
  search = useLocation().search;
  return null;
}
function adminPage(state: ReturnType<typeof context>, version = 0, path = "/match?server=primary") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <AdminContext.Provider value={{ ...state, refreshVersion: version }}>
        <MatchPage />
        <Location />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
function matchRead(path: string) {
  if (path === "settings") return settings;
  if (path === "map-votes") return { enabled: false, serverId: "primary", votes: [] };
  if (path === "settings/rotation-check") return { revision: "r1", issues: [], total: 2 };
  if (path === "catalog") return { maps: [{ id: "Kavkazi" }, { id: "Europe" }], lightings: [], experiences: [] };
  if (path === "events") return { enabled: true, serverId: "primary", events: [] };
  if (path === "overview") return overview();
  throw new Error(`Unexpected path: ${path}`);
}
function page(version = 0, path = "/match") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <AdminContext.Provider
        value={{ ...context(), me: { ...context().me, role: "moderator" }, refreshVersion: version }}
      >
        <MatchPage />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  request.mockReset();
  search = "";
});
it("shows the current-match controls in plain view and only opens a separate action review", async () => {
  request.mockImplementation(
    async (path) =>
      (path === "map-votes"
        ? { enabled: false, votes: [] }
        : path === "settings"
          ? {
              revision: "r1",
              writable: true,
              fields: [],
              rotation: { ...rotation, editable: true, entries: [], currentIndex: null, currentMap: "Harbor" },
            }
          : { maps: [], experiences: [], lightings: [] }) as never,
  );
  const admin = context();
  render(adminPage(admin));
  const controls = screen.getByRole("group", { name: "Match controls" });
  for (const name of ["Set lighting", "Change map", "End match", "Restart match"])
    expect(within(controls).getByRole("button", { name })).toBeVisible();
  expect(document.querySelector("details")).toBeNull();
  expect(screen.queryByText(/affect everyone playing/)).not.toBeInTheDocument();
  expect(screen.queryByText(/hosting panel/)).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Queue next map" })).toBeInTheDocument();
  fireEvent.click(within(controls).getByRole("button", { name: "Restart match" }));
  expect(admin.openAction).toHaveBeenCalledWith("match-restart", undefined);
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it("summarizes the current match, the saved next round and an open vote", async () => {
  const closesAt = "2026-10-02T16:52:00Z";
  request.mockImplementation(async (path) => {
    if (path === "map-votes")
      return {
        enabled: true,
        serverId: "primary",
        votes: [{ id: "vote", state: "open", choices: [], counts: [], closesAt, automation: null }],
      } as never;
    if (path === "settings") {
      const snapshot = structuredClone(settings);
      snapshot.rotation.entries[1] = {
        map: "Europe",
        experiences: ["KOTH"],
        zoneAlternator: "ZoneAlternator.Ozeti.Farmland.Circle",
        lighting: "DayClear",
      } as never;
      return snapshot as never;
    }
    return matchRead(path) as never;
  });
  const state = context();
  Object.assign(state.overview!.status, {
    map: "Bakurani",
    experiences: ["KOTH"],
    alternator: "ZoneAlternator.Bakurani.Farmland.Circle",
    lighting: "DayClear",
    matchSeconds: 612,
  });
  render(adminPage(state));
  const summary = within(screen.getByRole("region", { name: "Current match" }));
  expect(summary.getByText("Bakurani · King of the Hill · Farmland · Day clear")).toBeInTheDocument();
  const checked = new Date(state.overview!.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(summary.getByText(`10:12 elapsed · checked ${checked}`)).toBeInTheDocument();
  expect(await summary.findByText("Ozeti · King of the Hill · Farmland · Day clear")).toBeInTheDocument();
  expect(summary.getByText("Saved next round")).toBeInTheDocument();
  const ends = new Date(closesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(await summary.findByText(`Open · ends ${ends}`)).toBeInTheDocument();
  expect(summary.getAllByText(/Bakurani/)).toHaveLength(1);
});
it("shows no round clock without one and does not name an unconfirmed next round", async () => {
  request.mockImplementation(async (path) => {
    if (path === "settings") return { ...settings, rotation: { ...settings.rotation, currentMap: "Europe" } } as never;
    return matchRead(path) as never;
  });
  const state = context();
  delete state.overview!.status.matchSeconds;
  render(adminPage(state));
  const summary = within(screen.getByRole("region", { name: "Current match" }));
  expect(await summary.findByText("Not confirmed")).toBeInTheDocument();
  expect(summary.queryByText(/elapsed/)).not.toBeInTheDocument();
  expect(summary.queryByText("Saved next round")).not.toBeInTheDocument();
  expect(await summary.findByText("Off")).toBeInTheDocument();
});
it("keeps the view in the URL with the selected server and offers voting and events only to administrators", async () => {
  request.mockImplementation(async (path) =>
    path === "map-votes/controls"
      ? ({ serverId: "primary", version: 0, available: true, ready: false, message: "Voting is off." } as never)
      : (matchRead(path) as never),
  );
  render(adminPage(context(), 0, "/match?server=primary&view=voting"));
  expect(screen.getByRole("tab", { name: "Voting" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByRole("heading", { name: "Discord map voting is off" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Match & maps|Voting controls/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Rotation" }));
  expect(search).toBe("?server=primary&view=rotation");
  expect(await screen.findByRole("list", { name: "Rotation queue" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Discord map voting is off" })).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it("shows other staff the running rotation's next round without tabs or private reads", async () => {
  request.mockResolvedValue({
    ...rotation,
    entries: [
      { index: 0, map: "Saved map", status: null },
      { index: 1, map: "Harbor", status: "now" },
      { index: 2, map: "Europe", lighting: "DayClear", status: "next" },
    ],
  } as never);
  render(page(0, "/match?server=primary&view=voting"));
  const summary = within(screen.getByRole("region", { name: "Current match" }));
  expect(await summary.findByText("Ozeti · Day clear")).toBeInTheDocument();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(request.mock.calls.map(([path]) => path)).toEqual(["rotation"]);
});
it("does not call the rotation unavailable while its first read is pending", async () => {
  let done!: (value: unknown) => void;
  request.mockReturnValue(
    new Promise((resolve) => {
      done = resolve;
    }),
  );
  render(page());
  expect(screen.getByText("Loading rotation…")).toBeInTheDocument();
  expect(screen.queryByText("Rotation is unavailable")).not.toBeInTheDocument();
  await act(async () => done(rotation));
  expect(screen.getByText("Saved map")).toBeInTheDocument();
});
it("hides an old next-map list when refreshing it fails and distinguishes an empty rotation", async () => {
  request
    .mockResolvedValueOnce(rotation)
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValueOnce({ ...rotation, entries: [] });
  const view = render(page());
  await screen.findByText("Saved map");
  view.rerender(page(1));
  await screen.findByText("Rotation could not be loaded");
  expect(screen.queryByText("Saved map")).not.toBeInTheDocument();
  view.rerender(page(2));
  await screen.findByText("No maps in the saved rotation");
  expect(screen.queryByText("Rotation could not be loaded")).not.toBeInTheDocument();
});

it("recovers the administrator's first map-controls read without a page reload or game action", async () => {
  let failed = true;
  request.mockImplementation(async (path) => {
    if (path === "settings" && failed) throw new Error("Settings read failed");
    return matchRead(path) as never;
  });
  render(adminPage(context()));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings read failed");
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry map controls" }));
  expect(await screen.findByRole("button", { name: "Queue next map" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("explains a failed map refresh and keeps the rotation draft locked until retry succeeds", async () => {
  request.mockImplementation(async (path) => matchRead(path) as never);
  const state = context();
  const view = render(adminPage(state));
  fireEvent.click(await screen.findByRole("tab", { name: "Rotation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move Ozeti up" }));
  expect(screen.getByRole("button", { name: "Review rotation" })).toBeEnabled();
  request.mockImplementation(async (path) => {
    if (path === "settings") throw new Error("Settings read failed");
    return matchRead(path) as never;
  });
  view.rerender(adminPage(state, 1));
  expect(await screen.findByRole("alert")).toHaveTextContent(/last successful check/i);
  expect(screen.getByRole("button", { name: "Review rotation" })).toBeDisabled();
  let finish!: (value: unknown) => void;
  request.mockImplementation(
    async (path) =>
      (path === "settings"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : matchRead(path)) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry map controls" }));
  expect(screen.getByRole("button", { name: "Retry map controls" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Settings read failed");
  expect(screen.getByRole("button", { name: "Review rotation" })).toBeDisabled();
  await act(async () => finish(settings));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  expect(within(screen.getByRole("dialog")).getAllByRole("listitem")[0]).toHaveTextContent("Ozeti");
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("retains hidden rotation drafts and does not clear their warning when another view's draft is discarded", async () => {
  request.mockImplementation(async (path) => matchRead(path) as never);
  const state = context();
  render(adminPage(state, 0, "/match?server=primary&view=rotation"));
  fireEvent.click(await screen.findByRole("button", { name: "Move Ozeti up" }));
  await waitFor(() => expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("tab", { name: "Events" }));
  expect(search).toBe("?server=primary&view=events");
  const duration = await screen.findByRole("spinbutton", { name: "Duration (minutes)" });
  await waitFor(() => expect(duration).toBeEnabled());
  fireEvent.change(duration, { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByRole("spinbutton", { name: "Duration (minutes)" })).toHaveValue(60);
  expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("tab", { name: "Rotation" }));
  const queue = screen.getByRole("list", { name: "Rotation queue" });
  expect(within(queue).getAllByRole("listitem")[0]).toHaveTextContent("Ozeti");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await waitFor(() => expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(false));
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
