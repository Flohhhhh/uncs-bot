"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";

import { toneFor, type Player, type Team } from "./players-data";
import type { PlayerTableFeatures } from "./player-table-features";

export type PlayerTableRow = Player & { teamName: string; team: Team | null };

function SortHeader({
  column,
  children,
}: {
  column: { getIsSorted: () => false | "asc" | "desc"; toggleSorting: (desc?: boolean) => void };
  children: string;
}) {
  const sort = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-8 px-2"
      aria-label={`Sort by ${children}${sort ? `, currently ${sort}ending` : ""}`}
      onClick={() => column.toggleSorting(sort === "asc")}
    >
      {children}
      {sort === "asc" ? (
        <ArrowUp aria-hidden="true" />
      ) : sort === "desc" ? (
        <ArrowDown aria-hidden="true" />
      ) : (
        <ArrowUpDown aria-hidden="true" />
      )}
    </Button>
  );
}

const columnHelper = createColumnHelper<PlayerTableFeatures, PlayerTableRow>();

export function createPlayerColumns({ onInspect }: { onInspect: (player: PlayerTableRow) => void }) {
  return columnHelper.columns([
    columnHelper.display({
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
          onCheckedChange={(checked) => table.toggleAllRowsSelected(!!checked)}
          aria-label="Select all shown players"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onCheckedChange={(checked) => row.toggleSelected(!!checked)}
          aria-label={`Select ${row.original.name}`}
        />
      ),
      enableSorting: false,
    }),
    columnHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column}>Player</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) => {
        const tone = toneFor(row.original.teamName);
        return (
          <Button
            variant="link"
            className="h-auto w-full min-w-0 cursor-pointer justify-start gap-2 p-2 text-left font-medium text-foreground no-underline hover:text-primary hover:no-underline"
            aria-haspopup="dialog"
            onClick={() => onInspect(row.original)}
          >
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${tone.dot}`} />
            <span className="truncate group-hover:text-orange-500">{row.original.name}</span>
          </Button>
        );
      },
    }),
    columnHelper.accessor("teamName", {
      header: ({ column }) => <SortHeader column={column}>Team</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) => {
        const tone = toneFor(row.original.teamName);
        return (
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${tone.badge}`}
          >
            {row.original.teamName}
          </span>
        );
      },
    }),
    columnHelper.accessor((player) => player.kills ?? -1, {
      id: "kills",
      header: ({ column }) => <SortHeader column={column}>Kills</SortHeader>,
      sortFn: "basic",
      cell: ({ row }) => <span className="tabular-nums">{row.original.kills ?? "—"}</span>,
    }),
    columnHelper.accessor((player) => player.deaths ?? -1, {
      id: "deaths",
      header: ({ column }) => <SortHeader column={column}>Deaths</SortHeader>,
      sortFn: "basic",
      cell: ({ row }) => <span className="tabular-nums">{row.original.deaths ?? "—"}</span>,
    }),
    columnHelper.accessor((player) => player.pingMs ?? -1, {
      id: "ping",
      header: ({ column }) => <SortHeader column={column}>Ping</SortHeader>,
      sortFn: "basic",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.pingMs ?? "—"}
          {row.original.pingMs !== undefined && <span className="ml-1 text-muted-foreground">ms</span>}
        </span>
      ),
    }),
  ]);
}
