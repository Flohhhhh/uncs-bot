import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AdminContext } from "../app/context";
import { context } from "../features/players/test-fixtures";
import { ActionButton, Empty, OutcomeBadge, Sheet, Tabs, type OutcomeState } from "./ui";

describe("OutcomeBadge", () => {
  it.each([
    ["applied", "Applied", "good"],
    ["accepted", "Accepted · not verified", "warn"],
    ["pending", "Pending", "warn"],
    ["failed", "Failed", "bad"],
    ["unknown", "Unconfirmed", "warn"],
    ["started", "Unconfirmed", "warn"],
  ] as const)("labels %s as %s", (state, label, kind) => {
    render(<OutcomeBadge state={state} />);
    expect(screen.getByText(label)).toHaveClass("pill", kind);
  });
  it("never shows an unexpected outcome as a success", () => {
    render(<OutcomeBadge state={"done" as OutcomeState} />);
    expect(screen.getByText("Unconfirmed")).toHaveClass("warn");
  });
});

describe("Empty", () => {
  it("offers an optional action", () => {
    const retry = vi.fn();
    render(
      <Empty
        title="Bans could not be loaded"
        action={
          <button type="button" onClick={retry}>
            Retry
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("ActionButton", () => {
  it("opens the review only while the action is allowed", () => {
    const admin = context();
    const { rerender } = render(
      <AdminContext.Provider value={admin}>
        <ActionButton action="kick" steamId="76561198000000001">
          Kick
        </ActionButton>
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Kick" }));
    expect(admin.openAction).toHaveBeenCalledWith("kick", "76561198000000001");
    rerender(
      <AdminContext.Provider value={{ ...admin, stale: true }}>
        <ActionButton action="kick" steamId="76561198000000001">
          Kick
        </ActionButton>
      </AdminContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Kick" })).toBeDisabled();
  });
});

const views = [
  { id: "feed", label: "Feed" },
  { id: "combat", label: "Combat" },
  { id: "actions", label: "Actions", disabled: true },
  { id: "commands", label: "Commands" },
] as const;
function Location() {
  const location = useLocation();
  return <output aria-label="Location">{location.pathname + location.search}</output>;
}

describe("Tabs", () => {
  it("moves focus with the arrow keys and selects only on activation", () => {
    const change = vi.fn();
    render(
      <Tabs label="Activity views" tabs={views} onChange={change}>
        {(view) => <p>Showing {view}</p>}
      </Tabs>,
    );
    const feed = screen.getByRole("tab", { name: "Feed" });
    expect(feed).toHaveAttribute("aria-selected", "true");
    expect(feed).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel", { name: "Feed" })).toHaveTextContent("Showing feed");
    feed.focus();
    fireEvent.keyDown(feed, { key: "ArrowRight" });
    const combat = screen.getByRole("tab", { name: "Combat" });
    expect(combat).toHaveFocus();
    expect(combat).toHaveAttribute("aria-selected", "false");
    // The disabled tab is skipped, and the ends wrap.
    fireEvent.keyDown(combat, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Commands" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(feed).toHaveFocus();
    fireEvent.keyDown(feed, { key: "End" });
    expect(screen.getByRole("tab", { name: "Commands" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(feed).toHaveFocus();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(combat);
    expect(change).toHaveBeenCalledWith("combat");
    expect(combat).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Combat" })).toHaveTextContent("Showing combat");
  });

  it("follows a controlled value", () => {
    function Controlled() {
      const [view, setView] = useState<(typeof views)[number]["id"]>("commands");
      return <Tabs label="Activity views" tabs={views} value={view} onChange={setView} />;
    }
    render(<Controlled />);
    expect(screen.getByRole("tab", { name: "Commands" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Feed" }));
    expect(screen.getByRole("tab", { name: "Feed" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the choice in the URL alongside the selected server", () => {
    render(
      <MemoryRouter initialEntries={["/activity?server=event&view=combat"]}>
        <Tabs label="Activity views" tabs={views} param="view">
          {(view) => <p>Showing {view}</p>}
        </Tabs>
        <Location />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: "Combat" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Showing commands");
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("/activity?server=event&view=commands");
  });

  it("falls back to the default tab when the URL names no tab", () => {
    render(
      <MemoryRouter initialEntries={["/activity?server=event&view=unknown"]}>
        <Tabs label="Activity views" tabs={views} param="view" defaultValue="combat" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: "Combat" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Sheet", () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          View player
        </button>
        {open && (
          <Sheet title="UncDap" onClose={() => setOpen(false)}>
            <a href="#history">Combat history</a>
          </Sheet>
        )}
      </>
    );
  }

  it("moves focus into the sheet, closes on Escape and returns focus", () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "View player" });
    opener.focus();
    fireEvent.click(opener);
    const sheet = screen.getByRole("dialog", { name: "UncDap" });
    expect(sheet).toHaveAttribute("open");
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(screen.getByRole("link", { name: "Combat history" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes from its close button and leaves Escape in a nested review to that review", () => {
    const close = vi.fn();
    render(
      <Sheet title="UncDap" onClose={close}>
        <dialog open aria-label="Nested review">
          <button type="button">Cancel</button>
        </dialog>
      </Sheet>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
