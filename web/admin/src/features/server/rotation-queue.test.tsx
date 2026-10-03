import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { RotationQueue, type RotationRow } from "./rotation-queue";

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
    />
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
it("marks only the positions it is given and opens the editor under the edited row", () => {
  const edit = vi.fn();
  const page = (editing: number | null) => (
    <RotationQueue
      rows={sample}
      change={vi.fn()}
      edit={edit}
      disabled={editing !== null}
      markers={{ now: 1, next: 2 }}
      editing={editing}
      editor={<p>Entry editor</p>}
    >
      <button type="button">+ Add map</button>
    </RotationQueue>
  );
  const view = render(page(null));
  const rows = () => within(screen.getByRole("list", { name: "Rotation queue" })).getAllByRole("listitem");
  expect(within(rows()[0]).queryByText(/^(Now|Next)$/)).not.toBeInTheDocument();
  expect(within(rows()[1]).getByText("Now")).toBeInTheDocument();
  expect(within(rows()[2]).getByText("Next")).toBeInTheDocument();
  expect(screen.queryByText("Entry editor")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /into rotation/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Drop here/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit Ozeti" }));
  expect(edit).toHaveBeenCalledWith(2);
  view.rerender(page(2));
  expect(within(rows()[2]).getByText("Entry editor")).toBeInTheDocument();
  for (const button of screen.getAllByRole("button", { name: /^(Edit|Remove|Move) / })) expect(button).toBeDisabled();
  expect(screen.getByRole("button", { name: "+ Add map" })).toBeInTheDocument();
});
it("labels the edit and remove icon buttons", () => {
  const change = vi.fn();
  render(<Fixture change={change} />);
  const remove = screen.getByRole("button", { name: "Remove Ozeti" });
  expect(remove).toHaveAttribute("title", "Remove");
  expect(screen.getByRole("button", { name: "Edit Ozeti" })).toHaveAttribute("title", "Edit");
  fireEvent.click(remove);
  expect(change).toHaveBeenCalledWith([sample[0], sample[1]]);
});
