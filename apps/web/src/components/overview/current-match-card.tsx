"use client";

import useSWR from "swr";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  factionFor,
  factionTone,
  apiResponseCacheKey,
  overviewSchema,
  readAdminApi,
  serverApiPath,
} from "~/components/overview/overview-data";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const SCORE_MAX = 100;

export function CurrentMatchCard({ serverId }: { serverId: string }) {
  const path = serverApiPath(serverId, "overview");
  const { data, error, isLoading, mutate } = useSWR(
    apiResponseCacheKey(path, "overview"),
    ([url]) => readAdminApi(url, overviewSchema),
    refreshOptions,
  );
  const teams = data?.status.factionScores ?? [];

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <CardTitle>Current match</CardTitle>
        {data ? (
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold tabular-nums">
              {data.status.players.current}
              <span className="font-normal text-muted-foreground"> / {data.status.players.max}</span>
            </p>
          </div>
        ) : isLoading ? (
          <Skeleton aria-label="Loading player count" className="h-7 w-28" />
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-5" aria-label="Loading team scores">
            {[0, 1, 2].map((item) => (
              <div className="space-y-2" key={item}>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground" role="alert">
            <p>Match scores could not be loaded.</p>
            <Button variant="outline" size="xs" onClick={() => void mutate()}>
              Try again
            </Button>
          </div>
        ) : teams.length ? (
          <div className="space-y-5">
            {teams.map((team) => {
              const score = Math.min(SCORE_MAX, Math.max(0, team.score));
              const progress = (score / SCORE_MAX) * 100;
              const tone = factionTone(team.name);
              const playerCount =
                data?.players.filter((player) => factionFor(player, teams)?.name === team.name).length ?? 0;
              return (
                <div className="space-y-2.5" key={team.name}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${tone.dot}`} />
                      <span className="truncate">{team.name}</span>
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">{playerCount} players</span>
                    </span>
                    <strong className="shrink-0 tabular-nums">{score.toLocaleString()}</strong>
                  </div>
                  <div
                    aria-label={`${team.name} score`}
                    aria-valuemax={SCORE_MAX}
                    aria-valuemin={0}
                    aria-valuenow={score}
                    className="h-2 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                  >
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ${tone.bar}`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Waiting for team scores.</p>
        )}
      </CardContent>
    </Card>
  );
}
