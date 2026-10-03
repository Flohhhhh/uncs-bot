import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(cleanup);
// jsdom does not implement native modal dialogs; production uses the browser API. As in a browser, close()
// returns focus to whatever had focus at showModal(), but only while the dialog is still in the document:
// removing an open dialog ends its modal state.
const focusedAtOpen = new WeakMap<HTMLDialogElement, Element | null>();
// Modal dialogs in top-layer order, the last one on top.
let modals: HTMLDialogElement[] = [];
HTMLDialogElement.prototype.showModal = function () {
  focusedAtOpen.set(this, document.activeElement);
  this.setAttribute("open", "");
  modals = [...modals.filter((dialog) => dialog !== this), this];
};
HTMLDialogElement.prototype.close = function () {
  if (!this.open) return;
  this.removeAttribute("open");
  modals = modals.filter((dialog) => dialog !== this);
  const previous = focusedAtOpen.get(this);
  focusedAtOpen.delete(this);
  if (this.isConnected && previous instanceof HTMLElement) previous.focus();
};
// As in a browser, an open modal dialog makes the rest of the page inert, so focus() outside it does nothing.
const focus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (options?: FocusOptions) {
  const top = modals.findLast((dialog) => dialog.isConnected && dialog.open);
  if (top && !top.contains(this)) return;
  focus.call(this, options);
};
afterEach(() => {
  modals = [];
});
