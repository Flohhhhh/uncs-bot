import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MapVotesPage } from "./map-votes-page";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const settings = {
  revision: "r1",
  rotation: { editable: true, enabled: true, mode: "Ordered", currentIndex: 0, currentMap: "Kavkazi" },
};
const ballot = {
  id: "d0a3cdd7-a1c7-4904-a99e-cf058b432c34",
  serverId: "primary",
  serverName: "The UNCs",
  actorName: "Admin",
  reason: "Map night",
  choices: [
    { map: "Europe", experiences: [] },
    { map: "Islands", experiences: [] },
  ],
  counts: [0, 0],
  counted: false,
  winner: null,
  createdAt: "2026-10-01T10:00:00Z",
  closesAt: "2026-10-01T10:05:00Z",
  state: "open",
  message: "Voting is open.",
  cancellation: null,
  messageUrl: "https://discord.com/channels/123456789012345678/234567890123456789/345678901234567890",
};
let enabled: boolean;
let votes: (typeof ballot)[];
beforeEach(() => {
  vi.clearAllMocks();
  enabled = true;
  votes = [];
  settings.revision = "r1";
  request.mockImplementation(async (path, init) => {
    if (init?.method === "POST") return { ...ballot, message: "Voting is open." } as never;
    if (path === "map-votes") return { enabled, serverId: "primary", votes } as never;
    if (path === "settings") return structuredClone(settings) as never;
    if (path === "catalog")
      return {
        maps: [{ id: "Kavkazi" }, { id: "Europe" }, { id: "Islands" }, { id: "Desert" }],
        experiences: [],
        lightings: [],
      } as never;
    if (path.startsWith("catalog/maps/")) return { experiences: [], zones: null } as never;
    throw new Error(`Unexpected ${path}`);
  });
});
function show(role: "admin" | "viewer" | "moderator" = "admin") {
  const state = context();
  state.me.role = role;
  const view = render(
    <AdminContext.Provider value={state}>
      <MapVotesPage />
    </AdminContext.Provider>,
    { wrapper: ({ children }) => <MemoryRouter initialEntries={["/votes?server=primary"]}>{children}</MemoryRouter> },
  );
  return { ...view, state };
}
async function choose(map: string) {
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: map } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Add map option" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Add map option" }));
}
it("cannot add a ballot choice while its map options are pending or unavailable", async () => {
  const original = request.getMockImplementation()!;
  let reject!: (error: Error) => void;
  request.mockImplementation((path, init) =>
    path.startsWith("catalog/maps/")
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : original(path, init),
  );
  show();
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  const add = screen.getByRole("button", { name: "Add map option" });
  expect(add).toBeDisabled();
  reject(new Error("Map options unavailable"));
  await screen.findByText("Map options unavailable");
  expect(add).toBeDisabled();
  expect(screen.getByRole("button", { name: "Review ballot" })).toBeDisabled();
});
it.each(["viewer", "moderator"] as const)("does not read private votes for %s", (role) => {
  show(role);
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
it("does not query settings or catalog when disabled", async () => {
  enabled = false;
  show();
  await screen.findByRole("heading", { name: "Discord map voting is off" });
  expect(screen.getByRole("link", { name: "Open match & maps" })).toHaveAttribute("href", "/match?server=primary");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["map-votes"]);
});
it("excludes the current map and duplicate choices, and requires two options", async () => {
  show();
  const picker = await screen.findByRole("combobox", { name: "Map" });
  expect(within(picker).queryByRole("option", { name: "Kavkazi" })).not.toBeInTheDocument();
  await choose("Europe");
  expect(screen.getByRole("button", { name: "Review ballot" })).toBeDisabled();
  expect(within(picker).queryByRole("option", { name: "Europe" })).not.toBeInTheDocument();
  await choose("Islands");
  expect(screen.getByRole("button", { name: "Review ballot" })).toBeEnabled();
});
it("reviews a frozen ballot without extra typing and sends exactly one request", async () => {
  show();
  await choose("Europe");
  await choose("Islands");
  fireEvent.click(screen.getByRole("button", { name: "Review ballot" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("Ties use the first listed option");
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  const publish = within(dialog).getByRole("button", { name: "Publish ballot" });
  fireEvent.click(publish);
  fireEvent.click(publish);
  await within(dialog).findByText("Voting is open.");
  const sent = request.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(String(sent[0][1]?.body))).toMatchObject({
    serverId: "primary",
    revision: "r1",
    minutes: 5,
    reason: "Staff started map vote.",
    choices: ballot.choices,
  });
  expect(within(dialog).queryByRole("button", { name: "Publish ballot" })).not.toBeInTheDocument();
});
it("keeps uncertain requests reviewable without offering an automatic retry", async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (path, init) => {
    if (init?.method === "POST") throw new Error("Connection lost");
    return original(path, init);
  });
  show();
  await choose("Europe");
  await choose("Islands");
  fireEvent.click(screen.getByRole("button", { name: "Review ballot" }));
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Publish ballot" }));
  await screen.findByText(/This request will not be sent again/);
  expect(screen.getByRole("button", { name: /Copy ballot receipt/ })).toBeInTheDocument();
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("protects an unfinished selection and discards it explicitly", async () => {
  const { state } = show();
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  await waitFor(() => expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await waitFor(() => expect(state.setUnsavedChanges).toHaveBeenLastCalledWith(false));
});
it("blocks a draft after settings change instead of silently adopting a new revision", async () => {
  const { state, rerender } = show();
  await choose("Europe");
  await choose("Islands");
  settings.revision = "r2";
  rerender(
    <AdminContext.Provider value={{ ...state, refreshVersion: 1 }}>
      <MapVotesPage />
    </AdminContext.Provider>,
  );
  await screen.findByText("Server settings changed. Discard this draft and refresh.");
  expect(screen.getByRole("button", { name: "Review ballot" })).toBeDisabled();
});
it("shows saved results and closes an active ballot with a separate recorded request", async () => {
  votes = [ballot];
  show();
  await screen.findByText(/An active ballot/);
  expect(request.mock.calls.map(([path]) => path)).toEqual(["map-votes"]);
  expect(screen.queryByRole("button", { name: "Review ballot" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /View in Discord/ })).toHaveAttribute("href", ballot.messageUrl);
  fireEvent.click(screen.getByRole("button", { name: "Close ballot" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("This does not undo a queued map");
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  await screen.findByText("Voting is open.");
  const sent = request.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(sent[0]).toBe(`map-votes/${ballot.id}/cancel`);
  expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ reason: "Staff closed map vote.", id: expect.any(String) });
});
it("does not invent a zero-vote total when staff close an uncounted ballot", async () => {
  votes = [{ ...ballot, state: "cancelled", message: "Closed before counting." }];
  show();
  const table = await screen.findByRole("table", { name: "Map votes" });
  expect(within(table).queryByText(/0 votes/)).not.toBeInTheDocument();
  expect(within(table).getByText("Closed before counting.")).toBeInTheDocument();
});
