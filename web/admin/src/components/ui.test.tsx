import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminContext } from "../app/context";
import { context } from "../features/players/test-fixtures";
import { pressEscape } from "../test/dialog";
import { Modal } from "./ui";

function dialogTree(busy: boolean, onClose: () => void) {
  return (
    <AdminContext.Provider value={context()}>
      <Modal title="Review" onClose={onClose} busy={busy}>
        <p>Review body</p>
      </Modal>
    </AdminContext.Provider>
  );
}

describe("Modal", () => {
  it("closes on Escape when idle", () => {
    const onClose = vi.fn();
    render(dialogTree(false, onClose));
    pressEscape(screen.getByRole("dialog") as HTMLDialogElement);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("stays open through repeated Escape presses while busy", () => {
    const onClose = vi.fn();
    render(dialogTree(true, onClose));
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    pressEscape(dialog);
    // Chrome no longer lets the page cancel a second Escape without a new click in between.
    pressEscape(dialog, { cancelable: false });
    expect(dialog.open).toBe(true);
    expect(screen.getByText("Review body")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
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
