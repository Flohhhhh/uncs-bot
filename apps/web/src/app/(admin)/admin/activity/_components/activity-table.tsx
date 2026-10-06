"use client";

import { useMemo, useState } from "react";
import { useTable, type SortingState } from "@tanstack/react-table";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { createActivityColumns } from "./activity-columns";
import type { ActivityRow } from "./activity-data";
import { activityTableFeatures } from "./activity-table-features";

export function ActivityTable({ entries, emptyMessage }: { entries: ActivityRow[]; emptyMessage: string }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "time", desc: true }]);
  const columns = useMemo(() => createActivityColumns(), []);
  const table = useTable({
    features: activityTableFeatures,
    data: entries,
    columns,
    getRowId: (entry) => entry.id,
    onSortingChange: setSorting,
    state: { sorting },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
      <Table aria-label="Server activity" className="min-w-[52rem]" containerClassName="min-h-0 flex-1 overflow-auto">
        <TableHeader className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={header.id === "time" ? "w-40" : header.id === "category" ? "w-52" : undefined}
                >
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className="even:bg-muted/30">
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={
                      cell.column.id === "time"
                        ? "whitespace-nowrap"
                        : cell.column.id === "message"
                          ? "min-w-[24rem] whitespace-normal"
                          : "whitespace-nowrap"
                    }
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
