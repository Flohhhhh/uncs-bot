import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AdminContext } from "../app/context";
import { context } from "../features/players/test-fixtures";
import { pressEscape } from "../test/dialog";
import { ActionButton, Empty, Modal, OutcomeBadge, Sheet, Tabs, type OutcomeState } from "./ui";

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

const admin = context();
function dialogTree(busy: boolean, onClose: () => void) {
  return (
    <AdminContext.Provider value={admin}>
      <Modal title="Review" onClose={onClose} busy={busy}>
        <p>Review body</p>
      </Modal>
    </AdminContext.Provider>
  );
}

/** A page heading, an opener and a dialog that can remove or disable its opener, as a row's result can. */
function Page() {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<"ready" | "removed" | "disabled">("ready");
  return (
    <AdminContext.Provider value={admin}>
      <main id="main-content" tabIndex={-1}>
        <h1 tabIndex={-1}>Whitelist</h1>
        {opener !== "removed" && (
          <button type="button" disabled={opener === "disabled"} onClick={() => setOpen(true)}>
            Remove
          </button>
        )}
        {open && (
          <Modal title="Remove from whitelist" onClose={() => setOpen(false)}>
            <button type="button" onClick={() => setOpener("removed")}>
              Finish removal
            </button>
            <button type="button" onClick={() => setOpener("disabled")}>
              Finish without removal
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </Modal>
        )}
      </main>
    </AdminContext.Provider>
  );
}
/** Opens the dialog from its button with the keyboard, and moves focus into it as a browser would. */
function openFromButton() {
  const opener = screen.getByRole("button", { name: "Remove" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog") as HTMLDialogElement;
  screen.getByRole("button", { name: "Cancel" }).focus();
  return { opener, dialog };
}

describe("Modal", () => {
  const modal = (eyebrow?: string | null) => (
    <AdminContext.Provider value={context()}>
      <Modal title="Kick player" eyebrow={eyebrow} onClose={vi.fn()}>
        <p>Body</p>
      </Modal>
    </AdminContext.Provider>
  );
  it("labels a review by default and leaves the eyebrow out when asked", () => {
    const { rerender } = render(modal());
    expect(screen.getByRole("dialog", { name: "Kick player" })).toHaveTextContent("STAFF REVIEW");
    rerender(modal(null));
    expect(screen.getByRole("dialog", { name: "Kick player" })).not.toHaveTextContent("STAFF REVIEW");
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
  });
  it("returns focus to the control that opened it", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <AdminContext.Provider value={context()}>
          <button type="button" onClick={() => setOpen(true)}>
            Remove ban
          </button>
          {open && (
            <Modal title="Remove ban" onClose={() => setOpen(false)}>
              <p>Body</p>
            </Modal>
          )}
        </AdminContext.Provider>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Remove ban" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it("returns focus to the button that opened it on Cancel", () => {
    render(<Page />);
    const { opener } = openFromButton();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it("returns focus to the button that opened it on Escape", () => {
    render(<Page />);
    const { opener, dialog } = openFromButton();
    pressEscape(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it.each(["removal", "without removal"])(
    "focuses the page heading when the opener cannot take focus back (finish %s)",
    (finish) => {
      render(<Page />);
      openFromButton();
      fireEvent.click(screen.getByRole("button", { name: `Finish ${finish}` }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("heading", { name: "Whitelist" })).toHaveFocus();
    },
  );
  it("returns focus to the panel behind it when the opener inside the panel is gone", () => {
    function Panel() {
      const [open, setOpen] = useState(false);
      const [present, setPresent] = useState(true);
      return (
        <AdminContext.Provider value={admin}>
          <main id="main-content" tabIndex={-1}>
            <h1 tabIndex={-1}>Live players</h1>
          </main>
          <Sheet title="UncDap" onClose={vi.fn()}>
            {present && (
              <button type="button" onClick={() => setOpen(true)}>
                Move to Lonestar
              </button>
            )}
          </Sheet>
          {open && (
            <Modal title="Move UncDap" onClose={() => setOpen(false)}>
              <button type="button" onClick={() => setPresent(false)}>
                Finish move
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </Modal>
          )}
        </AdminContext.Provider>
      );
    }
    render(<Panel />);
    const opener = screen.getByRole("button", { name: "Move to Lonestar" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Finish move" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The page behind a modal panel is inert, so the heading could not take focus there.
    expect(screen.getByRole("dialog", { name: "UncDap" })).toHaveFocus();
  });
  it("closes on Escape when idle", () => {
    const onClose = vi.fn();
    render(dialogTree(false, onClose));
    pressEscape(screen.getByRole("dialog") as HTMLDialogElement);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("stays open through repeated Escape presses while busy", () => {
    const onClose = vi.fn();
    const { rerender } = render(dialogTree(true, onClose));
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    expect(dialog).toHaveAttribute("closedby", "none");
    // The close listener would reopen a dialog that Escape closed, so check that Escape never reaches the
    // dialog as a close request at all, not only that the dialog ends up open.
    const requests = vi.fn();
    dialog.addEventListener("cancel", requests);
    dialog.addEventListener("close", requests);
    pressEscape(dialog);
    // Chrome no longer lets the page cancel a second Escape without a new click in between.
    pressEscape(dialog, { cancelable: false });
    expect(requests).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(screen.getByText("Review body")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    rerender(dialogTree(false, onClose));
    expect(dialog).not.toHaveAttribute("closedby");
    pressEscape(dialog);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("reopens a busy dialog the browser closes anyway, and reports the close once idle", () => {
    const onClose = vi.fn();
    const { rerender } = render(dialogTree(true, onClose));
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    // A close request that never reaches the page as a keydown, such as the Android back gesture.
    const closeNatively = () =>
      act(() => {
        dialog.close();
        dialog.dispatchEvent(new Event("close"));
      });
    closeNatively();
    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    rerender(dialogTree(false, onClose));
    closeNatively();
    expect(onClose).toHaveBeenCalledOnce();
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

  it("lets the parent remove a sheet the browser closes natively", () => {
    const close = vi.fn();
    render(
      <Sheet title="UncDap" onClose={close}>
        <p>Stats</p>
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog", { name: "UncDap" }) as HTMLDialogElement;
    // A close request that never reaches the page as a keydown, such as the Android back gesture.
    act(() => {
      sheet.close();
      sheet.dispatchEvent(new Event("close"));
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("focuses the page heading when the control that opened it is gone", () => {
    function Removable() {
      const [open, setOpen] = useState(false);
      const [present, setPresent] = useState(true);
      return (
        <main id="main-content" tabIndex={-1}>
          <h1 tabIndex={-1}>Live players</h1>
          {present && (
            <button type="button" onClick={() => setOpen(true)}>
              UncDap
            </button>
          )}
          {open && (
            <Sheet title="Player" onClose={() => setOpen(false)}>
              <button type="button" onClick={() => setPresent(false)}>
                Leave roster
              </button>
            </Sheet>
          )}
        </main>
      );
    }
    render(<Removable />);
    const opener = screen.getByRole("button", { name: "UncDap" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Leave roster" }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.getByRole("heading", { name: "Live players" })).toHaveFocus();
  });
});
