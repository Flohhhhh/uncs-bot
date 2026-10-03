import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { PlayersPage } from "./players-page";
import { alice, bob, context, overview } from "./test-fixtures";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
afterEach(() => vi.useRealTimers());

describe("live player controls", () => {
  it("does not claim an empty roster while waiting for the first response", () => {
    render(
      <AdminContext.Provider value={{ ...context(), overview: null }}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    expect(screen.getByText("Waiting for the player list")).toBeInTheDocument();
    expect(screen.queryByText("0 players shown")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching players")).not.toBeInTheDocument();
  });
  it("sorts reported cash numerically and leaves unknown balances last", () => {
    const state = context();
    state.overview!.players[0].cash = 0;
    state.overview!.players[1].cash = 10000;
    state.overview!.players[2].cash = undefined;
    render(
      <AdminContext.Provider value={state}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by Cash" }));
    const rows = within(screen.getByRole("table", { name: "Live players" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[0]).toHaveTextContent("Bob");
    expect(rows[0]).toHaveTextContent("10,000");
    expect(rows[1]).toHaveTextContent("UNC Alice");
    expect(rows[2]).toHaveTextContent("Cara");
  });
  it("finds pasted IDs and names with surrounding spaces", () => {
    render(
      <AdminContext.Provider value={context()}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    for (const query of [` ${alice.steamId} `, "  unc alice  "]) {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
      expect(screen.getByText(alice.name)).toBeInTheDocument();
      expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    }
  });
  it("discloses excluded unlinked entries without inventing selectable identities", () => {
    const admin = context();
    admin.overview!.unlinkedPlayerCount = 2;
    render(
      <AdminContext.Provider value={admin}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    expect(screen.getByRole("status", { name: "Incomplete player roster" })).toHaveTextContent(
      "2 roster entries have no usable SteamID.",
    );
    expect(screen.getByRole("status", { name: "Incomplete player roster" })).toHaveTextContent(
      "team counts below exclude them",
    );
    fireEvent.click(screen.getByLabelText("Select all shown players"));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });
  it("sorts without changing selected identities and combines team filters with search", () => {
    render(
      <AdminContext.Provider value={context()}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByLabelText("Select Bob"));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Player" }));
    const table = screen.getByRole("table", { name: "Live players" });
    const first = within(table).getAllByRole("row")[1];
    expect(within(first).getByText("Bob")).toBeInTheDocument();
    expect(screen.getByLabelText("Select Bob")).toBeChecked();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter players by team" }), {
      target: { value: "Lonestar" },
    });
    expect(screen.getByText("Cara")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.getByText("1 selected (includes hidden players)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByLabelText("Select Bob")).toBeChecked();
  });
  it("shows a filtered team that left the match so All teams can clear it", () => {
    const view = render(
      <AdminContext.Provider value={context()}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    const filter = screen.getByRole("combobox", { name: "Filter players by team" });
    fireEvent.change(filter, { target: { value: "Lonestar" } });
    expect(screen.getByRole("heading", { name: "1 player shown" })).toBeInTheDocument();
    const next = context();
    next.overview!.status.factionScores = next.overview!.status.factionScores.filter(
      (team) => team.name !== "Lonestar",
    );
    view.rerender(
      <AdminContext.Provider value={next}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    expect(filter).toHaveValue("Lonestar");
    expect(within(filter).getByRole("option", { name: "Lonestar (not in this match)" })).toHaveProperty(
      "selected",
      true,
    );
    expect(screen.getByRole("heading", { name: "0 players shown" })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "" } });
    expect(within(filter).queryByRole("option", { name: /not in this match/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3 players shown" })).toBeInTheDocument();
  });
  it("limits the UNC shortcut to player names while keeping hidden selections visible", () => {
    const admin = context();
    admin.overview!.status.factionScores[0].name = "UNC faction";
    render(
      <AdminContext.Provider value={admin}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByLabelText("Select Bob"));
    fireEvent.click(screen.getByRole("button", { name: "UNC in name" }));
    expect(screen.getByRole("heading", { name: "1 player shown" })).toBeInTheDocument();
    expect(screen.getByText("1 selected (includes hidden players)")).toBeInTheDocument();
    expect(
      screen.getByText("“UNC in name” only searches player names. It does not verify community membership."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select all shown players"));
    expect(screen.getByText("2 selected (includes hidden players)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Destination team for selected players"), { target: { value: "Lonestar" } });
    fireEvent.click(screen.getByRole("button", { name: "Review move" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Bob")).toBeInTheDocument();
    expect(within(dialog).getByText("UNC Alice")).toBeInTheDocument();
  });
  it("uses live faction names for destination choices and hides the player's current team", () => {
    render(
      <AdminContext.Provider value={context()}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    const select = screen.getByLabelText("Destination team for UNC Alice");
    expect(within(select).getByRole("option", { name: "Blue · Lonestar" })).toHaveValue("Lonestar");
    expect(within(select).queryByRole("option", { name: "Red · Valkyra" })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "Lonestar" } });
    const row = select.closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Move" }));
    expect(within(screen.getByRole("dialog")).getByText(alice.steamId)).toBeInTheDocument();
  });
  it("keeps viewer controls disabled and escapes player names as text", () => {
    const admin = context();
    admin.me.role = "viewer";
    admin.overview!.players[0] = { ...alice, name: "<img src=x onerror=alert(1)>" };
    const { container } = render(
      <AdminContext.Provider value={admin}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "More" }).every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(screen.getByLabelText("Select all shown players")).toBeDisabled();
  });
  it("opens the existing generic action flow for the selected player", () => {
    const admin = context();
    render(
      <AdminContext.Provider value={admin}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Message player" }));
    expect(admin.openAction).toHaveBeenCalledWith("message", alice.steamId);
  });
  it.each(["unmatched", "refused"])(
    "keeps a player skipped as %s selected after the batch because no move was sent",
    async (state) => {
      vi.useFakeTimers();
      const live = overview();
      // Bob changes team during the batch: the dialog's own roster read sees it, or the server refuses the move.
      if (state === "unmatched") live.players[1] = { ...bob, faction: "GRN" };
      vi.mocked(api).mockImplementation(async (path, options) =>
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
      render(
        <AdminContext.Provider value={context()}>
          <PlayersPage />
        </AdminContext.Provider>,
      );
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
  it("says why every player action is disabled when the paused snapshot expires", () => {
    const admin = context();
    const tree = (stale: boolean) => (
      <AdminContext.Provider value={{ ...admin, stale }}>
        <PlayersPage />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(false));
    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    rerender(tree(true));
    const message = within(dialog).getByRole("button", { name: "Message player" });
    expect(message).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Server details need a fresh check. Close this dialog and refresh before choosing an action.",
    );
    expect(message).toHaveAccessibleDescription(/fresh check/);
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
    const admin = setup();
    render(
      <AdminContext.Provider value={admin}>
        <PlayersPage />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
    const dialog = screen.getByRole("dialog");
    const off = within(dialog).getByRole("button", { name: label });
    const message = within(dialog).getByRole("button", { name: "Message player" });
    expect(off).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Some actions are unavailable for your role, connection, or server build.",
    );
    expect(off).toHaveAccessibleDescription(/your role, connection, or server build/);
    expect(message).toBeEnabled();
    expect(message).not.toHaveAccessibleDescription();
  });
  it("removes player actions if the selected player leaves while the menu is open", () => {
    const admin = context();
    const tree = (present: boolean) => (
      <AdminContext.Provider value={{ ...admin, overview: { ...admin.overview!, players: present ? [alice] : [] } }}>
        <PlayersPage />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(true));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    rerender(tree(false));
    expect(screen.getByRole("dialog")).toHaveTextContent("no longer in the current roster");
    expect(screen.queryByRole("button", { name: "Ban player" })).not.toBeInTheDocument();
    expect(admin.openAction).not.toHaveBeenCalled();
  });
});
