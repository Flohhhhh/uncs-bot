"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";

import {
  applicationRelationships,
  applicationStatuses,
  formatSubmittedAt,
  type WhitelistApplication,
} from "./whitelist-data";
import type { ApplicationTableFeatures } from "./application-table-features";

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

const columnHelper = createColumnHelper<ApplicationTableFeatures, WhitelistApplication>();

export function createApplicationColumns({
  selectedIds,
  selectableIds,
  onToggle,
  onToggleAll,
  onInspect,
  disabled,
}: {
  selectedIds: ReadonlySet<string>;
  selectableIds: string[];
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
  onInspect: (application: WhitelistApplication) => void;
  disabled: boolean;
}) {
  const selectedCount = selectableIds.filter((id) => selectedIds.has(id)).length;
  const selectAllState = selectedCount === 0 ? false : selectedCount === selectableIds.length ? true : "indeterminate";

  return columnHelper.columns([
    columnHelper.display({
      id: "select",
      header: () => (
        <Checkbox
          checked={selectAllState}
          disabled={disabled || selectableIds.length === 0}
          onCheckedChange={(checked) => onToggleAll(selectableIds, checked === true)}
          aria-label="Select all matching pending applications"
        />
      ),
      cell: ({ row }) =>
        row.original.status === "pending" ? (
          <Checkbox
            checked={selectedIds.has(row.original.id)}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(row.original.id, checked === true)}
            aria-label={"Select " + row.original.discordDisplayName}
          />
        ) : null,
      enableSorting: false,
    }),
    columnHelper.accessor("discordDisplayName", {
      id: "applicant",
      header: ({ column }) => <SortHeader column={column}>Discord / SteamID</SortHeader>,
      sortFn: "alphanumeric",
      cell: ({ row }) => (
        <div className="min-w-44 py-1">
          <p className="font-medium">{row.original.discordDisplayName}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.original.steamId}</p>
        </div>
      ),
    }),
    columnHelper.accessor((application) => applicationRelationships[application.relationship], {
      id: "relationship",
      header: ({ column }) => <SortHeader column={column}>Community connection</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => (
        <span className="text-muted-foreground">{applicationRelationships[row.original.relationship]}</span>
      ),
    }),
    columnHelper.accessor((application) => Date.parse(application.submittedAt), {
      id: "submitted",
      header: ({ column }) => <SortHeader column={column}>Submitted</SortHeader>,
      sortFn: "basic",
      cell: ({ row }) => (
        <time dateTime={row.original.submittedAt} className="whitespace-nowrap text-muted-foreground tabular-nums">
          {formatSubmittedAt(row.original.submittedAt)}
        </time>
      ),
    }),
    columnHelper.accessor((application) => applicationStatuses[application.status], {
      id: "status",
      header: ({ column }) => <SortHeader column={column}>Status</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => {
        const pending = row.original.status === "pending" || row.original.status === "declined";
        return (
          <Badge variant={row.original.status === "approved" ? "default" : pending ? "secondary" : "outline"}>
            {applicationStatuses[row.original.status]}
          </Badge>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span>Actions</span>,
      cell: ({ row }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={() => onInspect(row.original)}
        >
          View request
        </Button>
      ),
      enableSorting: false,
    }),
  ]);
}
