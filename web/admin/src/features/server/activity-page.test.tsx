import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { ActivityFeed } from "./activity-page";
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const event = {
  id: "join",
  observedAt: "2026-10-02T04:00:00Z",
  category: "players",
  message: "Alice joined",
  steamId: "76561198000000001",
};
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(
    async (path) =>
      (path === "activity"
        ? { events: [event], limit: 300, connection: "available", startedAt: event.observedAt }
        : path === "audit"
          ? [
              {
                id: "receipt",
                actorName: "Mod",
                action: "ban",
                target: "76561198000000001",
                state: "failed",
                message: "Ban refused",
                createdAt: event.observedAt,
                details: { reason: "Reviewed" },
              },
            ]
          : { enabled: true, feedStatus: "waiting", events: [] }) as never,
  );
});
it("combines observations and actual action outcomes while the native feed is still waiting", async () => {
  render(
    <AdminContext.Provider value={context()}>
      <ActivityFeed />
    </AdminContext.Provider>,
  );
  await screen.findByText("Alice joined");
  expect(screen.getByText(/Mod · Ban player · failed/)).toBeInTheDocument();
  expect(screen.getByText("Awaiting first combat batch")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Activity type" }), { target: { value: "players" } });
  expect(screen.queryByText(/Mod · Ban/)).not.toBeInTheDocument();
  expect(screen.getByText("Alice joined")).toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it("keeps working sources visible when another source fails", async () => {
  const fallback = request.getMockImplementation()!;
  request.mockImplementation((path, options) =>
    path === "audit" ? Promise.reject(new Error("Unavailable")) : fallback(path, options),
  );
  render(
    <AdminContext.Provider value={context()}>
      <ActivityFeed />
    </AdminContext.Provider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Action receipts");
  expect(screen.getByText("Alice joined")).toBeInTheDocument();
});
it("freezes the display for reading and resumes with newer observations", async () => {
  const view = (refreshVersion: number) => (
    <AdminContext.Provider value={context({ refreshVersion })}>
      <ActivityFeed />
    </AdminContext.Provider>
  );
  const rendered = render(view(0));
  await screen.findByText("Alice joined");
  fireEvent.click(screen.getByRole("button", { name: "Pause display" }));
  const fallback = request.getMockImplementation()!;
  request.mockImplementation((path, options) =>
    path === "activity"
      ? Promise.resolve({
          events: [event, { ...event, id: "left", message: "Alice left" }],
          connection: "available",
        } as never)
      : fallback(path, options),
  );
  rendered.rerender(view(1));
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "activity")).toHaveLength(2));
  expect(screen.queryByText("Alice left")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume display" }));
  expect(await screen.findByText("Alice left")).toBeInTheDocument();
});
