import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import type { SettingsSnapshot } from "../../../../../src/common/server-settings";
import { MatchPage } from "./match-page";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const sample: SettingsSnapshot = {
  revision: "r1",
  writable: true,
  notice: "",
  scoreTick: null,
  fields: [],
  rotation: {
    editable: true,
    note: "",
    currentIndex: 0,
    nextIndex: 1,
    currentMap: "Kavkazi",
    enabled: true,
    mode: "Ordered",
    entries: [
      { map: "Kavkazi", experiences: [] },
      { map: "Europe", experiences: ["KOTH_InfantryOnly"] },
    ],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async (path) => {
    if (path === "settings") return structuredClone(sample) as never;
    if (path === "map-votes") return { enabled: false, serverId: "primary", votes: [] } as never;
    if (path === "map-votes/controls")
      return { serverId: "primary", version: 0, available: true, ready: false, message: "Voting is off." } as never;
    if (path === "settings/rotation-check") return { revision: "r1", total: 2, issues: [] } as never;
    if (path === "catalog")
      return {
        maps: [{ id: "Kavkazi" }, { id: "Europe" }],
        lightings: [{ id: "DayClear" }],
        experiences: [{ id: "KOTH_InfantryOnly" }],
      } as never;
    if (path.startsWith("catalog/maps/")) return { experiences: [{ id: "KOTH_InfantryOnly" }], zones: null } as never;
    if (path === "actions") return { state: "pending", message: "Saved for next match." } as never;
    throw new Error(`Unexpected path ${path}`);
  });
});
function hub(view: "next" | "rotation", state = context(), refreshVersion = 0) {
  return (
    <MemoryRouter initialEntries={[`/match?server=primary&view=${view}`]}>
      <AdminContext.Provider value={{ ...state, refreshVersion }}>
        <MatchPage />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
function withSettings(change: (snapshot: SettingsSnapshot) => void) {
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    if (path !== "settings") return fallback(path, options);
    const snapshot = structuredClone(sample);
    change(snapshot);
    return snapshot as never;
  });
}
const queueRows = () => within(screen.getByRole("list", { name: "Rotation queue" })).getAllByRole("listitem");
const queueMarkers = () =>
  within(screen.getByRole("list", { name: "Rotation queue" }))
    .queryAllByText(/^(Now|Next)$/)
    .map((marker) => marker.textContent);
const sent = () => request.mock.calls.filter(([path]) => path === "actions");

