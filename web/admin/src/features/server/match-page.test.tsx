import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { MatchPage } from "./pages";

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
function adminPage(state: ReturnType<typeof context>, version = 0) {
  return (
    <MemoryRouter>
      <AdminContext.Provider value={{ ...state, refreshVersion: version }}>
        <MatchPage />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
function matchRead(path: string) {
  if (path === "settings") return settings;
  if (path === "map-votes") return { enabled: false, votes: [] };
  if (path === "settings/rotation-check") return { revision: "r1", issues: [], total: 2 };
  if (path === "catalog") return { maps: [{ id: "Kavkazi" }, { id: "Europe" }], lightings: [], experiences: [] };
  throw new Error(`Unexpected path: ${path}`);
}
function page(version = 0) {
  return (
    <MemoryRouter>
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
});
it("keeps disruptive controls collapsed and only opens a separate action review", async () => {
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
  render(
    <MemoryRouter>
      <AdminContext.Provider value={admin}>
        <MatchPage />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
  const summary = screen.getByText("Change, end or restart the current match");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  expect(await screen.findByRole("button", { name: "Edit rotation" })).toBeInTheDocument();
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "Restart match" }));
  expect(admin.openAction).toHaveBeenCalledWith("match-restart", undefined);
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
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
  expect(await screen.findByRole("button", { name: "Edit rotation" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("explains a failed map refresh and keeps the rotation draft locked until retry succeeds", async () => {
  request.mockImplementation(async (path) => matchRead(path) as never);
  const state = context();
  const view = render(adminPage(state));
  fireEvent.click(await screen.findByRole("button", { name: "Edit rotation" }));
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
