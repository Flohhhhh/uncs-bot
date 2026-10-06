"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import { banTimestamp, formatBanDate, isPublicIndividualSteamId, type Ban } from "./bans-data";
import type { BansTableFeatures } from "./bans-table-features";

export type BanTableRow = Ban & { playerName: string | null };

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
      aria-label={`Sort by ${children}${sorted ? `, currently ${sorted}ending` : ""}`}
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

const columnHelper = createColumnHelper<BansTableFeatures, BanTableRow>();

export function createBanColumns({
  onRemove,
  removeDisabled,
}: {
  onRemove: (ban: BanTableRow) => void;
  removeDisabled: boolean;
}) {
  return columnHelper.columns([
    columnHelper.accessor((ban) => ban.playerName ?? ban.steamId, {
      id: "player",
      header: ({ column }) => <SortHeader column={column}>Player</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) => (
        <div className="min-w-44 py-1">
          {row.original.playerName ? <p className="font-medium">{row.original.playerName}</p> : null}
          <p className={row.original.playerName ? "font-mono text-xs text-muted-foreground" : "font-mono font-medium"}>
            {row.original.steamId}
          </p>
          {!isPublicIndividualSteamId(row.original.steamId) ? (
            <Badge className="mt-1" variant="secondary">
              Invalid SteamID
            </Badge>
          ) : null}
        </div>
      ),
    }),
    columnHelper.accessor((ban) => banTimestamp(ban.bannedAtUtc) ?? -1, {
      id: "bannedAt",
      header: ({ column }) => <SortHeader column={column}>Banned</SortHeader>,
      sortFn: "basic",
      cell: ({ row }) => {
        const timestamp = banTimestamp(row.original.bannedAtUtc);
        return (
          <time
            dateTime={timestamp === null ? undefined : (row.original.bannedAtUtc ?? undefined)}
            title={timestamp === null ? undefined : new Date(timestamp).toLocaleString()}
            className="whitespace-nowrap text-muted-foreground tabular-nums"
          >
            {formatBanDate(row.original.bannedAtUtc)}
          </time>
        );
      },
    }),
    columnHelper.accessor((ban) => ban.reason ?? "", {
      id: "reason",
      header: ({ column }) => <SortHeader column={column}>Reason</SortHeader>,
      sortFn: "text",
      cell: ({ row }) =>
        row.original.reason ? (
          <span className="whitespace-normal">{row.original.reason}</span>
        ) : (
          <span className="text-muted-foreground">No reason supplied by the game</span>
        ),
    }),
    columnHelper.accessor((ban) => ban.bannedBy ?? "", {
      id: "bannedBy",
      header: ({ column }) => <SortHeader column={column}>Banned by</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => row.original.bannedBy || <span className="text-muted-foreground">—</span>,
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span>Actions</span>,
      cell: ({ row }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={removeDisabled || !isPublicIndividualSteamId(row.original.steamId)}
          onClick={() => onRemove(row.original)}
        >
          Remove ban
        </Button>
      ),
      enableSorting: false,
    }),
  ]);
}
