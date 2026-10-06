"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

import { useAdminGameMode, useSelectedAdminServer } from "~/components/admin-server-context";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { activitySchema, combatSchema, readAdminApi, serverApiPath } from "~/components/overview/overview-data";

import { ActivityFilterRail } from "./activity-filter-rail";
import {
  activityCategories,
  activitySearchText,
  combineActivity,
  sampleActivityEntries,
  type ActivityCategory,
} from "./activity-data";
import { ActivityTable } from "./activity-table";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };

export function ActivitySurface() {
  const server = useSelectedAdminServer();
  const sampleMode = useAdminGameMode() === "sample";
  return server ? <ServerActivity key={server.id} serverId={server.id} sampleMode={sampleMode} /> : null;
}

function ServerActivity({ serverId, sampleMode }: { serverId: string; sampleMode: boolean }) {
  const activityPath = serverApiPath(serverId, "activity");
  const combatPath = sampleMode ? null : serverApiPath(serverId, "combat?period=day");
  const activity = useSWR(activityPath, (path) => readAdminApi(path, activitySchema), refreshOptions);
  const combat = useSWR(combatPath, (path) => readAdminApi(path, combatSchema), refreshOptions);
  const [query, setQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<ActivityCategory[]>([...activityCategories]);

  const sampleEntries = useMemo(() => (sampleMode ? sampleActivityEntries() : []), [sampleMode]);
  const entries = useMemo(
    () => [...combineActivity(activity.data, combat.data), ...sampleEntries],
    [activity.data, combat.data, sampleEntries],
  );
  const counts = useMemo(
    () =>
      entries.reduce<Record<ActivityCategory, number>>(
        (total, entry) => ({ ...total, [entry.category]: total[entry.category] + 1 }),
        { players: 0, match: 0, connection: 0, combat: 0 },
      ),
    [entries],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          selectedCategories.includes(entry.category) &&
          (!normalizedQuery || activitySearchText(entry).includes(normalizedQuery)),
      ),
    [entries, normalizedQuery, selectedCategories],
  );

  const reads = [activity, combat];
  const hasData = Boolean(activity.data || combat.data);
  const loading = reads.some((read) => read.isLoading);
  const failedReads = reads.filter((read) => read.error).length;
  const allFailed = failedReads === reads.length;
  const retry = () => void Promise.all([activity.mutate(), combat.mutate()]);
  const emptyMessage = selectedCategories.length
    ? normalizedQuery
      ? "No matching activity."
      : "No activity recorded yet."
    : "Select an activity category to show events.";

  return (
    <section className="flex h-[calc(100svh-3rem)] min-h-0 flex-none flex-col gap-5 overflow-hidden p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <Button variant="secondary" size="sm" disabled={loading} onClick={retry}>
          Refresh
        </Button>
      </header>
      <ActivityFilterRail
        query={query}
        onQueryChange={setQuery}
        selectedCategories={selectedCategories}
        onSelectedCategoriesChange={setSelectedCategories}
        counts={counts}
        resultCount={filteredEntries.length}
      />
      {failedReads > 0 && hasData && (
        <Alert>
          <AlertTitle>Some activity could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>The last loaded events are still shown. Refresh to try again.</span>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {allFailed ? (
        <Alert variant="destructive">
          <AlertTitle>Activity unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Activity events could not be loaded for this server.</span>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : loading && !hasData ? (
        <div
          aria-label="Loading activity"
          className="min-h-0 flex-1 space-y-3 overflow-hidden rounded-md border p-4"
          role="status"
        >
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton className="h-10 w-full" key={row} />
          ))}
        </div>
      ) : (
        <ActivityTable entries={filteredEntries} emptyMessage={emptyMessage} />
      )}
    </section>
  );
}
