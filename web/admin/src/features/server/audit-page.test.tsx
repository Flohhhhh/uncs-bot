import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Audit } from "../../api/types";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { AuditPage } from "./pages";

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
function mount() {
  return render(
    <AdminContext.Provider value={context()}>
      <AuditPage />
    </AdminContext.Provider>,
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
    search("00000000-0000");
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
    await screen.findByText("No matching staff actions");
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
    await screen.findByText("No matching staff actions");
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
});
