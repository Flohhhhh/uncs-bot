import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdminContext } from "../app/context";
import { context } from "../features/players/test-fixtures";
import { pressEscape } from "../test/dialog";
import { Modal } from "./ui";

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
