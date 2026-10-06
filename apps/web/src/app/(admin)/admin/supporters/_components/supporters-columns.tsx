"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import {
  formatSupporterDate,
  formatSupporterPayment,
  supporterNextStep,
  supporterWorkState,
  type SupporterRecord,
} from "./supporters-data";
import type { SupportersTableFeatures } from "./supporters-table-features";

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

const columnHelper = createColumnHelper<SupportersTableFeatures, SupporterRecord>();

export function createSupporterColumns() {
  return columnHelper.columns([
    columnHelper.accessor((supporter) => supporter.displayName ?? "", {
      id: "supporter",
      header: ({ column }) => <SortHeader column={column}>Supporter</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => (
        <div className="min-w-48 py-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.displayName || "Unnamed supporter"}</span>
            {row.original.founder ? <Badge variant="secondary">Founder</Badge> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {row.original.provider === "patreon" && row.original.patreonMemberId
              ? `Patreon ID ${row.original.patreonMemberId}`
              : `Added ${formatSupporterDate(row.original.observedAt)}`}
          </p>
        </div>
      ),
    }),
    columnHelper.accessor((supporter) => supporter.provider, {
      id: "provider",
      header: ({ column }) => <SortHeader column={column}>Provider</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => <span className="text-muted-foreground capitalize">{row.original.provider}</span>,
    }),
    columnHelper.accessor((supporter) => ({ needs: 0, waiting: 1, set: 2 })[supporterWorkState(supporter)], {
      id: "next",
      header: ({ column }) => <SortHeader column={column}>Next</SortHeader>,
      sortFn: "basic",
      cell: ({ row }) => {
        const { state, detail } = supporterNextStep(row.original);
        return (
          <div className="min-w-52">
            <Badge variant={state === "needs" ? "default" : state === "waiting" ? "secondary" : "outline"}>
              {state === "needs" ? "Needs you" : state === "waiting" ? "Waiting" : "All set"}
            </Badge>
            {detail ? (
              <p className="mt-1 max-w-sm truncate text-xs text-muted-foreground" title={detail}>
                {detail}
              </p>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor((supporter) => supporter.discordId ?? "", {
      id: "discord",
      header: ({ column }) => <SortHeader column={column}>Discord</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) =>
        row.original.discordId ? (
          <span className="font-mono text-xs text-muted-foreground">{row.original.discordId}</span>
        ) : (
          <span className="text-muted-foreground">Not linked</span>
        ),
    }),
    columnHelper.accessor((supporter) => supporter.steamId ?? "", {
      id: "steamId",
      header: ({ column }) => <SortHeader column={column}>SteamID</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) =>
        row.original.steamId ? (
          <span className="font-mono text-xs text-muted-foreground">{row.original.steamId}</span>
        ) : (
          <span className="text-muted-foreground">Not linked</span>
        ),
    }),
    columnHelper.accessor((supporter) => supporter.latestPayment?.paidAt ?? "", {
      id: "payment",
      header: ({ column }) => <SortHeader column={column}>Latest payment</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => {
        const payment = row.original.latestPayment;
        return (
          <span className="text-muted-foreground">
            {formatSupporterPayment(row.original)}
            {payment?.verificationState === "unverified" ? " · unverified" : ""}
          </span>
        );
      },
    }),
  ]);
}
