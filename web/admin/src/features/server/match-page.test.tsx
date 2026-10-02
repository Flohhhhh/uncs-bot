import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { MatchPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const rotation = { enabled: true, mode: "Ordered", entries: [{ index: 0, map: "Saved map", status: "now" }] };
function page(version = 0) {
  return (
    <MemoryRouter>
      <AdminContext.Provider value={{ ...context(), refreshVersion: version }}>
        <MatchPage />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  request.mockReset();
});
it("keeps disruptive controls collapsed and only opens a separate action review", async () => {
  request.mockResolvedValue(rotation);
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
  expect(screen.getByRole("link", { name: "Edit rotation & queue next map →" })).toBeInTheDocument();
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
