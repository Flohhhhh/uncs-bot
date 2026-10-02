import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { WhitelistPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
beforeEach(() => request.mockReset());

it("shows valid saved status and a config warning without blocking supported live-list actions", async () => {
  request.mockResolvedValue({
    entries: [{ steamId: "76561198000000001", active: true, configured: true }],
    configurationAvailable: true,
    invalidEntryCount: 3,
    configuredInvalidEntryCount: 3,
  });
  render(
    <AdminContext.Provider value={context()}>
      <WhitelistPage />
    </AdminContext.Provider>,
  );
  await screen.findByText("1 active entries");
  expect(screen.getByText("Invalid SteamIDs: 3 in the running game; 3 in saved configuration.")).toBeInTheDocument();
  expect(screen.queryByText(/saved configuration could not be checked/)).not.toBeInTheDocument();
  const row = screen.getByText("76561198000000001").closest("tr")!;
  expect(within(row).getByText("Saved")).toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "Remove" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "+ Add player" })).toBeEnabled();
  expect(request).toHaveBeenCalledTimes(1);
});
