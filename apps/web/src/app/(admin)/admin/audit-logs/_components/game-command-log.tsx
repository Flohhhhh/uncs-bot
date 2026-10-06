"use client";

import { useMemo, useState } from "react";
import { createColumnHelper, useTable, type SortingState } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import useSWR from "swr";

import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { AdminServer } from "~/lib/admin-servers";

import { auditTableFeatures, type AuditTableFeatures } from "./audit-table-features";
import { formatAuditTime, gameLogSchema, gameLogSearchText, type GameLogEntry } from "./audit-data";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const emptyEntries: GameLogEntry[] = [];

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

type LogRow = GameLogEntry & { key: string; occurredAt: number };
const columnHelper = createColumnHelper<AuditTableFeatures, LogRow>();

export function GameCommandLog({ server }: { server: AdminServer }) {
  const path = serverApiPath(server.id, "game-log");
  const log = useSWR(path, (key) => readAdminApi(key, gameLogSchema), { ...refreshOptions, keepPreviousData: true });
  const [includeAll, setIncludeAll] = useState(false);
  const [query, setQuery] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "when", desc: true }]);
  const allEntries = log.data?.entries ?? emptyEntries;
  const filteredEntries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return allEntries
      .filter((entry) => includeAll || entry.changesState || entry.event === "COMMAND")
      .filter((entry) => !search || gameLogSearchText(entry).includes(search))
      .map((entry, index) => ({
        ...entry,
        key: `${entry.timestamp ?? "undated"}:${entry.event}:${index}`,
        occurredAt: Date.parse(entry.timestamp ?? ""),
      }));
  }, [allEntries, includeAll, query]);
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("occurredAt", {
          id: "when",
          header: ({ column }) => <SortHeader column={column}>When</SortHeader>,
          sortFn: "basic",
          cell: ({ row }) => (
            <time
              dateTime={Number.isFinite(row.original.occurredAt) ? (row.original.timestamp ?? undefined) : undefined}
              title={
                Number.isFinite(row.original.occurredAt)
                  ? new Date(row.original.occurredAt).toLocaleString()
                  : undefined
              }
              className="block w-36 text-sm whitespace-nowrap text-muted-foreground tabular-nums"
            >
              {formatAuditTime(row.original.timestamp)}
            </time>
          ),
        }),
        columnHelper.accessor("event", {
          header: ({ column }) => <SortHeader column={column}>Event</SortHeader>,
          sortFn: "text",
          cell: ({ row }) => <Badge variant="outline">{row.original.event}</Badge>,
        }),
        columnHelper.accessor((entry) => entry.operation ?? "", {
          id: "request",
          header: ({ column }) => <SortHeader column={column}>Request</SortHeader>,
          sortFn: "text",
          cell: ({ row }) => (
            <span className="font-mono text-sm">
              {row.original.operation ?? <span className="font-sans text-muted-foreground">Details omitted</span>}
            </span>
          ),
        }),
        columnHelper.accessor((entry) => entry.statusCode ?? -1, {
          id: "status",
          header: ({ column }) => <SortHeader column={column}>HTTP status</SortHeader>,
          sortFn: "basic",
          cell: ({ row }) => (
            <span className="text-muted-foreground tabular-nums">{row.original.statusCode ?? "—"}</span>
          ),
        }),
      ]),
    [],
  );
  const table = useTable({
    features: auditTableFeatures,
    data: filteredEntries,
    columns,
    getRowId: (entry) => entry.key,
    state: { sorting },
    onSortingChange: setSorting,
  });
  const retry = () => void log.mutate();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      {log.error && log.data ? (
        <Alert>
          <AlertTitle>Game command log refresh failed</AlertTitle>
          <AlertDescription>The last successful snapshot is still shown.</AlertDescription>
        </Alert>
      ) : null}

      {log.error && !log.data ? (
        <Alert variant="destructive">
          <AlertTitle>Game log unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>The command log could not be loaded for this server.</span>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : log.isLoading && !log.data ? (
        <div
          className="min-h-0 flex-1 space-y-3 overflow-hidden rounded-md border p-4"
          aria-label="Loading game command log"
          role="status"
        >
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton key={row} className="h-10 w-full" />
          ))}
        </div>
      ) : log.data && !log.data.available ? (
        <Alert>
          <AlertTitle>This game build does not provide the command log</AlertTitle>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">
              <Input
                aria-label="Search game command log"
                placeholder="Search events, requests, or status"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                className="max-w-md"
              />
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={includeAll} onCheckedChange={(checked) => setIncludeAll(checked === true)} />
                Include reads and connections
              </label>
              {log.data ? (
                <span className="text-sm text-muted-foreground" aria-live="polite">
                  {filteredEntries.length} shown of {allEntries.length} recent · up to {log.data.limit} · read{" "}
                  {formatAuditTime(log.data.observedAt)}
                </span>
              ) : null}
            </div>
            <Button variant="secondary" size="sm" onClick={retry}>
              Refresh game log
            </Button>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
            <Table
              aria-label="Game command log"
              className="min-w-[56rem]"
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
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id} className={row.index % 2 === 1 ? "bg-muted/30" : undefined}>
                      {row.getAllCells().map((cell) => (
                        <TableCell key={cell.id}>
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={table.getAllLeafColumns().length}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {query.trim()
                        ? "No matching log entries."
                        : includeAll
                          ? "No recent listener records."
                          : "No commands in these recent records."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
