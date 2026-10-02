import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
it("scrolls inside the table only above 25 rows", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `p${index}`, score: index }));
  const view = render(table(many(25)));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  view.rerender(table(many(26)));
  expect(screen.getByRole("region", { name: "Results scroll area" })).toHaveAttribute("tabindex", "0");
});
it("labels card cells from the column headings", () => {
  render(table());
  const wrapper = screen.getByRole("table").parentElement!;
  expect(wrapper).toHaveAttribute("data-mobile", "cards");
  expect(wrapper.style.getPropertyValue("--cell-label-1")).toBe('"Player"');
  expect(wrapper.style.getPropertyValue("--cell-label-2")).toBe('"Score"');
});
describe("on a phone", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 700px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it("sorts card rows from one select and returns to the server's order", () => {
    render(table());
    const select = screen.getByRole("combobox", { name: "Sort by" });
    expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Server order",
      "Player (ascending)",
      "Player (descending)",
      "Score (ascending)",
      "Score (descending)",
    ]);
    fireEvent.change(select, { target: { value: "1:descending" } });
    expect(order()).toEqual(["ten", "two", "missing"]);
    expect(screen.getByRole("button", { name: "Sort by Score" }).closest("th")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    fireEvent.change(select, { target: { value: "" } });
    expect(order()).toEqual(["missing", "ten", "two"]);
  });
});
it("keeps column headings and no extra select on a wide screen", () => {
  render(table());
  expect(screen.queryByRole("combobox", { name: "Sort by" })).not.toBeInTheDocument();
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
it("clears the copied confirmation after two seconds but keeps a failure visible", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    render(<CopyValue value="76561198000000001" />);
    const button = screen.getByRole("button", { name: "Copy SteamID 76561198000000001" });
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await act(async () => fireEvent.click(button));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed; select the value to copy it.");
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
