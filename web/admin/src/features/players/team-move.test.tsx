import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Overview } from "../../api/types";
import { AdminContext } from "../../app/context";
import { TeamMoveDialog, type TeamMoveResult } from "./team-move";
import { alice, bob, cara, context, overview } from "./test-fixtures";
import { actionSchema } from "../../../../../src/admin/admin.types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
let live: Overview;
beforeEach(() => {
  request.mockReset();
  live = overview();
});
afterEach(() => vi.useRealTimers());
function submit() {
  fireEvent.submit(screen.getByRole("button", { name: /^Move \d/ }).closest("form")!);
}
/** Serves the live roster read before each move; every other request is a team action. */
function answer(action: () => unknown) {
  request.mockImplementation(async (path) => (path === "overview" ? live : action()));
}
const sent = () => request.mock.calls.filter(([path]) => path === "actions");
const body = (index: number) => JSON.parse(String(sent()[index][1]?.body));
async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("reviewed team moves", () => {
  it("stops unsent moves while allowing the current request to keep its actual outcome", async () => {
    let finish!: (result: unknown) => void;
    answer(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={admin}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(sent()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Any request already sent will finish");
    expect(sent()[0][1]?.signal).toBeUndefined();
    expect(finished).not.toHaveBeenCalled();
    await act(async () => finish({ state: "accepted", message: "Accepted, not verified" }));
    expect(finished.mock.calls[0][0]).toMatchObject({
      stopped: true,
      items: [{ state: "accepted" }, { state: "queued" }],
    });
    expect(screen.getByRole("button", { name: /^Close$/ })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped at your request");
    expect(admin.invalidateOverview).toHaveBeenCalledOnce();
    expect(admin.setBusy).toHaveBeenLastCalledWith(false);
    expect(sent()).toHaveLength(1);
  });
  it("stops during the gap between requests without sending another move", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "applied", message: "Confirmed" }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    await flush(2199);
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    await flush(1);
    expect(sent()).toHaveLength(1);
    expect(finished.mock.calls[0][0]).toMatchObject({
      stopped: true,
      items: [{ state: "applied" }, { state: "queued" }],
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped at your request");
  });
  it("keeps an uncertain in-flight outcome when stopping and never offers a resend", async () => {
    let reject!: (failure: Error) => void;
    answer(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(sent()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    await act(async () => reject(new Error("Network dropped")));
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["unknown", "queued"]);
    expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move \d/ })).not.toBeInTheDocument();
    expect(sent()).toHaveLength(1);
  });
  it("does not offer a stop for a single request that has already been sent", async () => {
    let finish!: (result: unknown) => void;
    answer(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice]} initialFaction="Lonestar" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Stop remaining moves" })).not.toBeInTheDocument();
    await act(async () => finish({ state: "applied", message: "Confirmed" }));
    expect(screen.getByRole("heading", { name: "Team requests complete" })).toBeInTheDocument();
  });
  it("shows a single player's result on one line without the outcomes table or review label", async () => {
    let read!: (overview: Overview) => void;
    request.mockImplementation((path) =>
      path === "overview"
        ? new Promise((resolve) => {
            read = resolve;
          })
        : Promise.resolve({ state: "applied", message: "Assignment confirmed by the game." }),
    );
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice]} initialFaction="Lonestar" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("STAFF REVIEW");
    submit();
    const line = await screen.findByRole("status", { name: "Team move outcome" });
    // The live roster read before the move can take a while; the line shows it is working, not "Not sent".
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "overview")).toBe(true));
    expect(line).toHaveTextContent("Checking roster… Reading the live roster before sending the move.");
    expect(line).not.toHaveTextContent("Not sent");
    await act(async () => read(live));
    await waitFor(() => expect(line).toHaveTextContent("Applied Assignment confirmed by the game."));
    expect(line).not.toHaveTextContent("Not sent");
    expect(screen.queryByRole("table", { name: "Team move outcomes" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent("STAFF REVIEW");
    expect(sent()).toHaveLength(1);
  });
  it("says a single move stopped during the roster read was not sent", async () => {
    let read!: (overview: Overview) => void;
    request.mockImplementation((path) =>
      path === "overview"
        ? new Promise((resolve) => {
            read = resolve;
          })
        : Promise.resolve({ state: "applied", message: "Confirmed" }),
    );
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice]} initialFaction="Lonestar" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    submit();
    const line = await screen.findByRole("status", { name: "Team move outcome" });
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "overview")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    expect(line).toHaveTextContent("Checking roster… Stopping before the request is sent.");
    await act(async () => read(live));
    expect(screen.getByRole("heading", { name: "Team move stopped" })).toBeInTheDocument();
    expect(line).toHaveTextContent("Not sent");
    expect(sent()).toHaveLength(0);
  });
  it("sends each player with a unique ID, exact confirmation, faction name and reviewed round, spaced sequentially", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "applied", message: "Assignment confirmed; respawn may be needed." }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    submit();
    await flush();
    expect(sent()).toHaveLength(1);
    await flush(2199);
    expect(sent()).toHaveLength(1);
    await flush(1);
    expect(sent()).toHaveLength(2);
    const [first, second] = [body(0), body(1)];
    expect(first).toMatchObject({
      action: "team",
      faction: "Lonestar",
      steamId: alice.steamId,
      confirm: alice.steamId,
      expectedRound: { map: "Harbor", startedAt: Date.parse(live.observedAt) - 120_000 },
      reason: "Staff requested team move.",
    });
    expect(second).toMatchObject({ action: "team", faction: "Lonestar", steamId: bob.steamId, confirm: bob.steamId });
    expect(first.id).not.toBe(second.id);
    expect(actionSchema.safeParse(first).success).toBe(true);
    expect(request.mock.calls.filter(([path]) => path === "overview")).toHaveLength(2);
    expect(finished.mock.calls[0][0].stopped).toBe(false);
    expect(screen.queryByRole("button", { name: /^Move \d/ })).not.toBeInTheDocument();
  });
  it.each([
    ["#D86060", "Valkyra"],
    ["D86060", undefined],
  ])("sends the reviewed team only when the server reads it the same way (color %s)", async (colorHex, expected) => {
    answer(() => ({ state: "applied", message: "Confirmed" }));
    live.status.factionScores[0].colorHex = colorHex;
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice]} initialFaction="Lonestar" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(body(0).expectedFaction).toBe(expected);
    expect(actionSchema.safeParse(body(0)).success).toBe(true);
  });
  it.each(["failed", "unknown"] as const)("stops after %s and keeps remaining players unsent", async (state) => {
    answer(() => ({ state, message: "Check the action" }));
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={admin}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(sent()).toHaveLength(1);
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual([state, "queued"]);
    expect(admin.invalidateOverview).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("will not be retried automatically");
  });
  it("keeps going after the server refuses a player whose team changed before the move", async () => {
    vi.useFakeTimers();
    request.mockImplementation(async (path) =>
      path === "overview"
        ? live
        : sent().length === 1
          ? {
              state: "failed",
              changed: false,
              message: "The player's team changed before this move. No move was sent.",
            }
          : { state: "applied", changed: true, message: "Confirmed" },
    );
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    await flush(2200);
    expect(sent()).toHaveLength(2);
    expect(finished.mock.calls[0][0]).toMatchObject({
      stopped: false,
      items: [{ state: "refused", message: expect.stringContaining("team changed") }, { state: "applied" }],
    });
    // Labelled like the dialog's own roster-change skip, but the server recorded it, so it keeps its receipt.
    const refused = screen.getByRole("row", { name: /^UNC Alice/ });
    expect(refused).toHaveTextContent("Skipped · roster changed");
    expect(refused).not.toHaveTextContent("Failed");
    expect(within(refused).getByText("Action details")).toBeInTheDocument();
  });
  it("never resends on double submission and reports transport failure as unknown", async () => {
    let reject!: (error: Error) => void;
    answer(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    const form = screen.getByRole("button", { name: /^Move \d/ }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(sent()).toHaveLength(1));
    await act(async () => reject(new Error("Network dropped")));
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["unknown", "queued"]);
    expect(screen.getByRole("alert")).toHaveTextContent("remaining requests");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not send a request for someone already on the destination", async () => {
    answer(() => ({ state: "accepted", message: "Accepted, not verified" }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[cara, alice]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(sent()).toHaveLength(1);
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["skipped", "accepted"]);
    expect(screen.getByText("Accepted · not verified")).toBeInTheDocument();
  });
  it("keeps moving when only the paused dashboard snapshot expires during the spacing delay", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "applied", message: "Confirmed" }));
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    const tree = (stale: boolean) => (
      <AdminContext.Provider value={{ ...admin, stale }}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(false));
    submit();
    await flush();
    rerender(tree(true));
    await flush(2200);
    expect(sent()).toHaveLength(2);
    expect(finished.mock.calls[0][0]).toMatchObject({
      stopped: false,
      items: [{ state: "applied" }, { state: "applied" }],
    });
  });
  it("stops remaining requests if the page was hidden during the spacing delay", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "applied", message: "Confirmed" }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await flush(2200);
    expect(sent()).toHaveLength(1);
    expect(finished.mock.calls[0][0].stopped).toBe(true);
    expect(finished.mock.calls[0][0].items[1].state).toBe("queued");
    expect(screen.getByRole("alert")).toHaveTextContent("hidden");
  });
  it("stops remaining requests if the live roster cannot be read before a move", async () => {
    vi.useFakeTimers();
    let reads = 0;
    request.mockImplementation(async (path) => {
      if (path !== "overview") return { state: "applied", message: "Confirmed" };
      if (++reads > 1) throw new Error("The server could not be read.");
      return live;
    });
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={admin}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    await flush(2200);
    expect(sent()).toHaveLength(1);
    expect(finished.mock.calls[0][0].stopped).toBe(true);
    expect(finished.mock.calls[0][0].items[1].state).toBe("queued");
    expect(admin.invalidateOverview).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("live roster could not be read");
  });
  it("stops remaining requests when the live roster shows a new round", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "applied", message: "Confirmed" }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    live = { ...live, status: { ...live.status, map: "Europe", matchSeconds: 1 } };
    await flush(2200);
    expect(sent()).toHaveLength(1);
    expect(finished.mock.calls[0][0].stopped).toBe(true);
    expect(finished.mock.calls[0][0].items[1].state).toBe("queued");
    expect(screen.getByRole("alert")).toHaveTextContent("round changed");
  });
  it("cancels the remaining batch when its dialog is unmounted", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "applied", message: "Confirmed" }));
    const { unmount } = render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    unmount();
    await flush(2200);
    expect(sent()).toHaveLength(1);
  });
  it.each(["left", "changed team"])(
    "skips and reports a queued player who %s while the rest of the batch continues",
    async (change) => {
      vi.useFakeTimers();
      const dana = { name: "Dana", steamId: "76561198000000004", faction: "RED" };
      live.players.push(dana);
      answer(() => ({ state: "applied", message: "Confirmed" }));
      const finished = vi.fn<(result: TeamMoveResult) => void>();
      render(
        <AdminContext.Provider value={context({ overview: { ...live, players: [...live.players] } })}>
          <TeamMoveDialog
            players={[alice, bob, dana]}
            initialFaction="Lonestar"
            onClose={vi.fn()}
            onComplete={finished}
          />
        </AdminContext.Provider>,
      );
      submit();
      await flush();
      live = {
        ...live,
        players: change === "left" ? [alice, cara, dana] : [alice, { ...bob, faction: "BLU" }, cara, dana],
      };
      await flush(2200);
      await flush(2200);
      expect(sent().map(([, options]) => JSON.parse(String(options?.body)).steamId)).toEqual([
        alice.steamId,
        dana.steamId,
      ]);
      expect(finished.mock.calls[0][0]).toMatchObject({
        stopped: false,
        items: [
          { state: "applied" },
          {
            state: "unmatched",
            message: expect.stringMatching(change === "left" ? /^Left the server/ : /^Changed team/),
          },
          { state: "applied" },
        ],
      });
      expect(screen.getByText("Skipped · roster changed")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Team requests complete" })).toBeInTheDocument();
    },
  );
  it("does not add a request-spacing delay for players already on the destination", async () => {
    vi.useFakeTimers();
    answer(() => ({ state: "accepted", message: "Accepted, not verified" }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog
          players={[alice, cara, bob]}
          initialFaction="Lonestar"
          onClose={vi.fn()}
          onComplete={finished}
        />
      </AdminContext.Provider>,
    );
    submit();
    await flush(2200);
    expect(sent()).toHaveLength(2);
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["accepted", "skipped", "accepted"]);
  });
  it("spaces moves to use at most half of the game's advertised request allowance", async () => {
    vi.useFakeTimers();
    // Seven game requests a move within 60 of the game's 120 a minute: one move every 7 seconds.
    live.capabilities.limits = { maxRequestsPerMinutePerIp: 120 };
    answer(() => ({ state: "applied", message: "Confirmed" }));
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await flush();
    expect(sent()).toHaveLength(1);
    await flush(6999);
    expect(sent()).toHaveLength(1);
    await flush(1);
    expect(sent()).toHaveLength(2);
    expect(finished.mock.calls[0][0].stopped).toBe(false);
  });
});
