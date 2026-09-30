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
  it("sends each player with a unique ID, exact confirmation and faction name, spaced sequentially", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ state: "applied", message: "Assignment confirmed; respawn may be needed." });
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
});
