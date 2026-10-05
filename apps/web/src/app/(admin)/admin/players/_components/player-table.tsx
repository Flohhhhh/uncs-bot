"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTable, type RowSelectionState, type SortingState } from "@tanstack/react-table";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { createPlayerColumns, type PlayerTableRow } from "./player-columns";
import { playerTableFeatures } from "./player-table-features";

export function PlayerTable({
  players,
  rowSelection,
  onRowSelectionChange,
  onInspect,
}: {
  players: PlayerTableRow[];
  rowSelection: RowSelectionState;
  onRowSelectionChange: Dispatch<SetStateAction<RowSelectionState>>;
  onInspect: (player: PlayerTableRow) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "kills", desc: true }]);
  const columns = useMemo(() => createPlayerColumns({ onInspect }), [onInspect]);
  const table = useTable({
    features: playerTableFeatures,
    data: players,
    columns,
    getRowId: (player) => player.steamId,
    enableRowSelection: true,
    onSortingChange: setSorting,
    onRowSelectionChange,
    state: { sorting, rowSelection },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
      <Table aria-label="Live players" className="min-w-[44rem]" containerClassName="min-h-0 flex-1 overflow-auto">
        <TableHeader className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} className={header.id === "select" ? "w-11" : undefined}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className="even:bg-muted/30"
                data-state={row.getIsSelected() ? "selected" : undefined}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className={cell.column.id === "name" ? "group p-0" : undefined}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                No matching players.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
