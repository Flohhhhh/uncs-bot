"use client";

import { useMemo, useState } from "react";
import { useTable, type PaginationState, type SortingState } from "@tanstack/react-table";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import { APPLICATION_PAGE_SIZE, type WhitelistApplication } from "./whitelist-data";
import { createApplicationColumns } from "./application-columns";
import { applicationTableFeatures } from "./application-table-features";

export function ApplicationsTable({
  applications,
  selectedIds,
  onToggle,
  onToggleAll,
  onInspect,
  disabled,
}: {
  applications: WhitelistApplication[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
  onInspect: (application: WhitelistApplication) => void;
  disabled: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: APPLICATION_PAGE_SIZE });
  const selectableIds = useMemo(
    () => applications.filter((application) => application.status === "pending").map((application) => application.id),
    [applications],
  );
  const columns = useMemo(
    () =>
      createApplicationColumns({
        selectedIds,
        selectableIds,
        onToggle,
        onToggleAll,
        onInspect,
        disabled,
      }),
    [disabled, onInspect, onToggle, onToggleAll, selectableIds, selectedIds],
  );
  const table = useTable({
    features: applicationTableFeatures,
    data: applications,
    columns,
    getRowId: (application) => application.id,
    initialState: {
      pagination: { pageIndex: 0, pageSize: APPLICATION_PAGE_SIZE },
      sorting: [],
    },
    state: { pagination, sorting },
    onPaginationChange: setPagination,
    onSortingChange: (updater) => {
      setSorting((current) => (typeof updater === "function" ? updater(current) : updater));
      setPagination((current) => ({ ...current, pageIndex: 0 }));
    },
    autoResetPageIndex: false,
  });
  const pageCount = table.getPageCount();

  const rowCount = table.getRowCount();
  const start = rowCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const end = Math.min(rowCount, (pagination.pageIndex + 1) * pagination.pageSize);

  return (
    <div className="overflow-hidden rounded-md border">
      <Table aria-label="Whitelist applications" className="min-w-[66rem]">
        <TableHeader>
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
                data-state={selectedIds.has(row.id) ? "selected" : undefined}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className={cell.column.id === "select" ? "w-11" : undefined}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={table.getAllLeafColumns().length} className="h-24 text-center text-muted-foreground">
                No matching applications.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card px-3 py-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {rowCount ? "Showing " + start + "–" + end + " of " + rowCount : "No applications to show"}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Page {pageCount ? pagination.pageIndex + 1 : 0} of {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Previous applications page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon aria-hidden="true" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Next applications page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            Next
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
