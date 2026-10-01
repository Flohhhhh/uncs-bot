import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { compareValues, CopyValue, DataTable } from "./data-table";

const rows = [
  { id: "missing", score: null },
  { id: "ten", score: 10 },
  { id: "two", score: 2 },
];
const table = (data = rows) => (
  <DataTable
    label="Results"
    rows={data}
    columns={[
      { label: "Player", value: (row) => row.id },
      { label: "Score", value: (row) => row.score },
    ]}
    renderRow={(row) => (
      <tr key={row.id}>
        <td>{row.id}</td>
        <td>{row.score ?? "—"}</td>
      </tr>
    )}
  />
);
const order = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);

it("sorts numbers numerically, keeps unknowns last both ways, and restores source order", () => {
  render(table());
  const heading = screen.getByRole("button", { name: "Sort by Score" });
  expect(order()).toEqual(["missing", "ten", "two"]);
  fireEvent.click(heading);
  expect(order()).toEqual(["two", "ten", "missing"]);
  expect(heading.closest("th")).toHaveAttribute("aria-sort", "ascending");
  fireEvent.click(heading);
  expect(order()).toEqual(["ten", "two", "missing"]);
  expect(heading.closest("th")).toHaveAttribute("aria-sort", "descending");
  fireEvent.click(heading);
  expect(order()).toEqual(["missing", "ten", "two"]);
  expect(rows[0].id).toBe("missing");
});
it("keeps the chosen sort across new snapshots and is keyboard operable", async () => {
  const user = userEvent.setup();
  const view = render(table());
  screen.getByRole("button", { name: "Sort by Score" }).focus();
  await user.keyboard("{Enter}");
  view.rerender(table([...rows, { id: "five", score: 5 }]));
  expect(order()).toEqual(["two", "five", "ten", "missing"]);
  expect(screen.getByRole("region")).toHaveAttribute("tabindex", "0");
});
it("compares SteamIDs without numeric rounding and handles missing or non-finite data", () => {
  expect(compareValues("76561198000000001", "76561198000000002", "ascending")).toBeLessThan(0);
  expect(compareValues("player 2", "Player 10", "ascending")).toBeLessThan(0);
  expect(compareValues(NaN, 5, "descending")).toBeGreaterThan(0);
  expect(compareValues(undefined, null, "ascending")).toBe(0);
});
it("copies the exact ID and reports clipboard rejection without claiming success", async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    render(<CopyValue value="76561198000000001" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy SteamID 76561198000000001" }));
    await screen.findByText("Copied");
    expect(writeText).toHaveBeenCalledWith("76561198000000001");
    fireEvent.click(screen.getByRole("button", { name: "Copy SteamID 76561198000000001" }));
    await screen.findByText("Copy failed; select the value to copy it.");
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});
