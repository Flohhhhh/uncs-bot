"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";

import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import type { AdminServer } from "~/lib/admin-servers";

import { WhitelistActionDialog, type WhitelistAction } from "./whitelist-action-dialog";
import { WhitelistTable } from "./whitelist-table";
import {
  isWhitelistOverviewFresh,
  whitelistOverviewSchema,
  whitelistResponseSchema,
  type WhitelistEntry,
  type WhitelistOverview,
  type WhitelistResponse,
  type WhitelistStatusFilter,
} from "./whitelist-data";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const EMPTY_WHITELIST_ENTRIES: WhitelistEntry[] = [];

function normalizeRoute(route: string) {
  return route
    .trim()
    .replace(/\{[^}]*\}|:[^/\s]+/g, "*")
    .replace(/\s+/g, " ");
}

function serves(routes: string[], method: string, path: string) {
  const target = normalizeRoute(`${method} ${path}`);
  return routes.some((route) => normalizeRoute(route) === target);
}

function entryMatchesStatus(entry: WhitelistEntry, status: WhitelistStatusFilter) {
  if (status === "all") return true;
  if (status === "active") return entry.active;
  if (status === "pending") return entry.configured !== null && entry.configured !== entry.active;
  return entry.configured === null;
}

export function WhitelistSection({
  server,
  csrf,
  onDataChanged,
}: {
  server: AdminServer;
  csrf: string;
  onDataChanged: () => Promise<void>;
}) {
  const path = serverApiPath(server.id, "whitelist");
  const overviewPath = serverApiPath(server.id, "overview");
  const [lastSuccessfulWhitelist, setLastSuccessfulWhitelist] = useState<WhitelistResponse>();
  const [lastSuccessfulOverview, setLastSuccessfulOverview] = useState<WhitelistOverview>();
  const rememberWhitelist = useCallback((data: WhitelistResponse) => setLastSuccessfulWhitelist(data), []);
  const rememberOverview = useCallback((data: WhitelistOverview) => setLastSuccessfulOverview(data), []);
  const whitelist = useSWR(path, (key) => readAdminApi(key, whitelistResponseSchema), {
    ...refreshOptions,
    keepPreviousData: true,
    onSuccess: rememberWhitelist,
  });
  const overview = useSWR(overviewPath, (key) => readAdminApi(key, whitelistOverviewSchema), {
    ...refreshOptions,
    keepPreviousData: true,
    onSuccess: rememberOverview,
  });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WhitelistStatusFilter>("all");
  const [action, setAction] = useState<WhitelistAction | null>(null);

  const whitelistData = whitelist.data ?? lastSuccessfulWhitelist;
  const overviewData = overview.data ?? lastSuccessfulOverview;
  const playerNames = useMemo(
    () => new Map((overviewData?.players ?? []).map((player) => [player.steamId, player.name])),
    [overviewData?.players],
  );
  const records = whitelistData?.entries ?? EMPTY_WHITELIST_ENTRIES;
  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      records.filter((entry) => {
        const matchesSearch = [entry.steamId, playerNames.get(entry.steamId)].some((value) =>
          value?.toLocaleLowerCase().includes(needle),
        );
        return matchesSearch && entryMatchesStatus(entry, statusFilter);
      }),
    [needle, playerNames, records, statusFilter],
  );
  const activeCount = records.filter((entry) => entry.active).length;
  const overviewFresh = isWhitelistOverviewFresh(overviewData);
  const capabilities = overviewData?.capabilities;
  const configFallback =
    !!capabilities && serves(capabilities.routes, "PUT", "/v1/config") && capabilities.config?.writable !== false;
  const addAvailable = !!capabilities && (serves(capabilities.routes, "POST", "/v1/reserved-slots") || configFallback);
  const removeAvailable =
    !!capabilities && (serves(capabilities.routes, "DELETE", "/v1/reserved-slots/{steamId}") || configFallback);
  const roleAllowsActions = server.role === "admin";
  const blocked =
    !whitelistData || Boolean(whitelist.error) || !overviewData || Boolean(overview.error) || !overviewFresh;
  const actionUnavailable = !roleAllowsActions || blocked;
  const noMutationsAvailable = !addAvailable && !removeAvailable && overviewData;

  return (
    <section aria-labelledby="server-whitelist-title" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="server-whitelist-title" className="text-xl font-semibold">
            Server whitelist
          </h2>
          <p className="text-sm text-muted-foreground">
            {whitelistData
              ? `${activeCount} active ${activeCount === 1 ? "entry" : "entries"} · ${filtered.length} shown of ${records.length} entries`
              : "Live and saved whitelist access"}
          </p>
        </div>
        {whitelistData ? <span className="text-sm text-muted-foreground">{records.length} total</span> : null}
      </header>

      <div className="space-y-4">
        {whitelist.error && !whitelistData ? (
          <Alert variant="destructive">
            <AlertTitle>Whitelist could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>The server whitelist is unavailable. Try again after checking the dashboard connection.</span>
              <Button variant="outline" size="sm" onClick={() => void whitelist.mutate()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : !whitelistData ? (
          <div className="space-y-3" aria-label="Loading whitelist" role="status">
            <Skeleton className="h-10 w-full" />
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <>
            {whitelist.error ? (
              <Alert variant="destructive">
                <AlertTitle>Whitelist refresh failed</AlertTitle>
                <AlertDescription>
                  The last successful list is still shown. Refresh before changing access.
                </AlertDescription>
              </Alert>
            ) : null}

            {whitelistData.invalidEntryCount > 0 || (whitelistData.configuredInvalidEntryCount ?? 0) > 0 ? (
              <Alert>
                <AlertTitle>Invalid SteamIDs found</AlertTitle>
                <AlertDescription>
                  {[
                    whitelistData.invalidEntryCount > 0 ? `${whitelistData.invalidEntryCount} in the running game` : "",
                    (whitelistData.configuredInvalidEntryCount ?? 0) > 0
                      ? `${whitelistData.configuredInvalidEntryCount} in saved configuration`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("; ")}
                  . Valid entries are shown. Fix invalid IDs in the host panel; edits here preserve them.
                </AlertDescription>
              </Alert>
            ) : null}

            {!whitelistData.configurationAvailable ? (
              <Alert>
                <AlertTitle>Saved configuration unavailable</AlertTitle>
                <AlertDescription>
                  The running whitelist is available, but the saved configuration could not be checked.
                </AlertDescription>
              </Alert>
            ) : null}

            {overview.error || !overviewData ? (
              <Alert>
                <AlertTitle>Player names unavailable</AlertTitle>
                <AlertDescription>
                  Whitelist entries can still be searched by SteamID64. Online player names appear when server status is
                  available.
                </AlertDescription>
              </Alert>
            ) : null}

            {overviewData && !overviewFresh ? (
              <Alert>
                <AlertTitle>Server status is out of date</AlertTitle>
                <AlertDescription>
                  Whitelist changes are disabled until fresh server status is available.
                </AlertDescription>
              </Alert>
            ) : null}

            {server.role !== "admin" ? (
              <Alert>
                <AlertTitle>Administrator access required to change whitelist access</AlertTitle>
                <AlertDescription>
                  You can view and search this server’s whitelist, but only admins can add or remove entries.
                </AlertDescription>
              </Alert>
            ) : null}

            {noMutationsAvailable ? (
              <Alert>
                <AlertTitle>Whitelist changes are unavailable</AlertTitle>
                <AlertDescription>
                  This server does not expose a supported whitelist action or writable configuration.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Input
                  aria-label="Search whitelist"
                  placeholder="Search online player name or SteamID64"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  className="max-w-lg"
                />
                <span className="shrink-0 text-sm text-muted-foreground">{records.length} loaded</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as WhitelistStatusFilter)}>
                  <SelectTrigger aria-label="Whitelist status" className="w-[13rem]">
                    <SelectValue placeholder="All entries" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All entries</SelectItem>
                    <SelectItem value="active">Active in game</SelectItem>
                    <SelectItem value="pending">Pending changes</SelectItem>
                    <SelectItem value="unknown">Configuration unavailable</SelectItem>
                  </SelectContent>
                </Select>
                {query || statusFilter !== "all" ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("all");
                    }}
                  >
                    Reset filters
                  </Button>
                ) : null}
                <Button disabled={actionUnavailable || !addAvailable} onClick={() => setAction({ kind: "add" })}>
                  Add player
                </Button>
              </div>
            </div>

            <WhitelistTable
              entries={filtered}
              playerNames={playerNames}
              onRemove={(entry) => setAction({ kind: "remove", entry })}
              disabled={actionUnavailable || !removeAvailable}
              emptyMessage={
                records.length && (query || statusFilter !== "all")
                  ? "No whitelist entries match these filters."
                  : "No player entries available."
              }
            />
          </>
        )}
      </div>

      {action ? (
        <WhitelistActionDialog
          action={action}
          server={server}
          csrf={csrf}
          unavailable={actionUnavailable || (action.kind === "add" ? !addAvailable : !removeAvailable)}
          onClose={() => setAction(null)}
          onComplete={() => void onDataChanged()}
        />
      ) : null}
    </section>
  );
}
