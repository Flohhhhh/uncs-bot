import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { CombatPage } from "./combat-page";
import type { CombatEvent, CombatPlayerResponse, CombatResponse, CombatServerResponse } from "./combat.types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const aliceId = "76561198000000001";
const bobId = "76561198000000002";
const observedAt = "2026-09-30T18:00:00.000Z";
const context: AdminContextValue = {
  me: { id: "12345678901234567", name: "Staff", role: "viewer", csrf: "fixture" },
  overview: null,
  stale: false,
  checking: false,
  watchRoster: vi.fn(),
  busy: false,
  dialogOpen: false,
  refreshVersion: 0,
  setBusy: vi.fn(),
  setDialogOpen: vi.fn(),
  setUnsavedChanges: vi.fn(),
  refresh: vi.fn(),
  invalidateOverview: vi.fn(),
  openAction: vi.fn(),
};

function event(overrides: Partial<CombatEvent> = {}): CombatEvent {
  return {
    eventId: "event-one",
    serverInstanceId: "server-one",
    receivedAt: observedAt,
    eventTime: 120,
    matchId: null,
    mapName: "Harbor",
    killerSteamId: aliceId,
    killerName: "Alice",
    victimSteamId: bobId,
    victimName: "Bob",
    cause: "Rifle",
    distanceMeters: 125.5,
    headshot: true,
    suicide: false,
    ...overrides,
  };
}

function server(overrides: Partial<CombatServerResponse> = {}): CombatServerResponse {
  return {
    enabled: true,
    connected: true,
    feedStatus: "receiving",
    lastReceivedAt: observedAt,
    trackingStartedAt: "2026-09-01T18:00:00.000Z",
    period: "week",
    windowStartedAt: "2026-09-23T18:00:00.000Z",
    asOf: observedAt,
    coverageNote: "Earlier matches, delayed events and delivery gaps may affect totals.",
    totals: { events: 140, kills: 100, deaths: 140, headshotKills: 50, players: 2 },
    leaderboard: [
      { steamId: aliceId, name: "Alice", kills: 80, deaths: 0, headshotKills: 40, kd: null },
      { steamId: bobId, name: "Bob", kills: 20, deaths: 140, headshotKills: 10, kd: 0.14 },
    ],
    events: [
      event(),
      event({ eventId: "event-two", cause: "Grenade", headshot: false }),
      event({
        eventId: "event-three",
        killerSteamId: null,
        killerName: null,
        victimSteamId: aliceId,
        victimName: "Alice",
        cause: "Fall",
        headshot: false,
      }),
    ],
    lastBatch: null,
    lastRejected: null,
    rejectedCount: 0,
    lastRejectedWithoutToken: null,
    rejectedWithoutTokenCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function page(value: AdminContextValue = context) {
  return (
    <AdminContext.Provider value={value}>
      <CombatPage />
    </AdminContext.Provider>
  );
}
/** One entry in the stat strip, such as "Recorded kills 100". */
function stat(label: string) {
  return screen.getByText(label, { selector: ".combat-stats dt" }).closest("div");
}
function recordedKills() {
  return stat("Recorded kills");
}

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
});
afterEach(cleanup);

