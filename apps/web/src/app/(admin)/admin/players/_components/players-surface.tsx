"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type { RowSelectionState } from "@tanstack/react-table";

import { apiResponseCacheKey, readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { useSelectedAdminServer } from "~/components/admin-server-context";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";

import { PlayerActionReviewDialog } from "./player-action-review-dialog";
import { PlayerInspectionDrawer } from "./player-inspection-drawer";
import { PlayerTable } from "./player-table";
import type { PlayerTableRow } from "./player-columns";
import {
  canPlayerAction,
  isRosterFresh,
  playersOverviewSchema,
  teamFor,
  type PlayerAction,
  type PlayersOverview,
} from "./players-data";
import { PlayersFilterRail, type TeamFilterOption } from "./players-filter-rail";
import { TeamMoveReviewDialog, type TeamMoveCompletion } from "./team-move-review-dialog";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const initialSelection: RowSelectionState = {};

type ReviewAction = Exclude<PlayerAction, "team">;

function decoratePlayer(
  player: PlayersOverview["players"][number],
  teams: PlayersOverview["status"]["factionScores"],
): PlayerTableRow {
  const team = teamFor(player, teams) ?? null;
  return { ...player, team, teamName: team?.name ?? player.faction ?? "Unassigned" };
}

function searchText(player: PlayerTableRow) {
  return [
    player.name,
    player.steamId,
    player.teamName,
    player.faction,
    player.kills ?? "—",
    player.deaths ?? "—",
    player.pingMs === undefined ? "—" : `${player.pingMs} ms`,
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

export function PlayersSurface({ csrf }: { csrf: string }) {
  const server = useSelectedAdminServer();
  return server ? <PlayersRoster key={server.id} server={server} csrf={csrf} /> : null;
}

function PlayersRoster({
  server,
  csrf,
}: {
  server: NonNullable<ReturnType<typeof useSelectedAdminServer>>;
  csrf: string;
}) {
  const overviewPath = serverApiPath(server.id, "overview");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>(initialSelection);
  const onRosterSuccess = useCallback(
    (fresh: PlayersOverview) => {
      const rosterIds = new Set(fresh.players.map((player) => player.steamId));
      setRowSelection((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([id]) => rosterIds.has(id)));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    },
    [setRowSelection],
  );
  const { data, error, isLoading, mutate } = useSWR(
    apiResponseCacheKey(overviewPath, "players-overview"),
    ([path]) => readAdminApi(path, playersOverviewSchema),
    { ...refreshOptions, onSuccess: onRosterSuccess },
  );

  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState("all");
  const [uncOnly, setUncOnly] = useState(false);
  const [inspectedSnapshot, setInspectedSnapshot] = useState<PlayerTableRow | null>(null);
  const [moveReview, setMoveReview] = useState<{ players: PlayerTableRow[]; initialTeam: string } | null>(null);
  const [actionReview, setActionReview] = useState<{ player: PlayerTableRow; action: ReviewAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastMove, setLastMove] = useState<TeamMoveCompletion | null>(null);

  const players = useMemo(() => {
    if (!data) return [];
    const teams = data.status.factionScores.filter(
      (team, index, all) => team.name && all.findIndex((other) => other.name === team.name) === index,
    );
    return data.players.map((player) => decoratePlayer(player, teams));
  }, [data]);
  const teams =
    data?.status.factionScores.filter(
      (team, index, all) => team.name && all.findIndex((other) => other.name === team.name) === index,
    ) ?? [];
  const unassignedPlayers = players.filter((player) => !player.team);
  const unassignedCount = unassignedPlayers.length;
  const filterTeams: TeamFilterOption[] = teams.map((team) => ({
    id: `team:${team.name}`,
    name: team.name,
    count: players.filter((player) => player.team?.name === team.name).length,
  }));
  if (teamFilter.startsWith("team:") && !filterTeams.some((team) => team.id === teamFilter)) {
    filterTeams.push({ id: teamFilter, name: `${teamFilter.slice(5)} (not in this match)`, count: 0 });
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPlayers = players.filter((player) => {
    const matchesTeam =
      teamFilter === "all" ||
      (teamFilter === "unassigned" && !player.team) ||
      (teamFilter.startsWith("team:") && player.team?.name === teamFilter.slice(5));
    const matchesName = !uncOnly || player.name.toLocaleLowerCase().includes("unc");
    return matchesTeam && matchesName && (!normalizedQuery || searchText(player).includes(normalizedQuery));
  });

  const selectedPlayers = players.filter((player) => rowSelection[player.steamId]);
  const filteredIds = new Set(filteredPlayers.map((player) => player.steamId));
  const hasHiddenSelection = selectedPlayers.some((player) => !filteredIds.has(player.steamId));
  const stale = !data || !isRosterFresh(data);

  const inspectPlayer = useCallback((player: PlayerTableRow) => setInspectedSnapshot(player), []);
  const closeInspection = useCallback((open: boolean) => {
    if (!open) setInspectedSnapshot(null);
  }, []);

  function openTeamMove(playersToMove: PlayerTableRow[], initialTeam = "") {
    if (!playersToMove.length || !data) return;
    setMoveReview({ players: playersToMove, initialTeam });
  }

  function completeTeamMove(completion: TeamMoveCompletion) {
    setLastMove(completion.stopped ? completion : null);
    const attempted = new Set(completion.attemptedIds);
    setRowSelection((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !attempted.has(id))));
    void mutate();
  }

  const inspectedPlayer = inspectedSnapshot
    ? (players.find((player) => player.steamId === inspectedSnapshot.steamId) ?? inspectedSnapshot)
    : null;
  const inspectedLive = Boolean(
    inspectedPlayer && players.some((player) => player.steamId === inspectedPlayer.steamId),
  );
  const actionAllowed = Boolean(
    actionReview && inspectedLive && server && canPlayerAction(actionReview.action, server.role, data, stale, busy),
  );

  return (
    <section className="flex h-[calc(100svh-3rem)] min-h-0 flex-none flex-col gap-5 overflow-hidden p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        {selectedPlayers.length > 0 ? (
          <>
            <h1 className="sr-only">Players</h1>
            <div className="flex h-full w-full items-center justify-between gap-3 rounded-lg border bg-card px-4">
              <p className="min-w-0 truncate text-sm font-medium" role="status">
                {selectedPlayers.length} selected{hasHiddenSelection ? " · includes hidden players" : ""}
              </p>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setRowSelection({})}>
                Clear selection
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">Players</h1>
            <Button variant="secondary" size="sm" disabled={!server || isLoading} onClick={() => void mutate()}>
              Refresh
            </Button>
          </>
        )}
      </header>

      {isLoading && !data ? (
        <Card>
          <CardHeader>
            <CardTitle>Loading players</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : error && !data ? (
        <Alert variant="destructive">
          <AlertTitle>Player list unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>The current server roster could not be loaded.</span>
            <Button variant="outline" size="sm" onClick={() => void mutate()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : data ? (
        <>
          {error && (
            <Alert>
              <AlertTitle>Roster refresh failed</AlertTitle>
              <AlertDescription>
                The last loaded roster is still shown. Try refreshing before using player controls.
              </AlertDescription>
            </Alert>
          )}
          {!!data.unlinkedPlayerCount && (
            <Alert>
              <AlertTitle>Incomplete player roster</AlertTitle>
              <AlertDescription>
                {data.unlinkedPlayerCount} roster {data.unlinkedPlayerCount === 1 ? "entry has" : "entries have"} no
                usable SteamID and cannot be selected for player actions.
              </AlertDescription>
            </Alert>
          )}
          <PlayersFilterRail
            query={query}
            onQueryChange={setQuery}
            teamFilter={teamFilter}
            onTeamFilterChange={setTeamFilter}
            uncOnly={uncOnly}
            onUncOnlyChange={setUncOnly}
            rosterCount={players.length}
            teams={filterTeams}
            unassignedCount={unassignedCount}
          />
          {lastMove && (
            <Alert variant="destructive">
              <AlertTitle>Team move stopped</AlertTitle>
              <AlertDescription>
                {lastMove.attemptedIds.length} action{lastMove.attemptedIds.length === 1 ? " was" : "s were"} attempted.
                Players with no request sent remain selected; check each action result before trying again.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            {players.length ? (
              <PlayerTable
                players={filteredPlayers}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                onInspect={inspectPlayer}
              />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">No players are currently in the roster.</p>
            )}
          </div>
          <PlayerInspectionDrawer
            open={Boolean(inspectedPlayer)}
            onOpenChange={closeInspection}
            player={inspectedPlayer}
            live={inspectedLive}
            overview={data}
            role={server.role}
            stale={stale}
            busy={busy}
            onAction={(action, player) => setActionReview({ player: decoratePlayer(player, teams), action })}
            onMove={(teamName) => inspectedPlayer && openTeamMove([inspectedPlayer], teamName)}
          />
          {server && moveReview && (
            <TeamMoveReviewDialog
              key={`${server.id}:${moveReview.players.map((player) => player.steamId).join(",")}`}
              open
              onOpenChange={(open) => !open && setMoveReview(null)}
              players={moveReview.players}
              overview={data}
              server={server}
              csrf={csrf}
              role={server.role}
              initialTeam={moveReview.initialTeam}
              onBusyChange={setBusy}
              onComplete={completeTeamMove}
            />
          )}
          {server && data && actionReview && (
            <PlayerActionReviewDialog
              key={`${actionReview.action}:${actionReview.player.steamId}`}
              open
              onOpenChange={(open) => !open && setActionReview(null)}
              action={actionReview.action}
              player={actionReview.player}
              overview={data}
              server={server}
              csrf={csrf}
              allowed={actionAllowed}
              onBusyChange={setBusy}
              onComplete={() => void mutate()}
            />
          )}
        </>
      ) : null}
    </section>
  );
}
