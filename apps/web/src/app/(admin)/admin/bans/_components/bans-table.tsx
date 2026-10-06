"use client";

import { useMemo, useState } from "react";
import { useTable, type SortingState } from "@tanstack/react-table";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { createBanColumns, type BanTableRow } from "./bans-columns";
import { bansTableFeatures } from "./bans-table-features";

export function BansTable({
  entries,
  onRemove,
  removeDisabled,
  emptyMessage,
}: {
  entries: BanTableRow[];
  onRemove: (ban: BanTableRow) => void;
  removeDisabled: boolean;
  emptyMessage: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "bannedAt", desc: true }]);
  const columns = useMemo(() => createBanColumns({ onRemove, removeDisabled }), [onRemove, removeDisabled]);
  const table = useTable({
    features: bansTableFeatures,
    data: entries,
    columns,
    getRowId: (ban) => ban.steamId,
    state: { sorting },
    onSortingChange: setSorting,
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
      <Table
        aria-label="Server bans"
        className="min-w-[62rem]"
        containerClassName="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain"
      >
        <TableHeader className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} className={header.id === "actions" ? "w-32" : undefined}>
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
                  <TableCell key={cell.id} className={cell.column.id === "reason" ? "whitespace-normal" : undefined}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={table.getAllLeafColumns().length} className="h-24 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