describe("CombatPage", () => {
  it.each([false, true])("does not present zero statistics before the feed connects (enabled=%s)", async (enabled) => {
    request.mockResolvedValue(
      server({
        enabled,
        connected: false,
        feedStatus: "waiting",
        lastReceivedAt: null,
        trackingStartedAt: null,
        leaderboard: [],
        events: [],
        totals: { events: 0, kills: 0, deaths: 0, headshotKills: 0, players: 0 },
      }),
    );
    render(page());
    await screen.findByText(enabled ? "Waiting for the first combat events" : "Combat tracking is off");
    expect(document.querySelector(".combat-stats")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("shows loading without inventing an empty history, then renders full-period statistics", async () => {
    const response = deferred<CombatResponse>();
    request.mockReturnValue(response.promise);
    render(page());
    expect(screen.getByText("Loading combat history…")).toBeTruthy();
    expect(screen.queryByText("No recorded player stats yet")).toBeNull();
    await act(async () => response.resolve(server()));
    expect(await screen.findByRole("table", { name: "Server leaderboard" })).toBeTruthy();
    expect(recordedKills()?.textContent).toContain("100");
    expect(stat("Headshot kills")?.textContent).toContain("50% of kills");
    expect(
      screen.getByText("Filters apply to these recent events. Stats cover the full recorded period."),
    ).toBeTruthy();
    expect(screen.getByText("Combat feed:").parentElement).toHaveTextContent("Combat feed: Receiving");
    // The coverage notes sit behind one disclosure instead of a permanent panel.
    const about = screen.getByText("About these numbers").closest("details")!;
    expect(about).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("About these numbers"));
    expect(about).toHaveAttribute("open");
    expect(within(about).getByText("Recorded statistics are for human review, not a cheating verdict.")).toBeVisible();
    expect(within(about).getByText(server().coverageNote)).toBeVisible();
  });

  it("keeps recorded history visible after tracking is turned off", async () => {
    request.mockResolvedValue(server({ enabled: false, connected: false, feedStatus: "waiting" }));
    render(page());
    expect(await screen.findByRole("table", { name: "Server leaderboard" })).toBeInTheDocument();
    expect(screen.getByText("Tracking off")).toBeInTheDocument();
    expect(recordedKills()?.textContent).toContain("100");
    expect(screen.queryByText("No statistics are available yet.")).not.toBeInTheDocument();
  });

  it("combines search, cause and headshot filters without recomputing the period totals", async () => {
    request.mockResolvedValue(server());
    render(page());
    let events = await screen.findByRole("table", { name: "Combat events" });
    expect(within(events).getAllByRole("row")).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("Search player, SteamID, or weapon"), { target: { value: ` ${aliceId} ` } });
    fireEvent.change(screen.getByLabelText("Weapon / cause"), { target: { value: "Rifle" } });
    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "headshot" } });
    events = screen.getByRole("table", { name: "Combat events" });
    expect(within(events).getAllByRole("row")).toHaveLength(2);
    expect(within(events).getByText("125.5 m")).toBeTruthy();
    expect(recordedKills()?.textContent).toContain("100");
    fireEvent.change(screen.getByLabelText("Weapon / cause"), { target: { value: "Grenade" } });
    expect(screen.getByText("No events match these filters")).toBeTruthy();
    expect(recordedKills()?.textContent).toContain("100");
    fireEvent.change(screen.getByLabelText("Search player, SteamID, or weapon"), {
      target: { value: "no such player" },
    });
    expect(screen.getByText("No matching players")).toBeTruthy();
  });

  it("allows a failed initial read to be retried without claiming there are no events", async () => {
    request.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce(server());
    render(page());
    expect(await screen.findByText("Combat history could not be loaded")).toBeTruthy();
    expect(screen.getByText("Try again. No empty history has been assumed.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Server leaderboard" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry combat history" }));
    expect(await screen.findByRole("table", { name: "Server leaderboard" })).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("hides old-period data immediately and ignores an out-of-order period response", async () => {
    const day = deferred<CombatResponse>();
    const month = deferred<CombatResponse>();
    request.mockImplementation(async (path) =>
      path.endsWith("period=day") ? day.promise : path.endsWith("period=month") ? month.promise : server(),
    );
    render(page());
    await screen.findByRole("table", { name: "Server leaderboard" });
    fireEvent.click(screen.getByRole("tab", { name: "Last 24 hours" }));
    expect(screen.getByText("Loading combat history…")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Server leaderboard" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Last 30 days" }));
    await act(async () =>
      day.resolve(server({ period: "day", leaderboard: [{ ...server().leaderboard[0], name: "Day-only player" }] })),
    );
    expect(screen.queryByText("Day-only player")).toBeNull();
    expect(screen.getByText("Loading combat history…")).toBeTruthy();
    await act(async () =>
      month.resolve(
        server({ period: "month", leaderboard: [{ ...server().leaderboard[0], name: "Month-only player" }] }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Month-only player" })).toBeTruthy();
    expect(screen.queryByText("Day-only player")).toBeNull();
    expect(screen.getByRole("tab", { name: "Last 30 days" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens a player's history with no old roster and returns to the server leaderboard", async () => {
    const response = deferred<CombatResponse>();
    request.mockImplementation(async (path) => (path.startsWith("combat/players/") ? response.promise : server()));
    render(page());
    const leaderboard = await screen.findByRole("table", { name: "Server leaderboard" });
    fireEvent.click(within(leaderboard).getByRole("button", { name: "Alice" }));
    expect(screen.getByText("Loading combat history…")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Server leaderboard" })).toBeNull();
    const { leaderboard: rows, ...base } = server();
    const playerData: CombatPlayerResponse = { ...base, steamId: aliceId, player: rows[0] };
    await act(async () => response.resolve(playerData));
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(screen.getByText("No recorded deaths in this period")).toBeTruthy();
    expect(stat("K / D")?.textContent).toContain("—");
    expect(request).toHaveBeenCalledWith(
      `combat/players/${aliceId}?period=week`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    fireEvent.click(screen.getByRole("button", { name: "← Server leaderboard" }));
    expect(await screen.findByRole("table", { name: "Server leaderboard" })).toBeTruthy();
  });

  it("opens combat history for a valid SteamID beyond the old prefix", async () => {
    const steamId = "76561200000000000";
    const response = server({ leaderboard: [{ ...server().leaderboard[0], steamId }] });
    const { leaderboard, ...base } = response;
    request.mockImplementation(async (path) =>
      path.startsWith("combat/players/") ? { ...base, steamId, player: leaderboard[0] } : response,
    );
    render(page());
    const table = await screen.findByRole("table", { name: "Server leaderboard" });
    fireEvent.click(within(table).getByRole("button", { name: "Alice" }));
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      `combat/players/${steamId}?period=week`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("keeps failed-refresh history stale through a pending retry until recovery is confirmed", async () => {
    request.mockResolvedValueOnce(server()).mockRejectedValueOnce(new Error("Unavailable"));
    const view = render(page());
    await screen.findByText("Receiving");
    view.rerender(page({ ...context, refreshVersion: 1 }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByText("Receiving")).toBeNull();
    expect(screen.getByRole("table", { name: "Server leaderboard" })).toBeTruthy();
    const retry = deferred<CombatResponse>();
    request.mockImplementationOnce(() => retry.promise as never);
    view.rerender(page({ ...context, refreshVersion: 2 }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("alert")).toHaveTextContent("Showing the last received snapshot");
    expect(screen.queryByText("Receiving")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry combat history" })).toBeDisabled();
    await act(async () => retry.resolve(server({ feedStatus: "quiet" })));
    expect(await screen.findByText("No recent batch")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("distinguishes an inactive feed from server availability and renders names as text", async () => {
    const name = '<img src=x onerror="alert(1)">';
    request.mockResolvedValue(
      server({ feedStatus: "quiet", events: [], leaderboard: [{ ...server().leaderboard[0], name }] }),
    );
    render(page());
    expect(await screen.findByText("No recent batch")).toBeTruthy();
    expect(screen.getByText(/A quiet feed does not mean the server is offline/)).toBeTruthy();
    expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("This is recorded history; an empty feed does not mean nobody played.")).toBeTruthy();
  });

  it("shows no delivery notices while every delivery reaching Gramps was accepted cleanly", async () => {
    request.mockResolvedValue(
      server({ lastBatch: { at: observedAt, accepted: 3, skipped: 1, invalid: 0, firstInvalid: null } }),
    );
    render(page());
    await screen.findByRole("table", { name: "Server leaderboard" });
    expect(document.querySelector(".notice")).toBeNull();
  });

  it("shows staff why the game's deliveries were refused, even before any batch was accepted", async () => {
    request.mockResolvedValue(
      server({
        connected: false,
        feedStatus: "waiting",
        lastReceivedAt: null,
        trackingStartedAt: null,
        leaderboard: [],
        events: [],
        totals: { events: 0, kills: 0, deaths: 0, headshotKills: 0, players: 0 },
        lastRejected: { at: observedAt, status: 400, reason: "invalid payload: events.0.eventTime (bad format)" },
        rejectedCount: 4,
        lastRejectedWithoutToken: { at: observedAt, status: 401, reason: "token mismatch" },
        rejectedWithoutTokenCount: 1,
      }),
    );
    render(page());
    await screen.findByText("Waiting for the first combat events");
    const refused = screen.getByText("Latest game feed delivery refused.").closest(".notice");
    expect(refused).toHaveClass("warning");
    expect(refused).toHaveTextContent("HTTP 400, invalid payload: events.0.eventTime (bad format).");
    expect(refused).toHaveTextContent("No batch has been accepted since.");
    expect(refused).toHaveTextContent("4 deliveries with the feed token refused since Gramps started.");
    const withoutToken = screen.getByText("1 request without the feed token refused").closest(".notice");
    expect(withoutToken).toHaveClass("info");
    expect(withoutToken).toHaveTextContent("HTTP 401, token mismatch.");
    expect(withoutToken).toHaveTextContent("do not show that the game sent them");
  });

  it("warns when the last batch skipped invalid entries and marks older refusals as superseded", async () => {
    request.mockResolvedValue(
      server({
        lastBatch: {
          at: observedAt,
          accepted: 1,
          skipped: 3,
          invalid: 2,
          firstInvalid: "events.1.eventId (bad format)",
        },
        lastRejected: { at: "2026-09-30T17:00:00.000Z", status: 503, reason: "storage unavailable" },
        rejectedCount: 1,
      }),
    );
    render(page());
    await screen.findByRole("table", { name: "Server leaderboard" });
    const skipped = screen.getByText("Last batch skipped invalid entries.").closest(".notice");
    expect(skipped).toHaveClass("warning");
    expect(skipped).toHaveTextContent("1 killed event accepted, 2 invalid entries skipped.");
    expect(skipped).toHaveTextContent("First invalid: events.1.eventId (bad format).");
    const earlier = screen.getByText("Earlier game feed delivery refused.").closest(".notice");
    expect(earlier).toHaveClass("info");
    expect(earlier).toHaveTextContent("HTTP 503, storage unavailable. Later batches were accepted.");
    expect(screen.queryByText(/without the feed token refused/)).toBeNull();
  });

  it("keeps delivery notices on the server view, not a player's history", async () => {
    const response = server({
      lastRejected: { at: observedAt, status: 503, reason: "storage unavailable" },
      rejectedCount: 1,
    });
    const { leaderboard, ...base } = response;
    request.mockImplementation(async (path) =>
      path.startsWith("combat/players/") ? { ...base, steamId: aliceId, player: leaderboard[0] } : response,
    );
    render(page());
    const table = await screen.findByRole("table", { name: "Server leaderboard" });
    expect(screen.getByText("Latest game feed delivery refused.")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "Alice" }));
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(screen.queryByText("Latest game feed delivery refused.")).toBeNull();
  });

  it("lists the game events received by type with an escaped latest sample", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const response = server({
      otherEvents: [
        { type: "killed", count: 9500, firstReceivedAt: observedAt, lastReceivedAt: observedAt, sample: null },
        {
          type: "playerJoined",
          count: 12,
          firstReceivedAt: "2026-09-29T18:00:00.000Z",
          lastReceivedAt: observedAt,
          sample: { type: "playerJoined", steamId: aliceId, name: markup },
        },
        {
          type: "bulk",
          count: 1,
          firstReceivedAt: observedAt,
          lastReceivedAt: observedAt,
          sample: { tooLarge: true, bytes: 5120 },
        },
      ],
    });
    const { leaderboard, otherEvents: _otherEvents, ...base } = response;
    request.mockImplementation(async (path) =>
      path.startsWith("combat/players/") ? { ...base, steamId: aliceId, player: leaderboard[0] } : response,
    );
    render(page());
    const list = await screen.findByRole("list", { name: "Game events received" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent?.replace(/ last seen .*/, ""))).toEqual([
      `killed · ${(9500).toLocaleString()} ·`,
      "playerJoined · 12 ·",
      "bulk · 1 ·",
    ]);
    expect(
      within(rows[0])
        .getByText(/last seen/)
        .querySelector("time"),
    ).toHaveAttribute("dateTime", observedAt);
    // Killed events are stored in full, so they carry no sample.
    expect(within(rows[0]).queryByText("Latest sample")).toBeNull();
    const sample = within(rows[1]).getByText("Latest sample").closest("details")!;
    expect(sample).not.toHaveAttribute("open");
    fireEvent.click(within(sample).getByText("Latest sample"));
    expect(sample).toHaveAttribute("open");
    const pre = sample.querySelector("pre")!;
    expect(JSON.parse(pre.textContent!)).toEqual({ type: "playerJoined", steamId: aliceId, name: markup });
    expect(pre.children).toHaveLength(0);
    expect(document.querySelector("img")).toBeNull();
    expect(JSON.parse(rows[2].querySelector("pre")!.textContent!)).toEqual({ tooLarge: true, bytes: 5120 });
    // Server view only: a player's history does not show feed event types.
    fireEvent.click(
      within(screen.getByRole("table", { name: "Server leaderboard" })).getByRole("button", { name: "Alice" }),
    );
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(screen.queryByText("Game events received")).toBeNull();
  });

  it("says when no game events were counted and omits the section for an older Gramps", async () => {
    request.mockResolvedValueOnce(server({ otherEvents: [] }));
    const { unmount } = render(page());
    expect(await screen.findByText("No game events counted in this period")).toBeInTheDocument();
    expect(screen.getByText("Game events received")).toBeInTheDocument();
    unmount();
    request.mockResolvedValueOnce(server());
    render(page());
    await screen.findByRole("table", { name: "Server leaderboard" });
    expect(screen.queryByText("Game events received")).toBeNull();
  });

  it("warns when the last batch had new event types over the daily limit", async () => {
    const batch = { at: observedAt, accepted: 3, skipped: 7, invalid: 0, firstInvalid: null, types: 9 };
    request.mockResolvedValueOnce(server({ lastBatch: { ...batch, typesOverLimit: 2 } }));
    const { unmount } = render(page());
    await screen.findByRole("table", { name: "Server leaderboard" });
    const notice = screen.getByText("Daily event type limit reached.").closest(".notice");
    expect(notice).toHaveClass("warning");
    expect(notice).toHaveTextContent("2 new event types not counted.");
    unmount();
    request.mockResolvedValueOnce(server({ lastBatch: { ...batch, typesOverLimit: 0 } }));
    render(page());
    await screen.findByRole("table", { name: "Server leaderboard" });
    expect(screen.queryByText("Daily event type limit reached.")).toBeNull();
  });

  it("blocks navigation while another staff action is in progress", async () => {
    request.mockResolvedValue(server());
    render(page({ ...context, busy: true }));
    await screen.findByRole("table", { name: "Server leaderboard" });
    const period = screen.getByRole("tab", { name: "Last 24 hours" }) as HTMLButtonElement;
    expect(period.disabled).toBe(true);
    fireEvent.click(period);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect((screen.getAllByRole("button", { name: "Alice" })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows weapons by their readable name and still filters by the reported cause", async () => {
    request.mockResolvedValue(server({ events: [event({ cause: "Id.Item.AK74M" }), event({ eventId: "two" })] }));
    render(page());
    const events = await screen.findByRole("table", { name: "Combat events" });
    expect(within(events).getByText("AK74")).toHaveAttribute("title", "Id.Item.AK74M");
    const cause = screen.getByLabelText("Weapon / cause");
    expect(within(cause).getByRole("option", { name: "AK74" })).toHaveValue("AK74");
    fireEvent.change(cause, { target: { value: "AK74" } });
    expect(within(screen.getByRole("table", { name: "Combat events" })).getAllByRole("row")).toHaveLength(2);
  });

  it("offers one option per readable weapon, keeps unnamed causes apart and searches the shown name", async () => {
    request.mockResolvedValue(
      server({
        events: [
          event({ eventId: "one", cause: "Id.Item.SR_04" }),
          event({ eventId: "two", cause: "ID.Item.SR_04" }),
          event({ eventId: "three", cause: "Weapon.Rifle" }),
          event({ eventId: "four", cause: "Some.Other" }),
        ],
      }),
    );
    render(page());
    const rows = () => within(screen.getByRole("table", { name: "Combat events" })).getAllByRole("row");
    await screen.findByRole("table", { name: "Combat events" });
    const cause = screen.getByLabelText("Weapon / cause");
    // Both casings read "AMR 50", so they are one option that matches both events.
    expect(within(cause).getAllByRole("option", { name: "AMR 50" })).toHaveLength(1);
    expect(within(cause).getByRole("option", { name: "Unknown weapon (Weapon.Rifle)" })).toHaveValue("Weapon.Rifle");
    expect(within(cause).getByRole("option", { name: "Unknown weapon (Some.Other)" })).toHaveValue("Some.Other");
    fireEvent.change(cause, { target: { value: "AMR 50" } });
    expect(rows()).toHaveLength(3);
    fireEvent.change(cause, { target: { value: "Weapon.Rifle" } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(cause, { target: { value: "" } });
    // The table shows "AMR 50", so searching for it finds both casings; the raw id still matches too.
    const search = screen.getByLabelText("Search player, SteamID, or weapon");
    fireEvent.change(search, { target: { value: "amr 50" } });
    expect(rows()).toHaveLength(3);
    fireEvent.change(search, { target: { value: "ID.Item.SR_04" } });
    expect(rows()).toHaveLength(3);
  });
});
