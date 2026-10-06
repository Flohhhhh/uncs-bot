"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import { createColumnHelper, useTable, type SortingState } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { actionLabels, formatAuditTime, type AuditEntry } from "./audit-data";
import { auditTableFeatures, type AuditTableFeatures } from "./audit-table-features";

type ActionRow = AuditEntry & { playerName: string; occurredAt: number };

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

function Outcome({ state }: { state: AuditEntry["state"] }) {
  const variant = state === "failed" ? "destructive" : state === "applied" ? "default" : "secondary";
  return <Badge variant={variant}>{state}</Badge>;
}

const columnHelper = createColumnHelper<AuditTableFeatures, ActionRow>();

export function ActionHistoryTable({
  entries,
  playerNames,
  emptyMessage,
}: {
  entries: AuditEntry[];
  playerNames: ReadonlyMap<string, string>;
  emptyMessage: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "when", desc: true }]);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = useCallback(
    (id: string) =>
      setExpandedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const rows = useMemo(
    () =>
      entries.map((entry) => ({
        ...entry,
        playerName: /^\d{17}$/.test(entry.target)
          ? (playerNames.get(entry.target) ?? entry.details?.playerName ?? "")
          : "",
        occurredAt: Date.parse(entry.createdAt),
      })),
    [entries, playerNames],
  );
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("occurredAt", {
          id: "when",
          header: ({ column }) => <SortHeader column={column}>When</SortHeader>,
          sortFn: "basic",
          cell: ({ row }) => (
            <time
              dateTime={Number.isFinite(row.original.occurredAt) ? row.original.createdAt : undefined}
              title={
                Number.isFinite(row.original.occurredAt)
                  ? new Date(row.original.occurredAt).toLocaleString()
                  : undefined
              }
              className="block w-36 text-sm whitespace-nowrap text-muted-foreground tabular-nums"
            >
              {formatAuditTime(row.original.createdAt)}
            </time>
          ),
        }),
        columnHelper.accessor("actorName", {
          header: ({ column }) => <SortHeader column={column}>Staff</SortHeader>,
          sortFn: "text",
          cell: ({ row }) => <span className="font-medium">{row.original.actorName}</span>,
        }),
        columnHelper.accessor((row) => actionLabels[row.action], {
          id: "action",
          header: ({ column }) => <SortHeader column={column}>Action / target</SortHeader>,
          sortFn: "text",
          cell: ({ row }) => {
            const player = /^\d{17}$/.test(row.original.target);
            return (
              <div className="min-w-48 py-1">
                <p className="font-medium">{actionLabels[row.original.action]}</p>
                {player ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    {row.original.playerName ? `${row.original.playerName} · ` : ""}
                    {row.original.target}
                  </p>
                ) : row.original.target !== "server" ? (
                  <p className="text-xs text-muted-foreground">{row.original.target}</p>
                ) : null}
              </div>
            );
          },
        }),
        columnHelper.accessor("state", {
          header: ({ column }) => <SortHeader column={column}>Outcome</SortHeader>,
          sortFn: "text",
          cell: ({ row }) => <Outcome state={row.original.state} />,
        }),
        columnHelper.accessor((row) => [row.details?.reason, row.message].filter(Boolean).join(" "), {
          id: "result",
          header: ({ column }) => <SortHeader column={column}>Reason & result</SortHeader>,
          sortFn: "text",
          cell: ({ row }) => (
            <div className="min-w-56 py-1 whitespace-normal">
              {row.original.details?.reason ? <p>{row.original.details.reason}</p> : null}
              {row.original.message ? (
                <p className="mt-1 text-sm text-muted-foreground">{row.original.message}</p>
              ) : null}
            </div>
          ),
        }),
        columnHelper.display({
          id: "details",
          header: () => <span>Details</span>,
          cell: ({ row }) => {
            const expanded = expandedIds.has(row.original.id);
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                aria-controls={`audit-details-${row.original.id}`}
                onClick={() => toggleExpanded(row.original.id)}
              >
                {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
                Details
              </Button>
            );
          },
          enableSorting: false,
        }),
      ]),
    [expandedIds, toggleExpanded],
  );
  const table = useTable({
    features: auditTableFeatures,
    data: rows,
    columns,
    getRowId: (entry) => entry.id,
    state: { sorting },
    onSortingChange: setSorting,
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
      <Table
        aria-label="Staff action history"
        className="min-w-[68rem]"
        containerClassName="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain"
      >
        <TableHeader className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} className={header.id === "when" ? "w-40" : undefined}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => {
              const expanded = expandedIds.has(row.original.id);
              const sentMessage = row.original.details?.message;
              return (
                <Fragment key={row.id}>
                  <TableRow className={row.index % 2 === 1 ? "bg-muted/30" : undefined}>
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className={cell.column.id === "when" ? "whitespace-nowrap" : undefined}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                  {expanded ? (
                    <TableRow id={`audit-details-${row.original.id}`} className="bg-muted/20">
                      <TableCell colSpan={table.getAllLeafColumns().length}>
                        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                          <div className="min-w-0">
                            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                              Action ID
                            </dt>
                            <dd className="mt-1 font-mono text-xs break-all">{row.original.id}</dd>
                          </div>
                          {sentMessage ? (
                            <div className="min-w-0">
                              <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                Message sent
                              </dt>
                              <dd className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
                                {sentMessage}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })
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