it("lists the queue first and marks Now and Next only while the position is confirmed", async () => {
  render(hub("rotation"));
  const queue = await screen.findByRole("list", { name: "Rotation queue" });
  const rows = queueRows();
  expect(within(rows[0]).getByText("Now")).toBeInTheDocument();
  expect(within(rows[1]).getByText("Next")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Map" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /into rotation/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Drop here/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check saved rotation" })).not.toBeInTheDocument();
  expect(
    queue.compareDocumentPosition(screen.getByRole("button", { name: "+ Add map" })) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move Ozeti up" }));
  expect(queueMarkers()).toEqual([]);
  const savebar = screen.getByRole("button", { name: "Review rotation" }).closest(".settings-savebar")!;
  expect(savebar.closest(".card")).toBeNull();
  expect(queue.compareDocumentPosition(savebar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sent()).toHaveLength(0);
});
it("marks no position when the running map does not match the saved entry", async () => {
  withSettings((snapshot) => {
    snapshot.rotation.currentMap = "Europe";
  });
  render(hub("rotation"));
  await screen.findByRole("list", { name: "Rotation queue" });
  expect(queueMarkers()).toEqual([]);
});
it("edits an entry under its own row with labeled icon buttons", async () => {
  render(hub("rotation"));
  await screen.findByRole("list", { name: "Rotation queue" });
  const edit = screen.getByRole("button", { name: "Edit Ozeti" });
  expect(edit).toHaveTextContent("✎");
  expect(screen.getByRole("button", { name: "Remove Ozeti" })).toHaveTextContent("✕");
  fireEvent.click(edit);
  // The map picker loads its catalog options asynchronously, so wait for it before checking the row.
  await waitFor(() => expect(within(queueRows()[1]).getByRole("combobox", { name: "Map" })).toHaveValue("Europe"));
  const row = queueRows()[1];
  expect(within(row).getByRole("button", { name: "Update entry" })).toBeInTheDocument();
  expect(within(queueRows()[0]).queryByRole("combobox", { name: "Map" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove Ozeti" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit Bakurani" })).toBeDisabled();
  expect(screen.getByRole("tab", { name: "Next round" })).toBeDisabled();
});
it("adds a map at the end of the rotation from + Add map", async () => {
  const state = context();
  render(hub("rotation", state));
  fireEvent.click(await screen.findByRole("button", { name: "+ Add map" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  await waitFor(() => expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(true));
  const add = screen.getByRole("button", { name: "Add to rotation" });
  await waitFor(() => expect(add).toBeEnabled());
  expect(add.closest(".map-picker-footer")).toHaveTextContent("Ozeti");
  fireEvent.click(add);
  expect(queueRows()).toHaveLength(3);
  expect(queueRows()[2]).toHaveTextContent("Ozeti");
  expect(screen.queryByRole("combobox", { name: "Map" })).not.toBeInTheDocument();
  expect(screen.getByText("Unsaved rotation · 3 rounds")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  expect(within(screen.getByRole("dialog")).getAllByRole("listitem")[2]).toHaveTextContent("3. Ozeti · Map defaults");
  expect(sent()).toHaveLength(0);
});
it("keeps the rotation map picker usable while a background refresh is pending", async () => {
  const state = context();
  const page = render(hub("rotation", state));
  fireEvent.click(await screen.findByRole("button", { name: "+ Add map" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Add to rotation" })).toBeEnabled());
  const fallback = request.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  request.mockImplementation(async (path, options) => {
    await held;
    return fallback(path, options);
  });
  page.rerender(hub("rotation", state, 1));
  await waitFor(() =>
    expect(request.mock.calls.filter(([path]) => ["catalog", "catalog/maps/Europe"].includes(path))).toHaveLength(4),
  );
  expect(screen.getByRole("combobox", { name: "Map" })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: "Infantry only" })).toBeEnabled();
  const add = screen.getByRole("button", { name: "Add to rotation" });
  expect(add).toBeEnabled();
  fireEvent.click(add);
  expect(queueRows()).toHaveLength(3);
  await act(async () => release());
  expect(sent()).toHaveLength(0);
});
it("preserves reordered maps after a rejected rotation save", async () => {
  render(hub("rotation"));
  fireEvent.click(await screen.findByRole("button", { name: "Move Ozeti up" }));
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) =>
    path === "actions" ? ({ state: "failed", message: "Rotation rejected" } as never) : fallback(path, options),
  );
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save rotation" }));
  await screen.findByText("Rotation rejected");
  fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
  expect(screen.getByRole("button", { name: "Review rotation" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  const changes = within(screen.getByRole("dialog")).getAllByRole("listitem");
  expect(changes[0]).toHaveTextContent("Ozeti");
});
it("retries failed map choices without discarding the rotation draft or sending changes", async () => {
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    if (path === "catalog") throw new Error("Catalog read failed");
    return fallback(path, options);
  });
  render(hub("rotation"));
  fireEvent.click(await screen.findByRole("button", { name: "Move Ozeti up" }));
  const retry = await screen.findByRole("button", { name: "Retry map choices" });
  fireEvent.click(screen.getByRole("button", { name: "+ Add map" }));
  expect(screen.queryByRole("combobox", { name: "Map" })).not.toBeInTheDocument();
  expect(screen.getByText("Map choices are unavailable.")).toBeInTheDocument();
  let finish!: (value: unknown) => void;
  request.mockImplementation(
    async (path, options) =>
      (path === "catalog"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : fallback(path, options)) as never,
  );
  fireEvent.click(retry);
  expect(retry).toBeDisabled();
  expect(screen.getByText("Catalog read failed")).toBeInTheDocument();
  await act(async () => finish(await fallback("catalog")));
  expect(await screen.findByRole("combobox", { name: "Map" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry map choices" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  expect(within(screen.getByRole("dialog")).getAllByRole("listitem")[0]).toHaveTextContent("Ozeti");
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it.each(["Kavkazi", "Bakurani"])(
  "queues a map with live %s independently of ending the current match",
  async (currentMap) => {
    withSettings((snapshot) => {
      snapshot.rotation.currentMap = currentMap;
    });
    render(hub("next"));
    fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
    await screen.findByRole("checkbox", { name: "Infantry only" });
    const queue = screen.getByRole("button", { name: "Queue next map" });
    await waitFor(() => expect(queue).toBeEnabled());
    expect(queue.closest(".map-picker-footer")).toHaveTextContent("Selected: Ozeti");
    fireEvent.click(queue);
    const dialog = screen.getByRole("dialog");
    expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Queue next map" }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(JSON.parse(String(sent()[0][1]?.body))).toMatchObject({
      action: "map-next",
      currentMap,
      currentIndex: 0,
      entry: { map: "Europe" },
    });
  },
);
it("shows the game's own next entry and keeps queuing until that round starts", async () => {
  const note =
    "This match was not started from the rotation, so the game will play entry 1 next. Queue a map once that round starts.";
  withSettings((snapshot) => {
    Object.assign(snapshot.rotation, { currentIndex: null, nextIndex: 0, currentMap: "Bakurani", positionNote: note });
  });
  render(hub("next"));
  const summary = within(screen.getByRole("region", { name: "Current match" }));
  expect(await summary.findByText("Game's next rotation entry")).toBeInTheDocument();
  expect(screen.getByText(note)).toBeInTheDocument();
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  await screen.findByRole("checkbox", { name: "Infantry only" });
  expect(screen.getByRole("button", { name: "Queue next map" })).toBeDisabled();
  fireEvent.click(screen.getByRole("tab", { name: "Rotation" }));
  const rows = queueRows();
  expect(within(rows[0]).getByText("Next")).toBeInTheDocument();
  expect(queueMarkers()).toEqual(["Next"]);
  expect(sent()).toHaveLength(0);
});
it("explains a missing position and refreshes it without losing the chosen map or sending an action", async () => {
  let available = false;
  withSettings((snapshot) => {
    if (available) return;
    snapshot.rotation.currentIndex = null;
    snapshot.rotation.nextIndex = null;
    snapshot.rotation.positionNote = "The running rotation could not be read. Refresh to try again.";
  });
  render(hub("next"));
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Infantry only" }));
  expect(screen.getByText("The running rotation could not be read. Refresh to try again.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Queue next map" })).toBeDisabled();
  available = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh map position" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Queue next map" })).toBeEnabled());
  expect(screen.getByRole("combobox", { name: "Map" })).toHaveValue("Europe");
  expect(screen.getByRole("checkbox", { name: "Infantry only" })).toBeChecked();
  expect(sent()).toHaveLength(0);
});
it("preserves a rotation draft across views and edits the original position", async () => {
  render(hub("rotation"));
  fireEvent.click(await screen.findByRole("button", { name: "Edit Bakurani" }));
  expect(screen.getByRole("button", { name: "Remove Ozeti" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move Ozeti up" })).toBeDisabled();
  fireEvent.change(await screen.findByRole("combobox", { name: "Lighting" }), { target: { value: "DayClear" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Update entry" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Update entry" }));
  fireEvent.click(screen.getByRole("tab", { name: "Voting" }));
  await screen.findByRole("heading", { name: "Discord map voting is off" });
  fireEvent.click(screen.getByRole("tab", { name: "Rotation" }));
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("1. Bakurani · Day · clear")).toBeInTheDocument();
  expect(within(dialog).getByText("2. Ozeti · Infantry only")).toBeInTheDocument();
  expect(sent()).toHaveLength(0);
});
it.each([false, true])(
  "retains Infantry Only edits across a refresh and blocks only a changed rotation (%s)",
  async (rotationChanged) => {
    const state = context();
    const page = render(hub("rotation", state));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Bakurani" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Infantry only" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Update entry" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Update entry" }));
    withSettings((snapshot) => {
      snapshot.revision = "r2";
      if (rotationChanged) snapshot.rotation.entries.reverse();
    });
    page.rerender(hub("rotation", state, 1));
    await screen.findByText(rotationChanged ? /The saved rotation changed/ : /Other settings changed/);
    expect(screen.getByRole("list", { name: "Rotation queue" })).toHaveTextContent("Infantry only");
    const review = screen.getByRole("button", { name: "Review rotation" });
    if (rotationChanged) expect(review).toBeDisabled();
    else {
      expect(review).toBeEnabled();
      fireEvent.click(review);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save rotation" }));
      await screen.findByText("Saved for next match.");
      expect(JSON.parse(String(sent()[0][1]?.body))).toMatchObject({
        revision: "r2",
        entries: [{ map: "Kavkazi", experiences: ["KOTH_InfantryOnly"] }, sample.rotation.entries[1]],
      });
    }
  },
);
it("does not save a cancelled or reversed edit", async () => {
  const state = context();
  render(hub("rotation", state));
  fireEvent.click(await screen.findByRole("button", { name: "Edit Bakurani" }));
  expect(screen.getByRole("tab", { name: "Next round" })).toBeDisabled();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel entry edit" }));
  // The hub re-enables its tabs once the cancelled edit's unsaved flag clears, which can land a render later.
  await waitFor(() => expect(screen.getByRole("tab", { name: "Next round" })).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Review rotation" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Move Ozeti up" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Review rotation" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Move Ozeti down" }));
  expect(screen.queryByRole("button", { name: "Review rotation" })).not.toBeInTheDocument();
  await waitFor(() => expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(false));
  expect(sent()).toHaveLength(0);
});
