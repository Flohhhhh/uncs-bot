import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Audit } from "../../api/types";
import { AdminContext } from "../../app/context";
import { alice, context } from "../players/test-fixtures";
import { DashboardHistory } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const id = "7ab342f1-4200-4dfe-9050-5d7f2c310151";
const otherId = "9ef564a2-4300-4afc-8050-8f3e7c240362";
const older: Audit = {
  id,
  actorName: "Earlier staff",
  action: "kick",
  target: "76561198000000001",
  details: { reason: "Old receipt reason" },
  state: "started",
  message: "Action started; result not yet recorded.",
  createdAt: "2026-08-01T00:00:00Z",
};
const recent: Audit[] = Array.from({ length: 100 }, (_value, index) => ({
  ...older,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  actorName: "Recent staff",
  details: { reason: "Recent action" },
}));
function mount(admin = context()) {
  return render(
    <MemoryRouter initialEntries={["/activity?server=primary&view=actions"]}>
      <AdminContext.Provider value={admin}>
        <DashboardHistory />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}
function search(value: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
}
beforeEach(() => {
  request.mockReset();
});

describe("stored action receipt recovery", () => {
  it("finds a complete UUID beyond the latest100 and returns to recent history", async () => {
    request.mockImplementation(async (path) => (path === "audit" ? recent : { record: older }));
    mount();
    await screen.findByText("LAST 100");
    await waitFor(() => expect(screen.getAllByText("Recent staff")).toHaveLength(100));
    expect(screen.queryByText("Earlier staff")).not.toBeInTheDocument();
    search(` ${id.toUpperCase()} `);
    expect(await screen.findByText("Earlier staff")).toBeInTheDocument();
    expect(screen.getByText("EXACT ID")).toBeInTheDocument();
    expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
    // The looked-up receipt opens with its action ID showing.
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(id)).toBeVisible();
    expect(request).toHaveBeenCalledWith(`audit/${id}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/does not resend the action or recheck the game/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to recent actions" }));
    await waitFor(() => expect(screen.getAllByText("Recent staff")).toHaveLength(100));
    expect(screen.queryByText("Earlier staff")).not.toBeInTheDocument();
    expect(request.mock.calls.every(([path, options]) => path.startsWith("audit") && !options?.body)).toBe(true);
  });
  it("keeps partial IDs as a recent-history filter without querying an arbitrary path", async () => {
    request.mockResolvedValue(recent);
    mount();
    await screen.findAllByText("Recent staff");
    search("  00000000-0000  ");
    expect(screen.getAllByText("Recent staff")).toHaveLength(100);
    expect(request).toHaveBeenCalledTimes(1);
    search("../actions");
    expect(screen.getByText("No matching staff actions")).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("distinguishes no stored receipt from a failed lookup without treating absence as no game action", async () => {
    request
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ record: null })
      .mockRejectedValueOnce(new Error("The action receipt could not be loaded."));
    mount();
    await screen.findByText("No recorded staff actions");
    search(id);
    expect(await screen.findByText("No stored receipt for this action ID")).toBeInTheDocument();
    expect(screen.getByText(/does not establish whether the game acted/)).toBeInTheDocument();
    search(otherId);
    expect(await screen.findByText("Action receipt could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText("No stored receipt for this action ID")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The action receipt could not be loaded.");
  });
  it("discards a late result when staff paste a different action ID", async () => {
    let release!: (value: unknown) => void;
    request
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ record: { ...older, id: otherId, actorName: "Selected staff" } });
    mount();
    await screen.findByText("No recorded staff actions");
    search(id);
    expect(screen.getByText("Looking up action receipt…")).toBeInTheDocument();
    search(otherId);
    await screen.findByText("Selected staff");
    await act(async () => release({ record: older }));
    expect(screen.queryByText("Earlier staff")).not.toBeInTheDocument();
    expect(screen.getByText(otherId)).toBeInTheDocument();
  });
  it("allows exact lookup even when the recent-history read failed", async () => {
    request.mockRejectedValueOnce(new Error("Recent history unavailable")).mockResolvedValueOnce({ record: older });
    mount();
    await screen.findByText("Action history could not be loaded");
    search(id);
    expect(await screen.findByText("Earlier staff")).toBeInTheDocument();
    expect(screen.queryByText("Recent history unavailable")).not.toBeInTheDocument();
  });
  it("uses one outcome wording, names roster players beside their SteamID, and keeps the action ID in a details row", async () => {
    const entries: Audit[] = [
      { ...older, id: otherId, actorName: "Mod", state: "accepted", target: alice.steamId },
      {
        ...older,
        actorName: "Admin",
        action: "broadcast",
        target: "server",
        state: "applied",
        message: "Sent",
        details: { reason: "Staff action: Send announcement.", message: "GG all" } as Audit["details"],
      },
    ];
    request.mockResolvedValue(entries);
    mount();
    const accepted = (await screen.findByText("Mod")).closest("tr")!;
    expect(within(accepted).getByText("Accepted · not verified")).toBeInTheDocument();
    expect(within(accepted).getByRole("button", { name: alice.name })).toBeInTheDocument();
    expect(within(accepted).getByText(alice.steamId)).toBeInTheDocument();
    expect(within(accepted).queryByText(otherId)).not.toBeInTheDocument();
    const toggle = within(accepted).getByRole("button", { name: "Details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(details).toBeVisible();
    expect(within(details).getByText(otherId)).toBeInTheDocument();
    const broadcast = screen.getByText("Admin").closest("tr")!;
    expect(within(broadcast).getByText("Applied")).toBeInTheDocument();
    fireEvent.click(within(broadcast).getByRole("button", { name: "Details" }));
    expect(screen.getByText("GG all")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unc alice" } });
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
    expect(screen.getByText("Mod")).toBeInTheDocument();
  });
  it("opens the player panel from a target name without reading anything else", async () => {
    request.mockResolvedValue([{ ...older, target: alice.steamId }]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: alice.name }));
    const panel = screen.getByRole("dialog");
    expect(within(panel).getByRole("link", { name: "Combat history →" })).toHaveAttribute(
      "href",
      `/activity?server=primary&view=combat&player=${alice.steamId}`,
    );
    expect(request.mock.calls.every(([path, options]) => path === "audit" && !options?.method)).toBe(true);
  });
});
