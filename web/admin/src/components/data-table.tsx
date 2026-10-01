import { useState, type ReactNode } from "react";
import { Table, type TableHeader } from "./ui";

type SortValue = string | number | boolean | null | undefined;
type Direction = "ascending" | "descending";
type Column<T> = { label: string; value?: (row: T) => SortValue; firstDirection?: Direction };
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

export function DataTable<T>({
  label,
  columns,
  rows,
  renderRow,
}: {
  label: string;
  columns: Column<T>[];
  rows: T[];
  renderRow: (row: T) => ReactNode;
}) {
  // Keep the server's original order until a heading is selected. The third click restores it.
  const [sort, setSort] = useState<{ index: number; direction: Direction } | null>(null);
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
      : column.label,
  );
  return (
    <Table headers={headers} label={label} scrollable>
      {ordered.map(renderRow)}
    </Table>
  );
}

export function CopyValue({ value, label = "SteamID" }: { value: string; label?: string }) {
  const [status, setStatus] = useState("");
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
            setStatus("Copied");
          } catch {
            setStatus("Copy failed; select the value to copy it.");
          }
        }}
      >
        ⧉
      </button>
      <span className="copy-feedback" role="status">
        {status}
      </span>
    </span>
  );
}
