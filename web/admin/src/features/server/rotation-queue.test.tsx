import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { RotationQueue, type RotationRow } from "./rotation-queue";
import userEvent from "@testing-library/user-event";

const sample: RotationRow[] = [
  { id: "first", entry: { map: "Kavkazi", experiences: ["Bakurani_KOTH_01"], lighting: "DayClear" } },
  { id: "second", entry: { map: "Kavkazi", experiences: ["KOTH_Hardcore"], lighting: "DayEarlyFog" } },
  { id: "third", entry: { map: "Europe", experiences: ["Madrid_KOTH_01"] } },
];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = this.closest("li");
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    return {
      x: 0,
      y: index * 80,
      top: index * 80,
      bottom: (index + 1) * 80,
      left: 0,
      right: 500,
      width: 500,
      height: 80,
      toJSON: () => ({}),
    };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
function Fixture({ change, disabled = false }: { change: (rows: RotationRow[]) => void; disabled?: boolean }) {
  const [rows, setRows] = useState(sample);
  return (
    <RotationQueue
      rows={rows}
      change={(next) => {
        change(next);
        setRows(next);
      }}
      disabled={disabled}
      edit={vi.fn()}
      selection={sample[0].entry}
      canAdd
      add={vi.fn()}
    >
      {null}
    </RotationQueue>
  );
}
it("keeps duplicate maps distinct and preserves exact mode and lighting IDs when moved", () => {
  const change = vi.fn();
  render(<Fixture change={change} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Move Bakurani down" })[0]);
  expect(change).toHaveBeenCalledWith([sample[1], sample[0], sample[2]]);
  const rows = within(screen.getByRole("list", { name: "Rotation queue" })).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("Hardcore · Early day · fog");
  expect(rows[1]).toHaveTextContent("King of the Hill · Day · clear");
});
it("supports a real keyboard drag and Escape cancellation without changing the draft", async () => {
  const change = vi.fn();
  render(<Fixture change={change} />);
  const handle = screen.getByRole("button", { name: "Reorder entry 1: Bakurani" });
  handle.focus();
  fireEvent.keyDown(handle, { key: " ", code: "Space" });
  await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
  fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
  fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(handle).not.toHaveAttribute("aria-pressed", "true"));
  expect(change).not.toHaveBeenCalled();
});
it("locks drag handles and buttons when editing or saving", () => {
  const change = vi.fn();
  render(<Fixture change={change} disabled />);
  expect(screen.getByRole("button", { name: "Reorder entry 1: Bakurani" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Move Ozeti up" }));
  expect(change).not.toHaveBeenCalled();
});
it("inserts a prepared card through keyboard dragging", async () => {
  const add = vi.fn();
  const page = (rows: RotationRow[]) => (
    <RotationQueue
      rows={rows}
      change={vi.fn()}
      disabled={false}
      edit={vi.fn()}
      selection={sample[0].entry}
      canAdd
      add={add}
    >
      {null}
    </RotationQueue>
  );
  const view = render(page(sample));
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Drag Bakurani · King of the Hill · Day · clear into rotation" }).focus();
  await user.keyboard("[Space]");
  await user.keyboard("[ArrowDown]");
  view.rerender(page(structuredClone(sample)));
  await user.keyboard("[Space]");
  expect(add).toHaveBeenCalledTimes(1);
});
