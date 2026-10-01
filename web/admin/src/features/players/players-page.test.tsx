import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminContext } from "../../app/context";
import { PlayersPage } from "./players-page";
import { alice, context } from "./test-fixtures";

vi.mock("../../api/client", () => ({ api: vi.fn() }));

describe("live player controls", () => {
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
});
