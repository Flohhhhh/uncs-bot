import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(cleanup);
// jsdom does not implement native modal dialogs; production uses the browser API. As in a browser, close()
// returns focus to whatever had focus at showModal(), but only while the dialog is still in the document:
// removing an open dialog ends its modal state.
const focusedAtOpen = new WeakMap<HTMLDialogElement, Element | null>();
HTMLDialogElement.prototype.showModal = function () {
  focusedAtOpen.set(this, document.activeElement);
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  if (!this.open) return;
  this.removeAttribute("open");
  const previous = focusedAtOpen.get(this);
  focusedAtOpen.delete(this);
  if (this.isConnected && previous instanceof HTMLElement) previous.focus();
};
