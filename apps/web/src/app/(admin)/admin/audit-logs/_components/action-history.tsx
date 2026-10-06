"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

import { apiResponseCacheKey, overviewSchema, readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import type { AdminServer } from "~/lib/admin-servers";

import { ActionHistoryTable } from "./action-history-table";
import { actionIdPattern, actionSearchText, auditListSchema, auditReceiptSchema } from "./audit-data";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };

export function ActionHistory({ server, initialQuery = "" }: { server: AdminServer; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const lookupId = actionIdPattern.test(query.trim()) ? query.trim().toLowerCase() : "";
  const overviewPath = serverApiPath(server.id, "overview");
  const recentPath = serverApiPath(server.id, "audit");
  const receiptPath = lookupId ? serverApiPath(server.id, `audit/${encodeURIComponent(lookupId)}`) : null;
  const overview = useSWR(
    apiResponseCacheKey(overviewPath, "overview"),
    ([path]) => readAdminApi(path, overviewSchema),
    refreshOptions,
  );
  const recent = useSWR(lookupId ? null : recentPath, (path) => readAdminApi(path, auditListSchema), {
    ...refreshOptions,
    keepPreviousData: true,
  });
  const receipt = useSWR(receiptPath, (path) => readAdminApi(path, auditReceiptSchema), {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const playerNames = useMemo(
    () => new Map((overview.data?.players ?? []).map((player) => [player.steamId, player.name])),
    [overview.data?.players],
  );
  const rows = useMemo(() => {
    if (lookupId) return receipt.data?.record ? [receipt.data.record] : [];
    return (recent.data ?? []).filter((entry) =>
      actionSearchText(entry, playerNames.get(entry.target) ?? entry.details?.playerName ?? "").includes(
        normalizedQuery,
      ),
    );
  }, [lookupId, normalizedQuery, playerNames, receipt.data, recent.data]);
  const error = lookupId ? receipt.error : recent.error;
  const loading = lookupId ? receipt.isLoading && !receipt.data : recent.isLoading && !recent.data;
  const staleData = lookupId ? receipt.data !== undefined : recent.data !== undefined;
  const retry = lookupId ? () => void receipt.mutate() : () => void recent.mutate();
  const emptyMessage = lookupId
    ? "No stored receipt for this action ID. This does not establish whether the game acted; verify the result before repeating an uncertain request."
    : normalizedQuery
      ? "No matching staff actions."
      : "No recorded staff actions.";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
        <div className="flex min-w-64 flex-1 items-center gap-3">
          <Input
            aria-label="Search staff action history"
            placeholder="Search staff, player, SteamID, reason, or action ID"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="max-w-xl"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={retry}>
            Refresh
          </Button>
        </div>
      </div>

      {error && staleData ? (
        <Alert>
          <AlertTitle>Action history refresh failed</AlertTitle>
          <AlertDescription>The last successful result is still shown. Refresh to try again.</AlertDescription>
        </Alert>
      ) : null}

      {error && !staleData ? (
        <Alert variant="destructive">
          <AlertTitle>
            {lookupId ? "Action receipt could not be loaded" : "Action history could not be loaded"}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Refresh to try this read again. No game action was sent.</span>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : loading && !staleData ? (
        <div
          className="min-h-0 flex-1 space-y-3 overflow-hidden rounded-md border p-4"
          aria-label="Loading action history"
          role="status"
        >
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton key={row} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <ActionHistoryTable entries={rows} playerNames={playerNames} emptyMessage={emptyMessage} />
      )}
    </div>
  );
}
