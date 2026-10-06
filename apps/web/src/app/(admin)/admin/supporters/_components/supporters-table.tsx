"use client";

import { useMemo, useState } from "react";
import { useTable, type SortingState } from "@tanstack/react-table";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { createSupporterColumns } from "./supporters-columns";
import { supportersTableFeatures } from "./supporters-table-features";
import type { SupporterRecord } from "./supporters-data";

export function SupportersTable({
  entries,
  isLoading,
  emptyMessage,
}: {
  entries: SupporterRecord[];
  isLoading: boolean;
  emptyMessage: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "payment", desc: true }]);
  const columns = useMemo(() => createSupporterColumns(), []);
  const table = useTable({
    features: supportersTableFeatures,
    data: entries,
    columns,
    getRowId: (supporter) => supporter.id,
    state: { sorting },
    onSortingChange: setSorting,
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
      <Table
        aria-label="Supporters"
        className="min-w-[68rem]"
        containerClassName="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain"
      >
        <TableHeader className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
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
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={table.getAllLeafColumns().length} className="h-24 text-center text-muted-foreground">
                {isLoading ? "Loading supporters…" : emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
