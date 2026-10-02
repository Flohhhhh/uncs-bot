import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { TeamMoveDialog, type TeamMoveResult } from "./team-move";
import { alice, bob, cara, context } from "./test-fixtures";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
beforeEach(() => {
  request.mockReset();
});
afterEach(() => vi.useRealTimers());
function submit() {
  fireEvent.submit(screen.getByRole("button", { name: /^Move \d/ }).closest("form")!);
}

describe("reviewed team moves", () => {
  it("stops unsent moves while allowing the current request to keep its actual outcome", async () => {
    let finish!: (result: unknown) => void;
    request.mockImplementation(
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
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Any request already sent will finish");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]?.signal).toBeUndefined();
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
    expect(request).toHaveBeenCalledOnce();
  });
  it("stops during the gap between requests without sending another move", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "applied", message: "Confirmed" });
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2199);
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(request).toHaveBeenCalledOnce();
    expect(finished.mock.calls[0][0]).toMatchObject({
      stopped: true,
      items: [{ state: "applied" }, { state: "queued" }],
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped at your request");
  });
  it("keeps an uncertain in-flight outcome when stopping and never offers a resend", async () => {
    let reject!: (failure: Error) => void;
    request.mockImplementation(
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
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining moves" }));
    await act(async () => reject(new Error("Network dropped")));
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["unknown", "queued"]);
    expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move \d/ })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not offer a stop for a single request that has already been sent", async () => {
    let finish!: (result: unknown) => void;
    request.mockImplementation(
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
    expect(screen.queryByRole("button", { name: "Stop remaining moves" })).not.toBeInTheDocument();
    await act(async () => finish({ state: "applied", message: "Confirmed" }));
    expect(screen.getByRole("heading", { name: "Team requests complete" })).toBeInTheDocument();
  });
  it("sends each player with a unique ID, exact confirmation and faction name, spaced sequentially", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "applied", message: "Assignment confirmed; respawn may be needed." });
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    submit();
    await act(async () => {
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2199);
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(request).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(request.mock.calls[0][1]?.body));
    const second = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(first).toMatchObject({
      action: "team",
      faction: "Lonestar",
      steamId: alice.steamId,
      confirm: alice.steamId,
      reason: "Staff requested team move.",
    });
    expect(second).toMatchObject({ action: "team", faction: "Lonestar", steamId: bob.steamId, confirm: bob.steamId });
    expect(first.id).not.toBe(second.id);
    expect(finished.mock.calls[0][0].stopped).toBe(false);
    expect(screen.queryByRole("button", { name: /^Move \d/ })).not.toBeInTheDocument();
  });
  it.each(["failed", "unknown"] as const)("stops after %s and keeps remaining players unsent", async (state) => {
    request.mockResolvedValue({ state, message: "Check the action" });
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={admin}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual([state, "queued"]);
    expect(admin.invalidateOverview).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("will not be retried automatically");
  });
  it("never resends on double submission and reports transport failure as unknown", async () => {
    let reject!: (error: Error) => void;
    request.mockImplementation(
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
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Network dropped")));
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["unknown", "queued"]);
    expect(screen.getByRole("alert")).toHaveTextContent("remaining requests");
  });
  it("does not send a request for someone already on the destination", async () => {
    request.mockResolvedValue({ state: "accepted", message: "Accepted, not verified" });
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[cara, alice]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>,
    );
    submit();
    await waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["skipped", "accepted"]);
    expect(screen.getByText("Accepted · not verified")).toBeInTheDocument();
  });
  it("stops remaining requests if authority becomes stale during the spacing delay", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "applied", message: "Confirmed" });
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    const tree = (stale: boolean) => (
      <AdminContext.Provider value={{ ...admin, stale }}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(false));
    submit();
    await act(async () => {
      await Promise.resolve();
    });
    rerender(tree(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0].stopped).toBe(true);
    expect(finished.mock.calls[0][0].items[1].state).toBe("queued");
  });
  it("cancels the remaining batch when its dialog is unmounted", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "applied", message: "Confirmed" });
    const { unmount } = render(
      <AdminContext.Provider value={context()}>
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    submit();
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["left", "changed team"])("stops when the latest roster shows a queued player %s", async (change) => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "applied", message: "Confirmed" });
    const admin = context();
    const finished = vi.fn<(result: TeamMoveResult) => void>();
    const tree = (changed: boolean) => (
      <AdminContext.Provider
        value={{
          ...admin,
          overview: {
            ...admin.overview!,
            players: changed
              ? change === "left"
                ? [alice, cara]
                : [alice, { ...bob, faction: "BLU" }, cara]
              : admin.overview!.players,
          },
        }}
      >
        <TeamMoveDialog players={[alice, bob]} initialFaction="Lonestar" onClose={vi.fn()} onComplete={finished} />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(false));
    submit();
    await act(async () => {
      await Promise.resolve();
    });
    rerender(tree(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0].stopped).toBe(true);
    expect(finished.mock.calls[0][0].items[1].state).toBe("queued");
  });
  it("does not add a request-spacing delay for players already on the destination", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "accepted", message: "Accepted, not verified" });
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(finished.mock.calls[0][0].items.map((item) => item.state)).toEqual(["accepted", "skipped", "accepted"]);
  });
});
