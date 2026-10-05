import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { context } from "../players/test-fixtures";
import { ActivityFeed, ActivityPage } from "./activity-page";
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const event = {
  id: "join",
  observedAt: "2026-10-02T04:00:00Z",
  category: "players",
  message: "Alice joined",
  steamId: "76561198000000001",
};
const kill = {
  eventId: "kill-one",
  serverInstanceId: "server-one",
  receivedAt: "2026-10-02T04:01:00Z",
  eventTime: 60,
  matchId: null,
  mapName: "Harbor",
  killerSteamId: "76561198000000003",
  killerName: "Cara",
  victimSteamId: "76561198000000002",
  victimName: "Bob",
  cause: "Id.Item.AK74M",
  distanceMeters: 21.4,
  headshot: false,
  suicide: false,
};
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(
    async (path) =>
      (path === "activity"
        ? { events: [event], limit: 300, connection: "available", startedAt: event.observedAt }
        : path === "audit-notable"
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
function page(admin: AdminContextValue, children: ReactNode = <ActivityFeed />, path = "/activity?server=primary") {
  function Where() {
    return <output data-testid="location">{useLocation().search}</output>;
  }
  return (
    <MemoryRouter initialEntries={[path]}>
      <AdminContext.Provider value={admin}>
        {children}
        <Where />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
/** The rendered feed lines, as their text. */
function lines() {
  return [...document.querySelectorAll(".activity-line")].map((line) => line.textContent);
}
function chip(name: RegExp) {
  return within(screen.getByRole("group", { name: "Activity types" })).getByRole("button", { name });
}
/** The player panel's always-present notice region; the SteamID copy button has its own status line. */
function availability(panel: HTMLElement) {
  return within(panel)
    .getAllByRole("status")
    .find((region) => !region.closest(".copy-value"))!;
}

it("combines observations and actual action outcomes while the native feed is still waiting", async () => {
  render(page(context()));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  const staff = screen.getByText(/^Mod · Ban player/).closest(".activity-line")!;
  expect(within(staff as HTMLElement).getByText("Failed")).toBeInTheDocument();
  expect(staff).toHaveTextContent("Ban refused");
  expect(screen.getByText("Game connected · Combat feed: awaiting first batch")).toBeInTheDocument();
  fireEvent.click(chip(/Staff & automation/));
  expect(chip(/Staff & automation/)).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByText(/^Mod · Ban/)).not.toBeInTheDocument();
  expect(lines()).toContain("Alice joined");
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it("keeps kills out of the feed until staff turn them on, with readable weapons and searchable raw IDs", async () => {
  const fallback = request.getMockImplementation()!;
  request.mockImplementation((path, options) =>
    path === "combat?period=day"
      ? Promise.resolve({ enabled: true, feedStatus: "receiving", events: [kill] } as never)
      : fallback(path, options),
  );
  render(page(context()));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  expect(chip(/Kills & deaths 1/)).toHaveAttribute("aria-pressed", "false");
  expect(lines()).not.toContain("Cara killed Bob · AK-74M · 21 m");
  fireEvent.click(chip(/Kills & deaths/));
  expect(lines()).toContain("Cara killed Bob · AK-74M · 21 m");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Id.Item.AK74M" } });
  expect(lines()).toEqual(["Cara killed Bob · AK-74M · 21 m"]);
  expect(screen.getByText("Game connected · Combat feed: receiving")).toBeInTheDocument();
});
it("opens the player panel from a name in the feed", async () => {
  render(page(context()));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  const line = screen.getAllByRole("button", { name: "Alice" })[0];
  fireEvent.click(line);
  const panel = screen.getByRole("dialog");
  expect(within(panel).getByRole("heading", { name: "UNC Alice" })).toBeInTheDocument();
  expect(within(panel).getByRole("link", { name: "Combat history →" })).toHaveAttribute(
    "href",
    "/activity?server=primary&view=combat&player=76561198000000001",
  );
});
it("asks for the live roster and does not claim a player left while it is being read", async () => {
  const release = vi.fn();
  const watchRoster = vi.fn(() => release);
  const admin = context({ overview: null, stale: true, checking: true, watchRoster });
  render(page(admin));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  expect(watchRoster).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Alice" })[0]);
  const panel = screen.getByRole("dialog");
  expect(watchRoster).toHaveBeenCalledTimes(1);
  expect(panel).toHaveTextContent("Checking the live roster…");
  expect(panel).not.toHaveTextContent("no longer in the current roster");
  expect(within(panel).queryByRole("button", { name: "Kick player" })).not.toBeInTheDocument();
  // Check again is there but waits for the read in flight, without starting another.
  const check = within(panel).getByRole("button", { name: "Check again" });
  expect(check).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(check);
  expect(admin.refresh).not.toHaveBeenCalled();
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(release).toHaveBeenCalledTimes(1);
});
it("offers a check that works from the panel when an older roster needs a fresh read", async () => {
  // A roster left behind by an earlier page, past its freshness, as Server activity holds it.
  const admin = context({ stale: true });
  const view = (state: Partial<AdminContextValue>) => page({ ...admin, ...state });
  const rendered = render(view({}));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  fireEvent.click(screen.getAllByRole("button", { name: "Alice" })[0]);
  const panel = screen.getByRole("dialog");
  expect(within(panel).getByRole("button", { name: "Kick player" })).toBeDisabled();
  expect(panel).toHaveTextContent("Server details need a fresh check before choosing an action.");
  expect(panel).not.toHaveTextContent(/close this panel/i);
  const check = within(panel).getByRole("button", { name: "Check again" });
  expect(check).toHaveAttribute("aria-disabled", "false");
  check.focus();
  fireEvent.click(check);
  expect(admin.refresh).toHaveBeenCalledTimes(1);
  // Refresh starts the next read. The button stays, and keeps focus, while it runs and after it succeeds.
  rendered.rerender(view({ checking: true, refreshVersion: 1 }));
  expect(availability(panel)).toHaveTextContent("Checking the server for current details…");
  expect(check).toBeInTheDocument();
  expect(check).toHaveFocus();
  expect(check).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(check);
  expect(admin.refresh).toHaveBeenCalledTimes(1);
  rendered.rerender(view({ stale: false, refreshVersion: 1 }));
  expect(within(panel).getByRole("button", { name: "Kick player" })).toBeEnabled();
  expect(panel).not.toHaveTextContent("fresh check");
  expect(check).toBeInTheDocument();
  expect(check).toHaveFocus();
  expect(check).toHaveAttribute("aria-disabled", "false");
});
it("leaves the panel's reason as it is while the dashboard's own reads keep failing", async () => {
  const admin = context({ stale: true });
  const view = (state: Partial<AdminContextValue>) => page({ ...admin, ...state });
  const rendered = render(view({}));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  fireEvent.click(screen.getAllByRole("button", { name: "Alice" })[0]);
  const panel = screen.getByRole("dialog");
  const status = availability(panel);
  const reason = "Server details need a fresh check before choosing an action.";
  expect(status).toHaveTextContent(reason);
  // Each 20-second tick starts a read that staff did not ask for; the status line must not flip and re-announce.
  for (const version of [1, 2]) {
    rendered.rerender(view({ checking: true, refreshVersion: version }));
    expect(status).toHaveTextContent(reason);
    expect(within(panel).getByRole("button", { name: "Check again" })).toHaveAttribute("aria-disabled", "true");
    rendered.rerender(view({ refreshVersion: version }));
    expect(status).toHaveTextContent(reason);
  }
  expect(admin.refresh).not.toHaveBeenCalled();
});
it("keeps saying the roster could not be read during a background read", async () => {
  const admin = context({ overview: null, stale: true });
  const view = (state: Partial<AdminContextValue>) => page({ ...admin, ...state });
  const rendered = render(view({}));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  fireEvent.click(screen.getAllByRole("button", { name: "Alice" })[0]);
  const panel = screen.getByRole("dialog");
  expect(panel).toHaveTextContent("The live roster could not be read.");
  rendered.rerender(view({ checking: true, refreshVersion: 1 }));
  expect(panel).toHaveTextContent("The live roster could not be read.");
  expect(panel).not.toHaveTextContent("Checking the live roster…");
});
it("says when the live roster could not be read and offers another check", async () => {
  const admin = context({ overview: null, stale: true });
  render(page(admin));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
  fireEvent.click(screen.getAllByRole("button", { name: "Alice" })[0]);
  const panel = screen.getByRole("dialog");
  expect(panel).toHaveTextContent("The live roster could not be read.");
  expect(panel).not.toHaveTextContent("no longer in the current roster");
  fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
  expect(admin.refresh).toHaveBeenCalledTimes(1);
});
it("keeps working sources and the failed-source warning visible until a pending refresh succeeds", async () => {
  const fallback = request.getMockImplementation()!;
  request.mockImplementation((path, options) =>
    path === "audit-notable" ? Promise.reject(new Error("Unavailable")) : fallback(path, options),
  );
  const view = (refreshVersion: number) => page(context({ refreshVersion }));
  const rendered = render(view(0));
  expect(await screen.findByRole("alert")).toHaveTextContent("Action receipts");
  expect(lines()).toContain("Alice joined");
  let finishRead!: (value: never) => void;
  const pendingRead = new Promise<never>((resolve) => (finishRead = resolve));
  request.mockImplementation((path, options) => (path === "audit-notable" ? pendingRead : fallback(path, options)));
  rendered.rerender(view(1));
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "audit-notable")).toHaveLength(2));
  expect(screen.getByRole("alert")).toHaveTextContent("Action receipts");
  expect(lines()).toContain("Alice joined");
  await act(async () => finishRead([] as never));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it("freezes the display for reading and resumes with newer observations", async () => {
  const view = (refreshVersion: number) => page(context({ refreshVersion }));
  const rendered = render(view(0));
  await waitFor(() => expect(lines()).toContain("Alice joined"));
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
  expect(lines()).not.toContain("Alice left");
  fireEvent.click(screen.getByRole("button", { name: "Resume display" }));
  await waitFor(() => expect(lines()).toContain("Alice left"));
});
it("reads notable receipts for the selected server and keeps unconfirmed automatic messages beside staff messages", async () => {
  const fallback = request.getMockImplementation()!;
  const welcome = {
    actorName: "Gramps community messages",
    action: "message",
    target: "76561198000000002",
    createdAt: event.observedAt,
    details: { reason: "Automatic observed-join welcome." },
  };
  request.mockImplementation((path, options) =>
    path === "servers/east/audit-notable"
      ? Promise.resolve([
          { ...welcome, id: "failed", state: "failed", message: "Automatic message was not confirmed." },
          { ...welcome, id: "lost", state: "started", message: "Action started; result not yet recorded." },
          { ...welcome, id: "manual", actorName: "Mod", state: "accepted", message: "Accepted" },
        ] as never)
      : fallback(path.replace(/^servers\/east\//, ""), options),
  );
  render(page({ ...context(), server: { id: "east", name: "East", version: "1".repeat(64), role: "admin" } }));
  await waitFor(() => expect(lines()).toHaveLength(4));
  expect(lines()).toEqual(
    expect.arrayContaining([
      "Gramps community messages · Message player · BobFailed · Automatic message was not confirmed.",
      "Gramps community messages · Message player · BobUnconfirmed · Action started; result not yet recorded.",
      "Mod · Message player · BobAccepted · not verified · Accepted",
    ]),
  );
  expect(request.mock.calls.map(([path]) => path)).not.toContain("servers/east/audit");
});
it("keeps the view and focused player in the URL beside the selected server", async () => {
  request.mockImplementation(async (path) =>
    path.startsWith("combat/players/")
      ? ({
          enabled: true,
          connected: true,
          feedStatus: "receiving",
          lastReceivedAt: null,
          trackingStartedAt: "2026-09-01T00:00:00Z",
          period: "week",
          windowStartedAt: "2026-09-25T00:00:00Z",
          asOf: "2026-10-02T00:00:00Z",
          coverageNote: "",
          totals: { events: 1, kills: 1, deaths: 0, headshotKills: 0, players: 1 },
          steamId: "76561198000000001",
          player: { steamId: "76561198000000001", name: "UNC Alice", kills: 1, deaths: 0, headshotKills: 0, kd: null },
          events: [],
        } as never)
      : ([] as never),
  );
  render(page(context(), <ActivityPage />, "/activity?server=primary&view=combat&player=76561198000000001"));
  expect(screen.getByRole("tab", { name: "Combat history" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByRole("heading", { name: "UNC Alice" })).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(
    "combat/players/76561198000000001?period=week",
    expect.objectContaining({ signal: expect.anything() }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Action history" }));
  expect(screen.getByTestId("location")).toHaveTextContent(/^\?server=primary&view=actions$/);
  expect(screen.getByRole("tab", { name: "Action history" })).toHaveAttribute("aria-selected", "true");
});
it("hides the command log from moderators even when the URL asks for it", async () => {
  request.mockImplementation(async (path) => (path === "activity" ? { events: [] } : []) as never);
  const admin = context();
  admin.me.role = "moderator";
  render(page(admin, <ActivityPage />, "/activity?server=primary&view=commands"));
  expect(screen.getByRole("tab", { name: "All activity" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tab", { name: "Game command log" })).not.toBeInTheDocument();
  await screen.findByText("No matching activity yet");
  expect(request.mock.calls.map(([path]) => path)).not.toContain("game-log");
});
it("prefills action history for a linked player and clears the player when staff change views", async () => {
  request.mockImplementation(async (path) => (path === "activity" ? { events: [] } : []) as never);
  render(page(context(), <ActivityPage />, "/activity?server=primary&view=actions&player=76561198000000002"));
  expect(screen.getByRole("searchbox")).toHaveValue("76561198000000002");
  await screen.findByText("No matching staff actions");
  fireEvent.click(screen.getByRole("tab", { name: "All activity" }));
  fireEvent.click(screen.getByRole("tab", { name: "Action history" }));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(screen.getByTestId("location")).toHaveTextContent(/^\?server=primary&view=actions$/);
});
it("opens a linked action receipt by ID and drops the ID when staff change views", async () => {
  const id = "7ab342f1-4200-4dfe-9050-5d7f2c310151";
  request.mockImplementation(
    async (path) =>
      (path === `audit/${id}`
        ? {
            record: {
              id,
              actorName: "Receipt staff",
              action: "kick",
              target: "76561198000000002",
              state: "unknown",
              message: "Readback unavailable",
              createdAt: event.observedAt,
              details: { reason: "Linked from a review" },
            },
          }
        : path === "activity"
          ? { events: [] }
          : []) as never,
  );
  render(page(context(), <ActivityPage />, `/activity?server=primary&view=actions&id=${id.toUpperCase()}`));
  expect(screen.getByRole("searchbox")).toHaveValue(id);
  expect(await screen.findByText("Receipt staff")).toBeInTheDocument();
  expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
  expect(request.mock.calls.map(([path]) => path)).not.toContain("audit");
  fireEvent.click(screen.getByRole("tab", { name: "All activity" }));
  expect(screen.getByTestId("location")).toHaveTextContent(/^\?server=primary&view=feed$/);
});
it("ignores an ID that is not a complete action ID", async () => {
  request.mockImplementation(async (path) => (path === "activity" ? { events: [] } : []) as never);
  render(page(context(), <ActivityPage />, "/activity?server=primary&view=actions&id=../settings"));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  await screen.findByText("No recorded staff actions");
  expect(request.mock.calls.map(([path]) => path).sort()).toEqual(["audit", "moderation/repeat-offenders"]);
});
describe("repeat offenders on Action history", () => {
  const griefer = "76561198000000009";
  const lastAt = "2026-10-02T18:00:00Z";
  const list = (players: unknown[]) => ({ minimum: 2, days: 30, players });
  const offender = {
    steamId: griefer,
    name: "Griefer",
    kicks: { count: 4, recent: 3, lastAt, lastBy: "Mod", lastReason: "Team killing" },
  };
  function respond(repeat: unknown) {
    request.mockImplementation(
      async (path) =>
        (path === "moderation/repeat-offenders"
          ? repeat
          : path === "activity"
            ? { events: [] }
            : path.startsWith("moderation/players/")
              ? { kicks: offender.kicks, bans: null, entries: [] }
              : []) as never,
    );
  }
  it("lists players kicked often lately, each opening the player panel", async () => {
    respond(list([offender, { ...offender, steamId: "76561198000000008", name: null }]));
    render(page(context(), <ActivityPage />, "/activity?server=primary&view=actions"));
    expect(await screen.findByRole("heading", { name: "Repeat offenders" })).toBeInTheDocument();
    expect(screen.getByText("2+ kicks in the last 30 days")).toBeInTheDocument();
    const day = new Date(lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const row = screen.getByRole("button", { name: "Griefer" }).closest("li")!;
    expect(row).toHaveTextContent(`3 kicks · last ${day} by Mod: Team killing`);
    // A record from before names were kept shows the SteamID.
    expect(screen.getByRole("button", { name: "76561198000000008" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Griefer" }));
    const panel = screen.getByRole("dialog");
    expect(within(panel).getByRole("heading", { name: "Griefer" })).toBeInTheDocument();
    expect(await within(panel).findByText(`Kicked 4 times · last ${day} by Mod: Team killing`)).toBeInTheDocument();
  });
  it("shows nothing when no player qualifies", async () => {
    respond(list([]));
    render(page(context(), <ActivityPage />, "/activity?server=primary&view=actions"));
    await screen.findByText("No recorded staff actions");
    expect(request).toHaveBeenCalledWith("moderation/repeat-offenders", expect.anything());
    expect(screen.queryByRole("heading", { name: "Repeat offenders" })).not.toBeInTheDocument();
  });
  it("leaves the list out of a linked player's action history", async () => {
    respond(list([offender]));
    render(page(context(), <ActivityPage />, `/activity?server=primary&view=actions&player=${griefer}`));
    await screen.findByText("No matching staff actions");
    expect(request.mock.calls.map(([path]) => path)).toEqual(["audit"]);
    expect(screen.queryByRole("heading", { name: "Repeat offenders" })).not.toBeInTheDocument();
  });
});
