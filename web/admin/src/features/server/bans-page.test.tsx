import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { BansPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
// Braces keep the hook from returning the mock, which Vitest would then call as a teardown.
beforeEach(() => {
  request.mockReset();
});

it("keeps every ban visible, filters and sorts locally, and disables removal only for invalid IDs", async () => {
  const valid = "76561198000000001",
    invalid = "76561197960265728";
  request.mockResolvedValue([
    { steamId: invalid, bannedBy: "config", bannedAtUtc: "0001-01-01T00:00:00.000Z" },
    { steamId: valid, reason: "Existing ban", bannedBy: "Staff" },
  ]);
  const admin = context();
  render(
    <AdminContext.Provider value={admin}>
      <BansPage />
    </AdminContext.Provider>,
  );
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

it("announces a failed ban read without announcing the read while it loads", async () => {
  request.mockRejectedValue(new Error("The game server did not respond."));
  render(
    <AdminContext.Provider value={context()}>
      <BansPage />
    </AdminContext.Provider>,
  );
  expect(screen.getByText("Loading bans…").closest("[role=alert]")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("Bans could not be loaded");
});
