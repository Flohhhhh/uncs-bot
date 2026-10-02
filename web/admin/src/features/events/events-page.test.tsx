import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { EventsPage } from "./events-page";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context, overview } from "../players/test-fixtures";
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const event = {
  id: "d0a3cdd7-a1c7-4904-a99e-cf058b432c34",
  serverId: "primary",
  serverName: "Test UNCs",
  actorName: "Admin",
  reason: "Staff requested event start.",
  options: {
    teams: ["Valkyra", "Lonestar"],
    durationMinutes: 60,
    warningSeconds: 30,
    balanceWindowSeconds: 300,
    forceRespawn: false,
  },
  state: "active",
  message: "Watching teams",
  version: 1,
  originalLock: true,
  lockChanged: true,
  lastActionId: null,
  operation: null,
  movedThisRound: 0,
  stop: null as null | { actorName: string; reason: string },
  createdAt: "2026-10-01T10:00:00Z",
  endsAt: "2026-10-01T11:00:00Z",
};
let events: Array<typeof event>, enabled: boolean, revision: string, matchSeconds: number | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  enabled = true;
  revision = "r1";
  matchSeconds = 120;
  request.mockImplementation(async (path, init) => {
    if (init?.method === "POST") return { ...event, message: "Event request recorded" } as never;
    if (path === "events") return { enabled, events, serverId: "primary" } as never;
    if (path === "settings")
      return { revision, fields: [{ id: "lockOverpopulated", value: true, editable: true }] } as never;
    if (path === "overview") {
      const value = overview();
      value.status.matchSeconds = matchSeconds;
      value.status.factionScores.push({ name: "Manticore", colorHex: "#7BC462", score: 10 });
      return value as never;
    }
    if (path.endsWith("/operations")) return { operations: [] } as never;
    throw new Error(`Unexpected ${path}`);
  });
});
function show(role: "admin" | "viewer" | "moderator" = "admin") {
  const state = context();
  state.me.role = role;
  const view = render(
    <AdminContext.Provider value={state}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  return { ...view, state };
}
async function selectTeams() {
  const first = await screen.findByRole("combobox", { name: "Team 1" });
  await waitFor(() => expect(first).toBeEnabled());
  fireEvent.change(first, { target: { value: "Valkyra" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Team 2" }), { target: { value: "Lonestar" } });
}
it.each(["viewer", "moderator"] as const)("does not query private event records for %s", (role) => {
  show(role);
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
it("does not read game settings or players while disabled", async () => {
  enabled = false;
  show();
  await screen.findByText("Optional events are not enabled");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["events"]);
});
it("defaults to no forced respawns and requires two different teams", async () => {
  show();
  const checkbox = await screen.findByRole("checkbox", { name: /Force a respawn/ });
  expect(checkbox).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Review event" })).toBeDisabled();
  await selectTeams();
  expect(screen.getByRole("button", { name: "Review event" })).toBeEnabled();
  expect(
    within(screen.getByRole("combobox", { name: "Team 2" })).queryByRole("option", { name: "Valkyra" }),
  ).not.toBeInTheDocument();
});
it("explains missing round timing before review and keeps the draft when timing is checked again", async () => {
  matchSeconds = undefined;
  show();
  await selectTeams();
  await screen.findByText(/Round timing is unavailable/);
  expect(screen.getByRole("button", { name: "Review event" })).toBeDisabled();
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  matchSeconds = 125;
  fireEvent.click(screen.getByRole("button", { name: "Check round timing" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Review event" })).toBeEnabled());
  expect(screen.getByRole("combobox", { name: "Team 1" })).toHaveValue("Valkyra");
  expect(screen.getByRole("combobox", { name: "Team 2" })).toHaveValue("Lonestar");
});
it("rechecks round timing when opening a start review and blocks a missing clock without a POST", async () => {
  show();
  await selectTeams();
  matchSeconds = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Review event" }));
  await screen.findByText(/Round timing is unavailable/);
  const submit = screen.getByRole("button", { name: "Arm event" });
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  matchSeconds = 125;
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Check round timing" }));
  await waitFor(() => expect(submit).toBeEnabled());
  expect(within(screen.getByRole("dialog")).queryByRole("textbox")).not.toBeInTheDocument();
});
it("reviews a frozen start request without typing and waits for the separate confirmation button", async () => {
  const { state } = show();
  await selectTeams();
  expect(state.setUnsavedChanges).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Review event" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("Buying stays available");
  expect(dialog).toHaveTextContent("off — a normal respawn may be needed");
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  const submit = within(dialog).getByRole("button", { name: "Arm event" });
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  fireEvent.click(submit);
  await screen.findByText("Event request recorded");
  const posts = request.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual({
    id: expect.any(String),
    serverId: "primary",
    revision: "r1",
    teams: ["Valkyra", "Lonestar"],
    durationMinutes: 60,
    warningSeconds: 30,
    balanceWindowSeconds: 300,
    forceRespawn: false,
    reason: "Staff requested event start.",
    confirm: "START 50V50",
  });
});
it("blocks submission while the review timing read is pending or failed and permits a read-only retry", async () => {
  show();
  await selectTeams();
  const fallback = request.getMockImplementation()!;
  let rejectTiming!: (error: Error) => void;
  request.mockImplementation((path, init) =>
    path === "overview"
      ? new Promise((_, reject) => {
          rejectTiming = reject;
        })
      : fallback(path, init),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review event" }));
  const dialog = within(screen.getByRole("dialog"));
  const submit = dialog.getByRole("button", { name: "Arm event" });
  expect(dialog.getByText("Checking round timing…")).toBeInTheDocument();
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  rejectTiming(new Error("Game status could not be read"));
  await dialog.findByText("Game status could not be read");
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  request.mockImplementation(fallback);
  fireEvent.click(dialog.getByRole("button", { name: "Check round timing" }));
  await waitFor(() => expect(submit).toBeEnabled());
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  fireEvent.click(dialog.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("combobox", { name: "Team 1" })).toHaveValue("Valkyra");
});
it("does not retry an uncertain start response", async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (init?.method === "POST") throw new Error("Connection lost");
    return original(path, init);
  });
  show();
  await selectTeams();
  fireEvent.click(screen.getByRole("button", { name: "Review event" }));
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Arm event" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Arm event" }));
  await screen.findByText(/Connection lost.*will not be sent again/);
  expect(screen.queryByRole("button", { name: "Arm event" })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("blocks stale settings until the draft is discarded and refreshed", async () => {
  const { state, rerender } = show();
  await selectTeams();
  revision = "r2";
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  await screen.findByText("Server settings changed. Discard this draft and refresh.");
  expect(screen.getByRole("button", { name: "Review event" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Team 1" })).toHaveValue(""));
});
it("keeps stop available without game reads while an event is active", async () => {
  events = [event];
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Stop event" }));
  expect(request.mock.calls.map(([path]) => path)).toEqual(["events"]);
  expect(screen.getByRole("dialog")).toHaveTextContent("cannot be recalled");
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
  await screen.findByText("Event request recorded");
  expect(request).toHaveBeenCalledWith(
    `events/${event.id}/stop`,
    expect.objectContaining({ method: "POST", body: expect.stringContaining("Staff requested event stop.") }),
  );
});
it("loads the current lock only for explicit restoration review", async () => {
  events = [{ ...event, state: "needs_review", stop: { actorName: "Admin", reason: "Stop" } }];
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Review restoration" }));
  await screen.findByText("Population lock: on → on.");
  expect(request.mock.calls.some(([path]) => path === "overview")).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("stop the affected Gramps instance");
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("dialog")).queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore reviewed lock" }));
  await screen.findByText("Event request recorded");
  const posts = request.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ revision: "r1", confirm: "RESTORE TEAM LOCK" });
});
it("opens and closes event receipts without reading the game", async () => {
  events = [event];
  show();
  fireEvent.click(await screen.findByRole("button", { name: "View actions" }));
  await screen.findByText("No actions recorded yet");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["events", `events/${event.id}/operations`]);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps an event draft but blocks starting it when event-history refresh fails, including an open review", async () => {
  const { state, rerender } = show();
  await selectTeams();
  fireEvent.click(screen.getByRole("button", { name: "Review event" }));
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (path === "events") throw new Error("Event history unavailable");
    return fallback(path, init);
  });
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  await screen.findByText("Refresh event history before continuing.");
  const submit = screen.getByRole("button", { name: "Arm event" });
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("button", { name: "Review event" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Team 1" })).toHaveValue("Valkyra");
  request.mockImplementation(fallback);
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 2 }}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Review event" })).toBeEnabled());
});

it("labels stale event records while retaining the stop control when history cannot refresh", async () => {
  events = [event];
  const { state, rerender } = show();
  await screen.findByText("Active");
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (path === "events") throw new Error("History unavailable");
    return fallback(path, init);
  });
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  await screen.findByText("Last known: Active");
  fireEvent.click(screen.getByRole("button", { name: "Stop event" }));
  expect(screen.getByRole("button", { name: "Confirm stop" })).toBeEnabled();
  expect(request.mock.calls.some(([path]) => path === "settings" || path === "overview")).toBe(false);
});

it.each(["initial", "previously disabled"])(
  "recovers a failed %s event-status read without assuming activation",
  async (phase) => {
    enabled = false;
    let fail = phase === "initial";
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (path, init) => {
      if (path === "events" && fail) throw new Error("History unavailable");
      return fallback(path, init);
    });
    const { state, rerender } = show();
    if (!fail) {
      await screen.findByText("Optional events are not enabled");
      fail = true;
      rerender(
        <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
          <EventsPage />
        </AdminContext.Provider>,
      );
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Event status could not be loaded");
    expect(screen.queryByText("Optional events are not enabled")).not.toBeInTheDocument();
    let resolveRead!: (data: never) => void;
    request.mockImplementation(() => new Promise((resolve) => (resolveRead = resolve)));
    const retry = screen.getByRole("button", { name: "Retry event status" });
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Event status could not be loaded");
    await act(async () => resolveRead({ enabled: false, serverId: "primary", events: [] } as never));
    await screen.findByText("Optional events are not enabled");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(request.mock.calls.every(([path, init]) => path === "events" && !init?.method)).toBe(true);
  },
);

it("retries failed draft settings without discarding selected teams", async () => {
  const { state, rerender } = show();
  await selectTeams();
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (path === "settings") throw new Error("Settings unavailable");
    return fallback(path, init);
  });
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  await screen.findByText("Settings unavailable");
  expect(screen.getByRole("button", { name: "Review event" })).toBeDisabled();
  request.mockImplementation(fallback);
  fireEvent.click(screen.getByRole("button", { name: "Retry server settings" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Review event" })).toBeEnabled());
  expect(screen.getByRole("combobox", { name: "Team 1" })).toHaveValue("Valkyra");
  expect(screen.getByRole("combobox", { name: "Team 2" })).toHaveValue("Lonestar");
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("retries the restoration settings read while keeping submission blocked until it succeeds", async () => {
  events = [{ ...event, state: "needs_review", stop: { actorName: "Admin", reason: "Stop" } }];
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (path === "settings") throw new Error("Lock settings unavailable");
    return fallback(path, init);
  });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Review restoration" }));
  const dialog = within(screen.getByRole("dialog"));
  await dialog.findByText("Lock settings unavailable");
  const submit = dialog.getByRole("button", { name: "Restore reviewed lock" });
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  let resolveRead!: (data: never) => void;
  request.mockImplementation(() => new Promise((resolve) => (resolveRead = resolve)));
  const retry = dialog.getByRole("button", { name: "Retry lock settings" });
  fireEvent.click(retry);
  expect(retry).toBeDisabled();
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  await act(async () => resolveRead({ revision: "r2", fields: [{ id: "lockOverpopulated", value: false }] } as never));
  await dialog.findByText("Population lock: off → on.");
  expect(submit).toBeEnabled();
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("ends the loading state when the first action-history read fails and recovers with a read-only refresh", async () => {
  events = [event];
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (path.endsWith("/operations")) throw new Error("Actions unavailable");
    return fallback(path, init);
  });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "View actions" }));
  const dialog = within(screen.getByRole("dialog"));
  await dialog.findByRole("alert");
  expect(dialog.queryByText("Loading actions…")).not.toBeInTheDocument();
  expect(dialog.getByText("Event actions unavailable")).toBeInTheDocument();
  request.mockImplementation(fallback);
  fireEvent.click(dialog.getByRole("button", { name: "Refresh actions" }));
  await dialog.findByText("No actions recorded yet");
  expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    request.mock.calls.every(
      ([path, init]) => ["events", `events/${event.id}/operations`].includes(path) && !init?.method,
    ),
  ).toBe(true);
});

