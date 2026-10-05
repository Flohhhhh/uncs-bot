import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Table, type TableHeader } from "./ui";

type SortValue = string | number | boolean | null | undefined;
type Direction = "ascending" | "descending";
type Column<T> = {
  label: string;
  value?: (row: T) => SortValue;
  firstDirection?: Direction;
  /** Keep the heading for screen readers only, such as a selection column. */
  hideLabel?: boolean;
  /**
   * Plain words for this column's orders in the phone "Sort by" list, such as "Name A to Z". Null leaves that order
   * out of the list, for one that matches the default order. Without them the list says "Name (ascending)".
   */
  sortLabels?: Partial<Record<Direction, string | null>>;
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const missing = (value: SortValue) =>
  value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));

/** Sort raw values, not rendered cells: IDs remain strings, numbers remain numbers, and unknowns stay last. */
export function compareValues(left: SortValue, right: SortValue, direction: Direction) {
  if (missing(left)) return missing(right) ? 0 : 1;
  if (missing(right)) return -1;
  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : typeof left === "boolean" && typeof right === "boolean"
        ? Number(left) - Number(right)
        : collator.compare(String(left), String(right));
  return direction === "ascending" ? comparison : -comparison;
}

/** Phones show card rows; this matches the card breakpoint in styles.css. */
const narrowQuery = "(max-width: 700px)";
function subscribeNarrow(change: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
function readNarrow() {
  return typeof window.matchMedia === "function" && window.matchMedia(narrowQuery).matches;
}
export function useNarrowScreen() {
  return useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
}

export function DataTable<T>({
  label,
  columns,
  rows,
  renderRow,
  cards = true,
  defaultOrder = "Server order",
}: {
  label: string;
  columns: Column<T>[];
  rows: T[];
  renderRow: (row: T) => ReactNode;
  /** Card rows on phones. Turn off only for a table that must keep its columns. */
  cards?: boolean;
  /** The phone "Sort by" list's name for the rows' own order, for a page that orders its rows itself. */
  defaultOrder?: string;
}) {
  // Keep the server's original order until a heading is selected. The third click restores it.
  const [sort, setSort] = useState<{ index: number; direction: Direction } | null>(null);
  const narrow = useNarrowScreen();
  const value = sort && columns[sort.index]?.value;
  const ordered = sort && value ? [...rows].sort((a, b) => compareValues(value(a), value(b), sort.direction)) : rows;
  const headers: TableHeader[] = columns.map((column, index) =>
    column.value
      ? {
          label: column.label,
          sort: sort?.index === index ? sort.direction : "none",
          onSort: () =>
            setSort((current) => {
              const first = column.firstDirection ?? "ascending";
              if (current?.index !== index) return { index, direction: first };
              return current.direction === first
                ? { index, direction: first === "ascending" ? "descending" : "ascending" }
                : null;
            }),
        }
      : column.hideLabel
        ? { label: column.label, hidden: true as const }
        : column.label,
  );
  const sortable = columns.flatMap((column, index) =>
    column.value
      ? (column.firstDirection === "descending"
          ? (["descending", "ascending"] as const)
          : (["ascending", "descending"] as const)
        ).flatMap((direction) => {
          const named = column.sortLabels?.[direction];
          return named === null ? [] : [{ index, direction, label: named ?? `${column.label} (${direction})` }];
        })
      : [],
  );
  // A sort left out of the list repeats the default order, so the list shows the default.
  const selected = sort ? `${sort.index}:${sort.direction}` : "";
  const listed = sortable.some((option) => `${option.index}:${option.direction}` === selected) ? selected : "";
  return (
    <>
      {cards && narrow && sortable.length > 0 && (
        // Card rows have no column headings, so one select replaces the heading buttons.
        <label className="table-sort-select">
          Sort by
          <select
            value={listed}
            onChange={(event) => {
              const [index, direction] = event.target.value.split(":");
              setSort(index ? { index: Number(index), direction: direction as Direction } : null);
            }}
          >
            <option value="">{defaultOrder}</option>
            {sortable.map((option) => (
              <option key={`${option.index}:${option.direction}`} value={`${option.index}:${option.direction}`}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <Table headers={headers} label={label} scrollable cards={cards}>
        {ordered.map(renderRow)}
      </Table>
    </>
  );
}

export function CopyValue({ value, label = "SteamID" }: { value: string; label?: string }) {
  // A new object per copy restarts the timer when the same value is copied again.
  const [status, setStatus] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (status?.text !== "Copied") return;
    const timer = window.setTimeout(() => setStatus(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <span className="copy-value">
      <span>{value}</span>
      <button
        type="button"
        className="copy-button"
        aria-label={`Copy ${label} ${value}`}
        title={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus({ text: "Copied" });
          } catch {
            setStatus({ text: "Copy failed; select the value to copy it." });
          }
        }}
      >
        ⧉
      </button>
      <span className="copy-feedback" role="status">
        {status?.text}
      </span>
    </span>
  );
}
