"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Button } from "~/components/ui/button";
import { activityCategoryDetails, activityMessageParts, type ActivityRow } from "./activity-data";
import type { ActivityTableFeatures } from "./activity-table-features";

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

const columnHelper = createColumnHelper<ActivityTableFeatures, ActivityRow>();

export function createActivityColumns() {
  return columnHelper.columns([
    columnHelper.accessor(
      (row) => {
        const time = Date.parse(row.at);
        return Number.isFinite(time) ? time : 0;
      },
      {
        id: "time",
        header: ({ column }) => <SortHeader column={column}>Time</SortHeader>,
        sortFn: "basic",
        cell: ({ row }) => {
          const time = Date.parse(row.original.at);
          const valid = Number.isFinite(time);
          return (
            <time
              className="block w-36 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
              dateTime={valid ? new Date(time).toISOString() : undefined}
              title={valid ? new Date(time).toLocaleString() : undefined}
            >
              {valid
                ? new Date(time).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : "Time unavailable"}
            </time>
          );
        },
      },
    ),
    columnHelper.accessor("category", {
      header: ({ column }) => <SortHeader column={column}>Category</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => {
        const { Icon, label } = activityCategoryDetails[row.original.category];
        return (
          <span className="inline-flex min-w-40 items-center gap-2 text-sm text-muted-foreground">
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            {label}
          </span>
        );
      },
    }),
    columnHelper.accessor("message", {
      header: ({ column }) => <SortHeader column={column}>Activity</SortHeader>,
      sortFn: "text",
      cell: ({ row }) => {
        const parts = activityMessageParts(row.original);
        return (
          <div className="min-w-0 py-1 whitespace-normal">
            <p className="leading-5 break-words">
              {parts.map((part, index) => (
                <span
                  className={
                    part.tone === "player"
                      ? "font-medium text-foreground"
                      : part.tone === "team"
                        ? (part.teamClass ?? "text-muted-foreground")
                        : "text-muted-foreground"
                  }
                  key={index}
                >
                  {part.text}
                </span>
              ))}
            </p>
            {row.original.detail ? (
              <p className="mt-1 text-sm leading-5 break-words text-muted-foreground">{row.original.detail}</p>
            ) : null}
          </div>
        );
      },
    }),
  ]);
}
