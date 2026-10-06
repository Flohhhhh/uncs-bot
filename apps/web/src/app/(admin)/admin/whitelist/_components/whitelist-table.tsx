"use client";

import { useMemo, useState } from "react";
import { useTable, type SortingState } from "@tanstack/react-table";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { createWhitelistColumns, type WhitelistTableRow } from "./whitelist-columns";
import type { WhitelistEntry } from "./whitelist-data";
import { whitelistTableFeatures } from "./whitelist-table-features";

export function WhitelistTable({
  entries,
  playerNames,
  onRemove,
  disabled,
  emptyMessage,
}: {
  entries: WhitelistEntry[];
  playerNames: Map<string, string>;
  onRemove: (entry: WhitelistTableRow) => void;
  disabled: boolean;
  emptyMessage: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const data = useMemo(
    () => entries.map((entry) => ({ ...entry, playerName: playerNames.get(entry.steamId) ?? null })),
    [entries, playerNames],
  );
  const columns = useMemo(() => createWhitelistColumns({ onRemove, disabled }), [disabled, onRemove]);
  const table = useTable({
    features: whitelistTableFeatures,
    data,
    columns,
    getRowId: (entry) => entry.steamId,
    initialState: { sorting: [] },
    state: { sorting },
    onSortingChange: setSorting,
  });

  return (
    <div className="overflow-hidden rounded-md border">
      <Table aria-label="Server whitelist" className="min-w-[42rem]">
        <TableHeader>
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
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
