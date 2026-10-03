import { act } from "@testing-library/react";

/**
 * Presses Escape the way Chrome handles it for a modal dialog, which jsdom does not model. A keydown the page
 * does not cancel becomes a close request. Only the first request after a click fires a cancellable cancel
 * event; later ones close the dialog even if the page calls preventDefault. The close event follows in a
 * later task, after React has handled the cancel event.
 */
export function pressEscape(dialog: HTMLDialogElement, { cancelable = true } = {}) {
  let closed = false;
  act(() => {
    const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(key);
    if (key.defaultPrevented || !dialog.open) return;
    const cancel = new Event("cancel", { cancelable });
    dialog.dispatchEvent(cancel);
    if (cancel.defaultPrevented) return;
    dialog.close();
    closed = true;
  });
  if (closed) act(() => void dialog.dispatchEvent(new Event("close")));
}
