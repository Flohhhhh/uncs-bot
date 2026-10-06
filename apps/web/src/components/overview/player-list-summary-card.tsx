"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowRightIcon, UsersIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  factionFor,
  apiResponseCacheKey,
  overviewSchema,
  readAdminApi,
  serverApiPath,
} from "~/components/overview/overview-data";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };

export function PlayerListSummaryCard({ serverId }: { serverId: string }) {
  const path = serverApiPath(serverId, "overview");
  const { data, error, isLoading, mutate } = useSWR(
    apiResponseCacheKey(path, "overview"),
    ([url]) => readAdminApi(url, overviewSchema),
    refreshOptions,
  );
  const players = [...(data?.players ?? [])]
    .sort((first, second) => (second.kills ?? -1) - (first.kills ?? -1) || first.name.localeCompare(second.name))
    .slice(0, 8);
  const teams = data?.status.factionScores ?? [];
  return (
    <Card className="h-full min-h-0">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Top Players</CardTitle>
        </div>
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          href={`/admin/players?server=${encodeURIComponent(serverId)}`}
        >
          All Players
          <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </CardHeader>
      <CardContent className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {isLoading ? (
          <div aria-label="Loading player list" className="space-y-3">
            {[0, 1, 2, 3, 4].map((item) => (
              <Skeleton className="h-9 w-full" key={item} />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground" role="alert">
            <p>The player list could not be loaded.</p>
            <Button variant="outline" size="xs" onClick={() => void mutate()}>
              Try again
            </Button>
          </div>
        ) : players.length ? (
          <div className="divide-y">
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem] gap-3 px-1 pb-2 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
              <span>Player</span>
              <span className="text-right">K / D</span>
              <span className="text-right">Ping</span>
            </div>
            {players.map((player) => {
              const faction = factionFor(player, teams);
              return (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem] items-center gap-3 py-2.5 text-sm"
                  key={player.steamId}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${faction?.tone.dot ?? "bg-slate-500"}`}
                    />
                    <p className="min-w-0 truncate font-medium" title={player.name}>
                      {player.name}
                      {faction ? <span className="sr-only">, {faction.name}</span> : null}
                    </p>
                  </div>
                  <span className="text-right tabular-nums" aria-label="Kills and deaths">
                    {player.kills ?? "—"} / {player.deaths ?? "—"}
                  </span>
                  <span className="text-right text-xs text-muted-foreground tabular-nums">
                    {player.pingMs ?? "—"} ms
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 py-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <UsersIcon aria-hidden="true" className="size-4" />
              <p>{data?.unlinkedPlayerCount ? "Player identities are still loading." : "No players on the server."}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
