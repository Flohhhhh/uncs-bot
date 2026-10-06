"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { PlusIcon } from "lucide-react";

import { useSelectedAdminServer } from "~/components/admin-server-context";
import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";

import { PlayerActionReviewDialog } from "../../players/_components/player-action-review-dialog";
import {
  canPlayerAction,
  isRosterFresh,
  playersOverviewSchema,
  type Player,
  type PlayerAction,
  type PlayersOverview,
} from "../../players/_components/players-data";
import { BanPlayerPickerDialog } from "./ban-player-picker-dialog";
import { banSearchText, bansResponseSchema, isPublicIndividualSteamId, servesBanRoute, type Ban } from "./bans-data";
import { BansTable } from "./bans-table";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const emptyBans: Ban[] = [];
type BanAction = Extract<PlayerAction, "ban" | "unban">;
type ActionReview = { action: BanAction; player: Player; overview: PlayersOverview };

export function BansSurface({ csrf }: { csrf: string }) {
  const server = useSelectedAdminServer();
  return server ? <ServerBans key={server.id} server={server} csrf={csrf} /> : null;
}

function ServerBans({
  server,
  csrf,
}: {
  server: NonNullable<ReturnType<typeof useSelectedAdminServer>>;
  csrf: string;
}) {
  const bansPath = serverApiPath(server.id, "bans");
  const overviewPath = serverApiPath(server.id, "overview");
  const bans = useSWR(bansPath, (path) => readAdminApi(path, bansResponseSchema), {
    ...refreshOptions,
    keepPreviousData: true,
  });
  const overview = useSWR(overviewPath, (path) => readAdminApi(path, playersOverviewSchema), {
    ...refreshOptions,
    keepPreviousData: true,
  });
  const refreshBans = bans.mutate;
  const refreshOverview = overview.mutate;
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionReview, setActionReview] = useState<ActionReview | null>(null);
  const [busy, setBusy] = useState(false);

  const records = bans.data?.bans ?? emptyBans;
  const playerNames = useMemo(
    () => new Map((overview.data?.players ?? []).map((player) => [player.steamId, player.name])),
    [overview.data?.players],
  );
  const rows = useMemo(
    () =>
      records
        .map((ban) => ({ ...ban, playerName: playerNames.get(ban.steamId) ?? null }))
        .filter(
          (ban) =>
            !query.trim() || banSearchText(ban, ban.playerName ?? undefined).includes(query.trim().toLocaleLowerCase()),
        ),
    [playerNames, query, records],
  );

  const stale = !overview.data || Boolean(overview.error) || !isRosterFresh(overview.data);
  const banRouteAvailable = Boolean(
    overview.data && servesBanRoute(overview.data.capabilities.routes, "POST", "/v1/bans"),
  );
  const unbanRouteAvailable = Boolean(
    overview.data && servesBanRoute(overview.data.capabilities.routes, "DELETE", "/v1/bans/{steamId}"),
  );
  const addAllowed = canPlayerAction("ban", server.role, overview.data, stale, busy) && !bans.error && !bans.isLoading;
  const removeAllowed =
    canPlayerAction("unban", server.role, overview.data, stale, busy) && !bans.error && !bans.isLoading;

  const refresh = useCallback(async () => {
    await Promise.all([refreshBans(), refreshOverview()]);
  }, [refreshBans, refreshOverview]);

  const reviewAction = useCallback(
    (action: BanAction, player: Player) => {
      if (!overview.data) return;
      setActionReview({ action, player, overview: overview.data });
    },
    [overview.data],
  );

  const startUnban = useCallback(
    (ban: { steamId: string; playerName: string | null }) => {
      const player = overview.data?.players.find((entry) => entry.steamId === ban.steamId) ?? {
        name: ban.playerName ?? ban.steamId,
        steamId: ban.steamId,
      };
      reviewAction("unban", player);
    },
    [overview.data?.players, reviewAction],
  );

  const reviewAllowed = Boolean(
    actionReview && canPlayerAction(actionReview.action, server.role, overview.data, stale, busy) && !bans.error,
  );
  const invalidCount = records.filter((ban) => !isPublicIndividualSteamId(ban.steamId)).length;
  const retry = () => void refresh();

  return (
    <section className="flex h-[calc(100svh-3rem)] min-h-0 flex-none flex-col gap-5 overflow-hidden p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Bans</h1>
        <Button variant="secondary" size="sm" disabled={bans.isLoading || overview.isLoading} onClick={retry}>
          Refresh
        </Button>
      </header>

      {overview.data && server.role === "viewer" ? (
        <Alert>
          <AlertTitle>Moderator access required to change bans</AlertTitle>
          <AlertDescription>
            You can search the ban list, but only moderators and admins can add or remove bans.
          </AlertDescription>
        </Alert>
      ) : null}
      {overview.data && server.role !== "viewer" && stale ? (
        <Alert>
          <AlertTitle>Fresh server status is required</AlertTitle>
          <AlertDescription>Ban changes are disabled until a current player roster is available.</AlertDescription>
        </Alert>
      ) : null}
      {overview.data && server.role !== "viewer" && !stale && (!banRouteAvailable || !unbanRouteAvailable) ? (
        <Alert>
          <AlertTitle>Some ban actions are unavailable</AlertTitle>
          <AlertDescription>
            This server build does not expose{" "}
            {[!banRouteAvailable ? "ban" : "", !unbanRouteAvailable ? "remove ban" : ""].filter(Boolean).join(" or ")}{" "}
            actions.
          </AlertDescription>
        </Alert>
      ) : null}
      {invalidCount > 0 ? (
        <Alert>
          <AlertTitle>Invalid SteamIDs found</AlertTitle>
          <AlertDescription>
            {invalidCount} {invalidCount === 1 ? "ban entry has" : "ban entries have"} an invalid SteamID. All entries
            remain visible, but invalid IDs can’t be changed here.
          </AlertDescription>
        </Alert>
      ) : null}
      {overview.error && !overview.data ? (
        <Alert>
          <AlertTitle>Player status could not be loaded</AlertTitle>
          <AlertDescription>
            The ban list can still be searched, but ban changes need a fresh server roster.
          </AlertDescription>
        </Alert>
      ) : null}
      {bans.error && bans.data ? (
        <Alert>
          <AlertTitle>Ban list refresh failed</AlertTitle>
          <AlertDescription>The last successful list is still shown. Refresh before changing bans.</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Input
            type="search"
            aria-label="Search bans"
            placeholder="Search player, SteamID64, reason, or staff"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="max-w-xl"
          />
          <span className="shrink-0 text-sm text-muted-foreground" aria-live="polite">
            {bans.data ? `${rows.length} shown · ${records.length} total` : "Loading bans"}
          </span>
        </div>
        <Button disabled={!addAllowed || busy} onClick={() => setPickerOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          Ban player
        </Button>
      </div>

      {bans.error && !bans.data ? (
        <Alert variant="destructive">
          <AlertTitle>Bans could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>The server ban list is unavailable. Try again after checking the dashboard connection.</span>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : !bans.data ? (
        <div
          className="min-h-0 flex-1 space-y-3 overflow-hidden rounded-md border p-4"
          aria-label="Loading bans"
          role="status"
        >
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Skeleton key={row} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <BansTable
          entries={rows}
          onRemove={startUnban}
          removeDisabled={!removeAllowed || busy}
          emptyMessage={records.length && query.trim() ? "No bans match this search." : "No server bans recorded."}
        />
      )}

      {pickerOpen ? (
        <BanPlayerPickerDialog
          players={overview.data?.players ?? []}
          onPick={(player) => {
            setPickerOpen(false);
            reviewAction("ban", player);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {actionReview ? (
        <PlayerActionReviewDialog
          key={`${actionReview.action}:${actionReview.player.steamId}`}
          open
          onOpenChange={(open) => !open && setActionReview(null)}
          action={actionReview.action}
          player={actionReview.player}
          overview={overview.data ?? actionReview.overview}
          server={server}
          csrf={csrf}
          allowed={reviewAllowed}
          onBusyChange={setBusy}
          onComplete={retry}
        />
      ) : null}
    </section>
  );
}