it("labels retained event actions after a failed refresh", async () => {
  events = [event];
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (path.endsWith("/operations"))
      return {
        operations: [
          {
            id: "recorded-move",
            operation: { kind: "move_player" },
            state: "applied",
            message: "Recorded team move",
            createdAt: event.createdAt,
            actorName: "Event worker",
          },
        ],
      } as never;
    return fallback(path, init);
  });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "View actions" }));
  const dialog = within(screen.getByRole("dialog"));
  await dialog.findByText("Recorded team move");
  request.mockRejectedValue(new Error("Actions unavailable"));
  fireEvent.click(dialog.getByRole("button", { name: "Refresh actions" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("Showing the last received actions");
  expect(dialog.getByText("Recorded team move")).toBeInTheDocument();
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("keeps the draft editable while a background refresh is pending", async () => {
  const { state, rerender } = show();
  await selectTeams();
  const duration = screen.getByRole("spinbutton", { name: "Duration (minutes)" });
  fireEvent.change(duration, { target: { value: "90" } });
  const fallback = request.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  request.mockImplementation(async (path, init) => {
    await held;
    return fallback(path, init);
  });
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
      <EventsPage />
    </AdminContext.Provider>,
  );
  await waitFor(() =>
    expect(request.mock.calls.filter(([path]) => ["events", "settings", "overview"].includes(path))).toHaveLength(6),
  );
  expect(duration).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Team 1" })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: /Force a respawn/ })).toBeEnabled();
  expect(screen.queryByText("Checking round timing…")).not.toBeInTheDocument();
  await act(async () => release());
  expect(duration).toHaveValue(90);
  expect(screen.getByRole("button", { name: "Review event" })).toBeEnabled();
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
