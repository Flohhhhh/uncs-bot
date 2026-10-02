import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AdminContext } from "../../app/context";
import { api } from "../../api/client";
import { context } from "../players/test-fixtures";
import { AuditPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const log = {
  available: true,
  observedAt: "2026-10-01T22:00:00Z",
  limit: 100,
  entries: [
    {
      timestamp: "2026-10-01T22:00:00Z",
      event: "HTTP",
      operation: "POST /v1/broadcast",
      statusCode: 200,
      changesState: true,
    },
    { timestamp: null, event: "AUTH_OK", operation: null, statusCode: null, changesState: false },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async (path) => (path === "game-log" ? (structuredClone(log) as never) : ([] as never)));
});
function show(role: "admin" | "viewer" = "admin") {
  const state = context();
  state.me.role = role;
  return render(
    <AdminContext.Provider value={state}>
      <AuditPage />
    </AdminContext.Provider>,
  );
}
it("reads the game log only when selected and separates commands from connections", async () => {
  show();
  await screen.findByText("No recorded staff actions");
  expect(request.mock.calls.some(([path]) => path === "game-log")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Game command log" }));
  await screen.findByText("POST /v1/broadcast");
  expect(screen.queryByText("AUTH_OK")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Include reads and connections" }));
  expect(screen.getByText("AUTH_OK")).toBeInTheDocument();
  expect(screen.getByText(/not that a change took effect/)).toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});
it("does not expose or read the game log for viewers", async () => {
  show("viewer");
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Game command log" })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([path]) => path === "game-log")).toBe(false);
});
it("distinguishes an unsupported log from a failed request", async () => {
  request.mockResolvedValue({ ...log, available: false, entries: [] } as never);
  // Start with the component's normal empty dashboard history.
  request.mockResolvedValueOnce([] as never);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Game command log" }));
  await screen.findByText("This game build does not provide the command log");
  request.mockRejectedValueOnce(new Error("Game connection unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh game log" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Game connection unavailable");
});
