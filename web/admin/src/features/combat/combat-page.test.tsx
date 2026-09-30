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
  busy: false,
  dialogOpen: false,
  refreshVersion: 0,
  setBusy: vi.fn(),
  setDialogOpen: vi.fn(),
  refresh: vi.fn(),
  invalidateOverview: vi.fn(),
  notify: vi.fn(),
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
function recordedKills() {
  return screen.getByText("RECORDED KILLS", { selector: ".metric-label" }).closest(".metric");
}

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
});
afterEach(cleanup);

describe("CombatPage", () => {
  it("shows loading without inventing an empty history, then renders full-period statistics", async () => {
    const response = deferred<CombatResponse>();
    request.mockReturnValue(response.promise);
    render(page());
    expect(screen.getByText("Loading combat history…")).toBeTruthy();
    expect(screen.queryByText("No recorded player stats yet")).toBeNull();
    await act(async () => response.resolve(server()));
    expect(await screen.findByRole("table", { name: "Server leaderboard" })).toBeTruthy();
    expect(recordedKills()?.textContent).toContain("100");
    expect(
      screen.getByText("Filters apply to these recent events. Stats cover the full recorded period."),
    ).toBeTruthy();
    expect(screen.getByText("Recorded statistics are for human review, not a cheating verdict.")).toBeTruthy();
  });

  it("combines search, cause and headshot filters without recomputing the period totals", async () => {
    request.mockResolvedValue(server());
    render(page());
    let events = await screen.findByRole("table", { name: "Combat events" });
    expect(within(events).getAllByRole("row")).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("Search player, SteamID, or weapon"), { target: { value: aliceId } });
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
    fireEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
    expect(screen.getByText("Loading combat history…")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Server leaderboard" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
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
    expect(screen.getByRole("button", { name: "Last 30 days" }).getAttribute("aria-pressed")).toBe("true");
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
    expect(screen.getByText("K / D", { selector: ".metric-label" }).closest(".metric")?.textContent).toContain("—");
    expect(request).toHaveBeenCalledWith(
      `combat/players/${aliceId}?period=week`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    fireEvent.click(screen.getByRole("button", { name: "← Server leaderboard" }));
    expect(await screen.findByRole("table", { name: "Server leaderboard" })).toBeTruthy();
  });

  it("keeps failed-refresh history explicitly stale and stops claiming a receiving feed", async () => {
    request.mockResolvedValueOnce(server()).mockRejectedValueOnce(new Error("Unavailable"));
    const view = render(page());
    await screen.findByText("FEED RECEIVING");
    view.rerender(page({ ...context, refreshVersion: 1 }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("FEED STATUS UNAVAILABLE")).toBeTruthy();
    expect(screen.queryByText("FEED RECEIVING")).toBeNull();
    expect(screen.getByRole("table", { name: "Server leaderboard" })).toBeTruthy();
  });

  it("distinguishes an inactive feed from server availability and renders names as text", async () => {
    const name = '<img src=x onerror="alert(1)">';
    request.mockResolvedValue(
      server({ feedStatus: "quiet", events: [], leaderboard: [{ ...server().leaderboard[0], name }] }),
    );
    render(page());
    expect(await screen.findByText("NO RECENT BATCH")).toBeTruthy();
    expect(screen.getByText(/A quiet feed does not mean the server is offline/)).toBeTruthy();
    expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("This is recorded history; an empty feed does not mean nobody played.")).toBeTruthy();
  });

  it("blocks navigation while another staff action is in progress", async () => {
    request.mockResolvedValue(server());
    render(page({ ...context, busy: true }));
    await screen.findByRole("table", { name: "Server leaderboard" });
    const period = screen.getByRole("button", { name: "Last 24 hours" }) as HTMLButtonElement;
    expect(period.disabled).toBe(true);
    fireEvent.click(period);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect((screen.getAllByRole("button", { name: "Alice" })[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
