import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { PlayersPage } from "./players-page";
import { alice, bob, context, overview } from "./test-fixtures";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const cleanRecord = { kicks: null, bans: null, entries: [] };
// A block body: a function returned from beforeEach runs as a cleanup, and mockReset returns the mock itself.
beforeEach(() => {
  request.mockReset();
  // The player panel reads the player's kick and ban record; a clean record adds nothing to it.
  request.mockImplementation(async (path) => (path.startsWith("moderation/") ? cleanRecord : undefined) as never);
});
afterEach(() => vi.useRealTimers());

function tree(admin: AdminContextValue, children: ReactNode = <PlayersPage />) {
  return (
    <MemoryRouter initialEntries={["/players?server=primary"]}>
      <AdminContext.Provider value={admin}>{children}</AdminContext.Provider>
    </MemoryRouter>
  );
}
function show(admin = context()) {
  return render(tree(admin));
}
function teamChip(name: RegExp) {
  return within(screen.getByRole("group", { name: "Filter players by team" })).getByRole("button", { name });
}
function openPanel(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}
/** The panel's always-present notice region; the SteamID copy button has its own status line. */
function availability(panel: HTMLElement) {
  return within(panel)
    .getAllByRole("status")
    .find((region) => !region.closest(".copy-value"))!;
}

