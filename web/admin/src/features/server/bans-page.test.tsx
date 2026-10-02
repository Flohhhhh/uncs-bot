import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { alice, context } from "../players/test-fixtures";
import { BansPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
beforeEach(() => {
  request.mockReset();
});
function mount(admin = context()) {
  return render(
    <MemoryRouter initialEntries={["/bans?server=primary"]}>
      <AdminContext.Provider value={admin}>
        <BansPage />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

it("keeps every ban visible, filters and sorts locally, and disables removal only for invalid IDs", async () => {
  const valid = "76561198000000001",
    invalid = "76561197960265728";
  request.mockResolvedValue([
    { steamId: invalid, bannedBy: "config", bannedAtUtc: "0001-01-01T00:00:00.000Z" },
    { steamId: valid, reason: "Existing ban", bannedBy: "Staff" },
  ]);
  const admin = context();
  mount(admin);
  await screen.findByText("2 server bans");
  expect(screen.getByText(/1 ban entry has an invalid SteamID/)).toBeInTheDocument();
  const invalidRow = screen.getByText(invalid).closest("tr")!;
  expect(within(invalidRow).getByRole("button", { name: "Remove ban" })).toBeDisabled();
  expect(within(invalidRow).getByText("Invalid SteamID")).toBeInTheDocument();
  expect(within(invalidRow).getByText("Date not provided")).toBeInTheDocument();
  const validRow = screen.getByText(valid).closest("tr")!;
  expect(within(validRow).getByRole("button", { name: "Remove ban" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Sort by SteamID64" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  Existing ban  " } });
  expect(screen.queryByText(invalid)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove ban" }));
  expect(admin.openAction).toHaveBeenCalledWith("unban", valid);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]?.method).toBeUndefined();
});

it("uses the singular for one ban", async () => {
  request.mockResolvedValue([{ steamId: "76561198000000001", reason: "Existing ban", bannedBy: "Staff" }]);
  mount();
  expect(await screen.findByText("1 server ban")).toBeInTheDocument();
});

it("offers connected players first and keeps a SteamID entry for offline bans", async () => {
  request.mockResolvedValue([]);
  const admin = context();
  mount(admin);
  fireEvent.click(await screen.findByRole("button", { name: "+ Ban player" }));
  const picker = screen.getByRole("dialog", { name: "Ban player" });
  const players = within(picker).getByRole("list", { name: "Connected players" });
  expect(within(players).getAllByRole("button")).toHaveLength(3);
  fireEvent.change(within(picker).getByRole("searchbox"), { target: { value: "alice" } });
  // Picking chooses the target only; the ban review is still the one confirmation.
  fireEvent.click(within(picker).getByRole("button", { name: new RegExp(alice.name) }));
  expect(admin.openAction).toHaveBeenCalledWith("ban", alice.steamId);
  expect(screen.queryByRole("dialog", { name: "Ban player" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+ Ban player" }));
  fireEvent.click(screen.getByRole("button", { name: "Enter a SteamID" }));
  expect(admin.openAction).toHaveBeenLastCalledWith("ban", undefined);
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("keeps the ban picker closed while the roster needs a fresh check", async () => {
  request.mockResolvedValue([]);
  mount(context({ stale: true }));
  expect(await screen.findByRole("button", { name: "+ Ban player" })).toBeDisabled();
});
