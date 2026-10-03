import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { alice, context } from "../players/test-fixtures";
import { WhitelistPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
// Braces keep the hook from returning the mock, which Vitest would then call as a teardown.
beforeEach(() => {
  request.mockReset();
});
function mount(admin = context()) {
  return render(
    <MemoryRouter initialEntries={["/whitelist?server=primary"]}>
      <AdminContext.Provider value={admin}>
        <WhitelistPage />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}
function row(steamId: string) {
  return screen.getByText(steamId).closest("tr")!;
}

it("shows valid saved status and a config warning without blocking supported live-list actions", async () => {
  request.mockResolvedValue({
    entries: [{ steamId: "76561198000000001", active: true, configured: true }],
    configurationAvailable: true,
    invalidEntryCount: 3,
    configuredInvalidEntryCount: 3,
  });
  const admin = context();
  mount(admin);
  await screen.findByText("1 active entry");
  expect(screen.getByText("Invalid SteamIDs: 3 in the running game; 3 in saved configuration.")).toBeInTheDocument();
  expect(screen.queryByText(/saved configuration could not be checked/)).not.toBeInTheDocument();
  const entry = row("76561198000000001");
  expect(within(entry).getByText("Active")).toBeInTheDocument();
  // A quiet row button; the removal review itself carries the warning.
  const remove = within(entry).getByRole("button", { name: "Remove" });
  expect(remove).toBeEnabled();
  expect(remove).not.toHaveClass("danger");
  fireEvent.click(remove);
  expect(admin.openAction).toHaveBeenCalledWith("whitelist-remove", "76561198000000001");
  expect(screen.getByRole("button", { name: "+ Add player" })).toBeEnabled();
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps running and saved state apart in one status column and names online players", async () => {
  const offline = "76561198000000009";
  const removed = "76561198000000008";
  request.mockResolvedValue({
    entries: [
      { steamId: alice.steamId, active: true, configured: true },
      { steamId: offline, active: false, configured: true },
      { steamId: removed, active: true, configured: false },
    ],
    configurationAvailable: true,
    invalidEntryCount: 0,
  });
  mount();
  await screen.findByText("2 active entries");
  expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Player↕",
    "Status↕",
    "Actions",
  ]);
  const online = row(alice.steamId);
  expect(within(online).getByRole("button", { name: alice.name })).toBeInTheDocument();
  expect(within(online).getByText("Active")).toHaveClass("good");
  const pending = row(offline);
  expect(within(pending).queryByRole("button", { name: /UNC/ })).not.toBeInTheDocument();
  expect(within(pending).getByText("Addition pending")).toHaveClass("warn");
  expect(within(pending).getByText("Saved, not in the running game yet")).toBeInTheDocument();
  const removal = row(removed);
  expect(within(removal).getByText("Removal pending")).toHaveClass("warn");
  expect(within(removal).getByText("In the running game, not in the saved list")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unc alice" } });
  expect(screen.queryByText(offline)).not.toBeInTheDocument();
  expect(screen.getByText(alice.steamId)).toBeInTheDocument();
});

it("never treats an unavailable saved list as a removal", async () => {
  request.mockResolvedValue({
    entries: [{ steamId: "76561198000000009", active: true, configured: null }],
    configurationAvailable: false,
    invalidEntryCount: 0,
  });
  mount();
  await screen.findByText("1 active entry");
  expect(screen.getByText(/saved configuration could not be checked/)).toBeInTheDocument();
  const entry = row("76561198000000009");
  expect(within(entry).getByText("Active")).toBeInTheDocument();
  expect(within(entry).getByText("Saved configuration unavailable")).toBeInTheDocument();
  expect(within(entry).queryByText(/pending/)).not.toBeInTheDocument();
});

it("shows a failed read as unavailable rather than as an empty whitelist", async () => {
  request.mockRejectedValue(new Error("Whitelist unavailable"));
  mount();
  expect(await screen.findByText("Whitelist could not be loaded")).toBeInTheDocument();
  expect(screen.queryByText("No player entries available")).not.toBeInTheDocument();
});

it("announces a failed whitelist read without announcing the read while it loads", async () => {
  request.mockRejectedValue(new Error("The game server did not respond."));
  mount();
  expect(screen.getByText("Loading whitelist…").closest("[role=alert]")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("Whitelist could not be loaded");
});