describe("live player controls", () => {
  it("does not claim an empty roster while waiting for the first response", () => {
    show({ ...context(), overview: null });
    expect(screen.getByText("Waiting for the player list")).toBeInTheDocument();
    expect(screen.queryByText("0 players shown")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching players")).not.toBeInTheDocument();
  });
  it("keeps rows to the essentials and moves cash into the player panel", () => {
    const state = context();
    state.overview!.players[1].cash = 10000;
    show(state);
    const table = screen.getByRole("table", { name: "Live players" });
    expect(within(table).queryByText(/Cash/)).not.toBeInTheDocument();
    expect(within(table).queryByText(bob.steamId)).not.toBeInTheDocument();
    const row = within(table).getByRole("button", { name: bob.name }).closest("tr")!;
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
    const panel = openPanel(bob.name);
    expect(within(panel).getByText("Cash").nextSibling).toHaveTextContent("10,000");
    expect(within(panel).getByText(bob.steamId)).toBeInTheDocument();
  });
  it("sorts reported ping numerically and leaves unknown values last", () => {
    const state = context();
    state.overview!.players[0].pingMs = 140;
    state.overview!.players[1].pingMs = 25;
    state.overview!.players[2].pingMs = undefined;
    show(state);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Ping" }));
    const rows = within(screen.getByRole("table", { name: "Live players" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[0]).toHaveTextContent("Bob");
    expect(rows[1]).toHaveTextContent("UNC Alice");
    expect(rows[2]).toHaveTextContent("Cara");
  });
  it("finds pasted IDs and names with surrounding spaces", () => {
    show();
    for (const query of [` ${alice.steamId} `, "  unc alice  "]) {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
      expect(screen.getByText(alice.name)).toBeInTheDocument();
      expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    }
  });
  it("discloses excluded unlinked entries without inventing selectable identities", () => {
    const admin = context();
    admin.overview!.unlinkedPlayerCount = 2;
    show(admin);
    expect(screen.getByRole("status", { name: "Incomplete player roster" })).toHaveTextContent(
      "2 roster entries have no usable SteamID.",
    );
    expect(screen.getByRole("status", { name: "Incomplete player roster" })).toHaveTextContent(
      "team counts below exclude them",
    );
    fireEvent.click(screen.getByLabelText("Select all shown players"));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });
  it("shows team counts as filter chips and the move bar only while players are selected", () => {
    show();
    expect(teamChip(/^All 3$/)).toHaveAttribute("aria-pressed", "true");
    expect(teamChip(/Red · Valkyra 2/)).toHaveAttribute("aria-pressed", "false");
    expect(teamChip(/Blue · Lonestar 1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review move" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select Bob"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review move" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review move" })).not.toBeInTheDocument();
  });
  it("sorts without changing selected identities and combines team filters with search", () => {
    show();
    fireEvent.click(screen.getByLabelText("Select Bob"));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Player" }));
    const table = screen.getByRole("table", { name: "Live players" });
    const first = within(table).getAllByRole("row")[1];
    expect(within(first).getByText("Bob")).toBeInTheDocument();
    expect(screen.getByLabelText("Select Bob")).toBeChecked();
    fireEvent.click(teamChip(/Lonestar/));
    expect(teamChip(/Lonestar/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Cara")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.getByText("1 selected (includes hidden players)")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alice" } });
    expect(screen.getByText("No matching players")).toBeInTheDocument();
    fireEvent.click(teamChip(/^All/));
    expect(screen.getByText(alice.name)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getByLabelText("Select Bob")).toBeChecked();
  });
  it("shows a filtered team that left the match so All can clear it", () => {
    const view = show();
    fireEvent.click(teamChip(/Lonestar/));
    expect(screen.getByRole("heading", { name: "1 player shown" })).toBeInTheDocument();
    const next = context();
    next.overview!.status.factionScores = next.overview!.status.factionScores.filter(
      (team) => team.name !== "Lonestar",
    );
    view.rerender(tree(next));
    expect(teamChip(/^Lonestar \(not in this match\) 0$/)).toHaveAttribute("aria-pressed", "true");
    expect(teamChip(/^All 3$/)).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "0 players shown" })).toBeInTheDocument();
    fireEvent.click(teamChip(/^All 3$/));
    expect(
      within(screen.getByRole("group", { name: "Filter players by team" })).queryByRole("button", {
        name: /not in this match/,
      }),
    ).not.toBeInTheDocument();
    expect(teamChip(/^All 3$/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "3 players shown" })).toBeInTheDocument();
  });
  it("keeps the Unassigned filter visible after its players have joined a team", () => {
    const admin = context();
    admin.overview!.players[2] = { ...admin.overview!.players[2], faction: "" };
    const view = show(admin);
    fireEvent.click(teamChip(/^Unassigned 1$/));
    expect(screen.getByRole("heading", { name: "1 player shown" })).toBeInTheDocument();
    view.rerender(tree(context()));
    expect(teamChip(/^Unassigned 0$/)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(teamChip(/^All 3$/));
    expect(
      within(screen.getByRole("group", { name: "Filter players by team" })).queryByRole("button", {
        name: /Unassigned/,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3 players shown" })).toBeInTheDocument();
  });
  it("limits the UNC shortcut to player names while keeping hidden selections visible", () => {
    const admin = context();
    admin.overview!.status.factionScores[0].name = "UNC faction";
    show(admin);
    fireEvent.click(screen.getByLabelText("Select Bob"));
    const unc = screen.getByRole("button", { name: "UNC in name" });
    fireEvent.click(unc);
    expect(unc).toHaveAttribute("aria-pressed", "true");
    expect(unc).toHaveAttribute("title", expect.stringContaining("does not verify community membership"));
    expect(screen.getByRole("heading", { name: "1 player shown" })).toBeInTheDocument();
    expect(screen.getByText("1 selected (includes hidden players)")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select all shown players"));
    expect(screen.getByText("2 selected (includes hidden players)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Destination team for selected players"), { target: { value: "Lonestar" } });
    fireEvent.click(screen.getByRole("button", { name: "Review move" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Bob")).toBeInTheDocument();
    expect(within(dialog).getByText("UNC Alice")).toBeInTheDocument();
    fireEvent.click(unc);
    expect(screen.getByRole("heading", { name: "3 players shown" })).toBeInTheDocument();
  });
  it("offers one live-named team button per other team in the player panel", () => {
    show();
    const panel = openPanel(alice.name);
    expect(within(panel).getByText("Red · Valkyra")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Move to Red · Valkyra" })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Move to Blue · Lonestar" }));
    const review = screen.getAllByRole("dialog").find((dialog) => dialog !== panel)!;
    expect(within(review).getByText(alice.steamId)).toBeInTheDocument();
    expect(within(review).getByRole("combobox")).toHaveValue("Lonestar");
    expect(panel).toBeInTheDocument();
  });
  it("keeps viewer controls disabled and escapes player names as text", () => {
    const admin = context();
    admin.me.role = "viewer";
    admin.overview!.players[0] = { ...alice, name: "<img src=x onerror=alert(1)>" };
    const { container } = show(admin);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByLabelText("Select all shown players")).toBeDisabled();
    const panel = openPanel("<img src=x onerror=alert(1)>");
    // Check again only reads the server, as the dashboard's Refresh does for a viewer.
    const actions = within(panel)
      .getAllByRole("button")
      .filter(
        (button) =>
          !["Close panel", `Copy SteamID ${alice.steamId}`].includes(button.getAttribute("aria-label")!) &&
          button.textContent !== "Check again",
      );
    expect(actions.length).toBeGreaterThan(4);
    expect(actions.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(within(panel).getByRole("link", { name: "Combat history →" })).toBeInTheDocument();
  });
  it("opens the existing action review and keeps the panel open behind it", () => {
    const admin = context();
    show(admin);
    const panel = openPanel(alice.name);
    expect(within(panel).getByRole("heading", { name: alice.name })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Message player" }));
    expect(admin.openAction).toHaveBeenCalledWith("message", alice.steamId);
    fireEvent.click(within(panel).getByRole("button", { name: "Ban player" }));
    expect(admin.openAction).toHaveBeenLastCalledWith("ban", alice.steamId);
    expect(panel).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("links to the player's combat history and actions on the selected server", () => {
    show();
    const panel = openPanel(alice.name);
    expect(within(panel).getByRole("link", { name: "Combat history →" })).toHaveAttribute(
      "href",
      `/activity?server=primary&view=combat&player=${alice.steamId}`,
    );
    expect(within(panel).getByRole("link", { name: "Actions on this player →" })).toHaveAttribute(
      "href",
      `/activity?server=primary&view=actions&player=${alice.steamId}`,
    );
  });
  it.each(["unmatched", "refused"])(
    "keeps a player skipped as %s selected after the batch because no move was sent",
    async (state) => {
      vi.useFakeTimers();
      const live = overview();
      // Bob changes team during the batch: the dialog's own roster read sees it, or the server refuses the move.
      if (state === "unmatched") live.players[1] = { ...bob, faction: "GRN" };
      request.mockImplementation(async (path, options) =>
        path === "overview"
          ? live
          : JSON.parse(String(options?.body)).steamId === bob.steamId
            ? {
                state: "failed",
                changed: false,
                message: "The player's team changed before this move. No move was sent.",
              }
            : { state: "applied", changed: true, message: "Confirmed" },
      );
      show();
      fireEvent.click(screen.getByLabelText("Select UNC Alice"));
      fireEvent.click(screen.getByLabelText("Select Bob"));
      fireEvent.change(screen.getByLabelText("Destination team for selected players"), {
        target: { value: "Lonestar" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Review move" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.submit(
        within(dialog)
          .getByRole("button", { name: /^Move 2 players/ })
          .closest("form")!,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2200);
      });
      expect(within(dialog).getByRole("heading", { name: "Team requests complete" })).toBeInTheDocument();
      expect(within(dialog).getByRole("row", { name: /^Bob/ })).toHaveTextContent("Skipped · roster changed");
      expect(dialog).toHaveTextContent("1 not sent.");
      expect(screen.getByLabelText("Select Bob")).toBeChecked();
      expect(screen.getByLabelText("Select UNC Alice")).not.toBeChecked();
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    },
  );
  it("says why every player action is disabled when the snapshot expires with the panel open", () => {
    const admin = context();
    const view = (stale: boolean) => tree({ ...admin, stale });
    const { rerender } = render(view(false));
    const panel = openPanel(alice.name);
    // A live region inserted with its text already in it may not be announced, so it waits in the panel empty.
    const status = availability(panel);
    expect(status).toBeEmptyDOMElement();
    rerender(view(true));
    const message = within(panel).getByRole("button", { name: "Message player" });
    expect(message).toBeDisabled();
    expect(availability(panel)).toBe(status);
    expect(status).toHaveTextContent("Server details need a fresh check before choosing an action.");
    expect(message).toHaveAccessibleDescription(/fresh check/);
    expect(within(panel).getByRole("button", { name: "Move to Blue · Lonestar" })).toHaveAccessibleDescription(
      /fresh check/,
    );
    // The page's own refresh is behind the panel, so the panel offers the check itself.
    fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
    expect(admin.refresh).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["the staff role", "Add whitelist access", () => context({ me: { ...context().me!, role: "moderator" } })],
    [
      "the server build",
      "Force player respawn",
      () => {
        const admin = context();
        const { capabilities } = admin.overview!;
        capabilities.routes = capabilities.routes.filter((route) => !route.endsWith("/kill"));
        return admin;
      },
    ],
  ])("says why a player action is off for %s", (_cause, label, setup) => {
    show(setup());
    const panel = openPanel(alice.name);
    const off = within(panel).getByRole("button", { name: label, hidden: true });
    const message = within(panel).getByRole("button", { name: "Message player" });
    expect(off).toBeDisabled();
    expect(availability(panel)).toHaveTextContent(
      "Some actions are unavailable for your role, connection, or server build.",
    );
    expect(off).toHaveAccessibleDescription(/your role, connection, or server build/);
    expect(message).toBeEnabled();
    expect(message).not.toHaveAccessibleDescription();
    // Only some actions are off and the live roster is current, so the panel offers no check.
    expect(within(panel).queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });
  it.each([
    [
      "a viewer",
      () => {
        const admin = context();
        admin.me.role = "viewer";
        return admin;
      },
    ],
    [
      "a server that offers no player actions",
      () => {
        const admin = context();
        admin.overview!.capabilities.routes = [];
        return admin;
      },
    ],
  ])("says why every player action is off for %s and offers the panel's own check", (_cause, setup) => {
    const admin = setup();
    const view = (state: Partial<AdminContextValue>) => tree({ ...admin, ...state });
    const { rerender } = render(view({}));
    const panel = openPanel(alice.name);
    const status = availability(panel);
    // The dashboard's Refresh is behind the panel, so the advice points at the panel's own check.
    expect(status).toHaveTextContent(
      "Unavailable for your role, connection, or server build. Check again to read the server's current details.",
    );
    expect(status).not.toHaveTextContent(/Refresh the dashboard/);
    expect(within(panel).getByRole("button", { name: "Message player" })).toHaveAccessibleDescription(
      /your role, connection, or server build/,
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
    expect(admin.refresh).toHaveBeenCalledTimes(1);
    rerender(view({ checking: true, refreshVersion: 1 }));
    expect(status).toHaveTextContent("Checking the server for current details…");
    rerender(view({ refreshVersion: 1 }));
    expect(status).toHaveTextContent(/Check again to read the server's current details/);
  });
  it("removes player actions if the selected player leaves while the panel is open", () => {
    const admin = context();
    const view = (present: boolean) =>
      tree({ ...admin, overview: { ...admin.overview!, players: present ? [alice] : [] } });
    const { rerender } = render(view(true));
    fireEvent.click(screen.getByRole("button", { name: alice.name }));
    rerender(view(false));
    expect(screen.getByRole("dialog")).toHaveTextContent("no longer in the current roster");
    expect(screen.getByRole("dialog")).toHaveTextContent(alice.steamId);
    expect(screen.queryByRole("button", { name: "Ban player" })).not.toBeInTheDocument();
    expect(admin.openAction).not.toHaveBeenCalled();
  });
});

describe("kicks and bans in the player panel", () => {
  const lastAt = "2026-10-02T18:00:00Z";
  const day = new Date(lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const count = (total: number, lastBy: string, lastReason: string | null) => ({
    count: total,
    recent: total,
    lastAt,
    lastBy,
    lastReason,
  });
  // A kick the game takes is stored as accepted; a ban is applied once the ban list shows it.
  const entry = (index: number, action: "kick" | "ban", state = action === "ban" ? "applied" : "accepted") => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    actorName: action === "ban" ? "Admin" : "Mod",
    action,
    target: bob.steamId,
    state,
    message: "Recorded",
    createdAt: lastAt,
    details: { reason: action === "ban" ? "Cheating" : "Team killing", playerName: bob.name },
  });
  function record(value: unknown) {
    request.mockImplementation(
      async (path) => (path === `moderation/players/${bob.steamId}` ? value : cleanRecord) as never,
    );
  }

  it("shows counts with the newest kick and ban above the history links, and older ones on request", async () => {
    record({
      kicks: count(2, "Mod", "Team killing"),
      bans: count(1, "Admin", "Cheating"),
      entries: [entry(1, "ban"), entry(2, "kick", "unknown"), entry(3, "kick"), entry(4, "kick")],
    });
    show();
    const panel = openPanel(bob.name);
    const history = await within(panel).findByRole("region", { name: "Kicks and bans" });
    expect(request).toHaveBeenCalledWith(`moderation/players/${bob.steamId}`, expect.anything());
    expect(within(history).getByText(`Kicked 2 times · last ${day} by Mod: Team killing`)).toBeInTheDocument();
    expect(within(history).getByText(`Banned once · last ${day} by Admin: Cheating`)).toBeInTheDocument();
    const links = within(panel).getByRole("link", { name: "Combat history →" });
    expect(history.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const recent = within(history).getByText("Recent kicks and bans").closest("details")!;
    expect(recent).not.toHaveAttribute("open");
    const items = within(recent).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent(`${day} · Ban by Admin: Cheating`);
    // An unconfirmed kick is listed and marked; the server leaves it out of the count.
    expect(items[1]).toHaveTextContent(`${day} · Kick by Mod: Team killing Unconfirmed`);
    expect(items[2]).toHaveTextContent(new RegExp(`^${day} · Kick by Mod: Team killing$`));
  });

  it("marks only kicks and bans that may not have reached the game", async () => {
    record({
      kicks: count(1, "Mod", "Team killing"),
      bans: count(1, "Admin", "Cheating"),
      entries: [entry(1, "kick"), entry(2, "ban"), entry(3, "kick", "pending"), entry(4, "kick", "started")],
    });
    show();
    const panel = openPanel(bob.name);
    const history = await within(panel).findByRole("region", { name: "Kicks and bans" });
    const items = within(history).getAllByRole("listitem");
    // An accepted kick is the game taking it: no amber "not verified" badge.
    expect(items[0]).toHaveTextContent(new RegExp(`^${day} · Kick by Mod: Team killing$`));
    expect(items[1]).toHaveTextContent(new RegExp(`^${day} · Ban by Admin: Cheating$`));
    expect(history).not.toHaveTextContent(/Accepted|not verified|Applied/);
    expect(items[2]).toHaveTextContent(/Team killing Pending$/);
    expect(items[3]).toHaveTextContent(/Team killing Unconfirmed$/);
  });

  it("shows a single kick as one line without a list", async () => {
    record({ kicks: count(1, "Mod", null), bans: null, entries: [entry(1, "kick")] });
    show();
    const panel = openPanel(bob.name);
    const history = await within(panel).findByRole("region", { name: "Kicks and bans" });
    expect(history).toHaveTextContent(`Kicked once · last ${day} by Mod`);
    expect(history).not.toHaveTextContent("Banned");
    expect(within(history).queryByText("Recent kicks and bans")).not.toBeInTheDocument();
  });

  it("adds nothing for a clean record", async () => {
    show();
    const panel = openPanel(bob.name);
    await waitFor(() => expect(request).toHaveBeenCalledWith(`moderation/players/${bob.steamId}`, expect.anything()));
    await act(async () => {});
    expect(within(panel).queryByRole("region", { name: "Kicks and bans" })).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/Kicked|Banned|could not be loaded/);
  });

  it("says when the record could not be read", async () => {
    request.mockImplementation(async (path) => {
      if (path.startsWith("moderation/"))
        throw new Error("Kick and ban history could not be loaded. Try again shortly.");
      return undefined as never;
    });
    show();
    const panel = openPanel(bob.name);
    expect(await within(panel).findByText("Kick and ban history could not be loaded.")).toBeInTheDocument();
  });
});

describe("team move results on the roster", () => {
  async function moveBob(state: string, changed?: boolean) {
    // The dialog reads the live roster before each move; every other request is the team action.
    request.mockImplementation(async (path) =>
      path === "overview" ? overview() : { state, changed, message: "Recorded outcome" },
    );
    const admin = context();
    show(admin);
    fireEvent.click(screen.getByLabelText("Select Bob"));
    fireEvent.change(screen.getByLabelText("Destination team for selected players"), { target: { value: "Lonestar" } });
    fireEvent.click(screen.getByRole("button", { name: "Review move" }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: /^Move 1 player/ }).closest("form")!);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    return admin;
  }
  it("shows a short status line after a move with no failures", async () => {
    await moveBob("accepted");
    expect(screen.getByText("Team move to Blue · Lonestar: 1 accepted, not verified.")).toBeInTheDocument();
    expect(screen.queryByText(/Last team move/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select Bob")).not.toBeChecked();
  });
  it("counts a player the server skipped because the roster changed in the status line", async () => {
    await moveBob("failed", false);
    expect(screen.getByText("Team move to Blue · Lonestar: 1 skipped, roster changed.")).toBeInTheDocument();
    expect(screen.queryByText(/Last team move/)).not.toBeInTheDocument();
  });
  it("keeps the full results when a move fails", async () => {
    await moveBob("failed");
    expect(screen.getByText(/Last team move · Blue · Lonestar/)).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText(/^Team move to/)).not.toBeInTheDocument();
  });
});
