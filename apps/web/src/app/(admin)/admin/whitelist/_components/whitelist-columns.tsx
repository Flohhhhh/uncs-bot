"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import { whitelistEntryStatus, type WhitelistEntry } from "./whitelist-data";
import type { WhitelistTableFeatures } from "./whitelist-table-features";

export type WhitelistTableRow = WhitelistEntry & { playerName: string | null };

function SortHeader({
  column,
  children,
}: {
  column: { getIsSorted: () => false | "asc" | "desc"; toggleSorting: (desc?: boolean) => void };
  children: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-8 px-2"
      aria-label={"Sort by " + children + (sorted ? ", currently " + sorted + "ending" : "")}
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {children}
      {sorted === "asc" ? (
        <ArrowUpIcon aria-hidden="true" />
      ) : sorted === "desc" ? (
        <ArrowDownIcon aria-hidden="true" />
      ) : (
        <ArrowUpDownIcon aria-hidden="true" />
      )}
    </Button>
  );
}

const columnHelper = createColumnHelper<WhitelistTableFeatures, WhitelistTableRow>();

export function createWhitelistColumns({
  onRemove,
  disabled,
}: {
  onRemove: (entry: WhitelistTableRow) => void;
  disabled: boolean;
}) {
  return columnHelper.columns([
    columnHelper.accessor((entry) => entry.playerName ?? entry.steamId, {
      id: "player",
      header: ({ column }) => <SortHeader column={column}>Player</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) => (
        <div className="min-w-44 py-1">
          {row.original.playerName ? <p className="font-medium">{row.original.playerName}</p> : null}
          <p className={row.original.playerName ? "font-mono text-xs text-muted-foreground" : "font-mono font-medium"}>
            {row.original.steamId}
          </p>
        </div>
      ),
    }),
    columnHelper.accessor((entry) => whitelistEntryStatus(entry).label, {
      id: "status",
      header: ({ column }) => <SortHeader column={column}>Status</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => {
        const status = whitelistEntryStatus(row.original);
        return (
          <div className="flex flex-col items-start gap-1">
            <Badge variant={status.kind === "active" ? "default" : "secondary"}>{status.label}</Badge>
            {status.note ? <span className="text-sm text-muted-foreground">{status.note}</span> : null}
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span>Actions</span>,
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onRemove(row.original)}>
          Remove
        </Button>
      ),
      enableSorting: false,
    }),
  ]);
}
