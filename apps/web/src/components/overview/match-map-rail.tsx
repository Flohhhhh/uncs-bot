"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowRightIcon, Clock3Icon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useSelectedAdminServer } from "~/components/admin-server-context";
import {
  formatCurrentSetup,
  formatElapsed,
  formatObservedTime,
  mapDisplayName,
  overviewSchema,
  readAdminApi,
  rotationSchema,
  runningNextRound,
  serverApiPath,
  settingsNextRound,
  settingsSchema,
  voteListSchema,
  voteSummary,
} from "~/components/overview/overview-data";

const liveOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const setupOptions = { refreshInterval: 30_000, revalidateOnFocus: true, revalidateOnReconnect: true };

export function MatchMapRail({ serverId }: { serverId: string }) {
  const selectedServer = useSelectedAdminServer();
  const overviewPath = serverApiPath(serverId, "overview");
  const settingsPath = selectedServer?.role === "admin" ? serverApiPath(serverId, "settings") : null;
  const rotationPath = selectedServer && selectedServer.role !== "admin" ? serverApiPath(serverId, "rotation") : null;
  const votesPath = selectedServer?.role === "admin" ? serverApiPath(serverId, "map-votes") : null;

  const overview = useSWR(overviewPath, (path) => readAdminApi(path, overviewSchema), liveOptions);
  const settings = useSWR(settingsPath, (path) => readAdminApi(path, settingsSchema), setupOptions);
  const rotation = useSWR(rotationPath, (path) => readAdminApi(path, rotationSchema), setupOptions);
  const votes = useSWR(votesPath, (path) => readAdminApi(path, voteListSchema), setupOptions);

  const status = overview.data?.status;
  const nextRound = status
    ? selectedServer?.role === "admin"
      ? settings.data && !settings.error
        ? settingsNextRound(settings.data.rotation, status.map)
        : null
      : rotation.data && !rotation.error
        ? runningNextRound(rotation.data, status.map)
        : null
    : null;
  const nextError = selectedServer?.role === "admin" ? settings.error : rotation.error;
  const voteLabel = votes.data && !votes.error ? voteSummary(votes.data) : votes.error ? "Unavailable" : "Checking…";

  return (
    <section
      aria-label="Current and next match maps"
      className="grid h-full w-full grid-cols-1 divide-y overflow-hidden rounded-lg border bg-card shadow-sm"
    >
      <div className="flex min-w-0 items-start gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Current</p>
          {overview.isLoading ? (
            <Skeleton className="mt-1 h-6 w-40" />
          ) : status ? (
            <>
              <p className="truncate font-semibold">{mapDisplayName(status.map)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {[formatCurrentSetup(status), formatElapsed(status.matchSeconds)].filter(Boolean).join(" · ")}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{overview.error ? "Unavailable" : "Checking…"}</p>
          )}
        </div>
        {overview.data?.observedAt ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 pt-0.5 text-[0.6875rem] text-muted-foreground">
            <Clock3Icon aria-hidden="true" className="size-3" />
            {formatObservedTime(overview.data.observedAt)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">Next</p>
          {nextRound ? (
            <>
              <p className="truncate font-semibold" title={nextRound.label}>
                {nextRound.label}
              </p>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{nextRound.note}</span>
                {selectedServer?.role === "admin" ? (
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden="true">·</span>Vote <Badge variant="outline">{voteLabel}</Badge>
                  </span>
                ) : null}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {overview.error || nextError
                ? "Unavailable"
                : settings.isLoading || rotation.isLoading
                  ? "Checking…"
                  : "Not confirmed"}
            </p>
          )}
        </div>
        <Link
          className="mt-4 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          href={`/admin/match?server=${encodeURIComponent(serverId)}`}
        >
          Match <ArrowRightIcon aria-hidden="true" className="size-3" />
        </Link>
      </div>
    </section>
  );
}
