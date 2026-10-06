"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

import {
  formatObservedTime,
  mapDisplayName,
  readAdminApi,
  rotationSchema,
  roundLabel,
  serverApiPath,
  settingsNextRound,
} from "~/components/overview/overview-data";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { AdminServer } from "~/lib/admin-servers";

import { MatchMutationError, sendMatchAction } from "./match-api";
import {
  isMatchSelectionReady,
  liveRefreshOptions,
  mapOptionsSchema,
  matchCatalogSchema,
  matchEventsSchema,
  matchVotesSchema,
  stateLabel,
  type MatchCatalog,
  type MatchSelection,
  type MatchSettings,
} from "./match-data";
import { MatchSelectionFields } from "./match-selection-fields";

function unavailableCopy(error: unknown) {
  return error instanceof Error ? error.message : "The server data could not be loaded.";
}

export function NextRoundPanel({
  server,
  csrf,
  settings,
  settingsError,
  onRefresh,
}: {
  server: AdminServer;
  csrf: string;
  settings?: MatchSettings;
  settingsError?: Error;
  onRefresh: () => Promise<unknown>;
}) {
  const [selection, setSelection] = useState<MatchSelection>({ map: "", experiences: [] });
  const catalogPath = server.role === "admin" ? serverApiPath(server.id, "catalog") : null;
  const catalog = useSWR(catalogPath, (path) => readAdminApi(path, matchCatalogSchema), {
    ...liveRefreshOptions,
    refreshInterval: 60_000,
  });
  const mapOptionsPath = selection.map
    ? serverApiPath(server.id, `catalog/maps/${encodeURIComponent(selection.map)}`)
    : null;
  const mapOptions = useSWR(mapOptionsPath, (path) => readAdminApi(path, mapOptionsSchema), {
    ...liveRefreshOptions,
    keepPreviousData: false,
    refreshInterval: 60_000,
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; uncertain: boolean } | null>(null);
  const rotation = settings?.rotation;
  const currentIndex = rotation?.currentIndex;
  const currentMatches = Boolean(
    rotation &&
    typeof currentIndex === "number" &&
    rotation.entries[currentIndex] &&
    rotation.entries[currentIndex].map === rotation.currentMap,
  );
  const canEditSelection = Boolean(
    server.role === "admin" &&
    Boolean(csrf) &&
    settings &&
    !settingsError &&
    settings.writable &&
    rotation?.editable &&
    rotation.enabled &&
    catalog.data,
  );
  const canQueue = Boolean(
    canEditSelection &&
    rotation?.enabled &&
    rotation.mode === "Ordered" &&
    currentMatches &&
    selection.map &&
    isMatchSelectionReady(selection, catalog.data, mapOptions.data) &&
    !result?.uncertain,
  );

  async function verifyQueuedRound() {
    try {
      const refreshed = await onRefresh();
      const latest = refreshed as MatchSettings | undefined;
      const next = latest ? settingsNextRound(latest.rotation, latest.rotation.currentMap) : null;
      if (next && next.label === roundLabel(selection)) {
        setResult({ message: "The selected round is confirmed in the saved rotation.", uncertain: false });
        return;
      }
      setResult({
        message:
          "The refreshed rotation does not confirm this choice yet. Check the saved rotation before queuing again.",
        uncertain: true,
      });
    } catch {
      setResult({
        message: "The saved rotation could not be rechecked. Do not queue this round again until it can be verified.",
        uncertain: true,
      });
    }
  }

  async function queueNext() {
    if (
      !settings ||
      !rotation ||
      !currentMatches ||
      !selection.map ||
      !isMatchSelectionReady(selection, catalog.data, mapOptions.data) ||
      busy
    )
      return;
    setBusy(true);
    setResult(null);
    try {
      const response = await sendMatchAction({
        server,
        csrf,
        input: {
          id: crypto.randomUUID(),
          action: "map-next",
          serverId: server.id,
          serverVersion: server.version,
          reason: "Queued from Match & Maps",
          revision: settings.revision,
          currentIndex: currentIndex!,
          currentMap: rotation.currentMap,
          entry: selection,
        },
      });
      setResult({ message: response.message, uncertain: response.state === "unknown" || response.state === "pending" });
      setReviewOpen(false);
      await onRefresh();
    } catch (error) {
      setReviewOpen(false);
      setResult({
        message: unavailableCopy(error),
        uncertain: error instanceof Error && "uncertain" in error && error.uncertain === true,
      });
      if (error instanceof MatchMutationError && error.uncertain) void onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">Queue the next round</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose what plays after this match.</p>
        </div>
        <Badge variant="outline">{rotation?.mode || "Loading"}</Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {settingsError ? (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 p-3 text-sm"
            role="alert"
          >
            <span>
              {unavailableCopy(settingsError)}
              {settings ? " Showing the last successful read; queueing is disabled until refresh." : ""}
            </span>
            <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
              Retry
            </Button>
          </div>
        ) : null}
        {rotation?.note ? (
          <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
            {rotation.note}
          </p>
        ) : null}
        {rotation?.positionNote ? (
          <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
            {rotation.positionNote}
          </p>
        ) : null}
        {server.role !== "admin" ? (
          <p className="text-sm text-muted-foreground">Only administrators can queue the next round.</p>
        ) : !settings ? (
          <p className="text-sm text-muted-foreground">
            {settingsError ? "Map settings could not be loaded." : "Loading map settings…"}
          </p>
        ) : !catalog.data ? (
          <p className="text-sm text-muted-foreground">
            {catalog.error ? unavailableCopy(catalog.error) : "Loading map choices…"}
          </p>
        ) : (
          <>
            <MatchSelectionFields
              catalog={catalog.data}
              options={mapOptions.data}
              value={selection}
              onChange={setSelection}
              optionsLoading={mapOptions.isLoading}
              optionsError={Boolean(mapOptions.error)}
              disabled={busy || !canEditSelection}
            />
            {!rotation?.enabled || rotation.mode !== "Ordered" ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Enable an ordered rotation in Server settings to queue a next round.
              </p>
            ) : !currentMatches ? (
              <p className="mt-4 text-sm text-muted-foreground">
                The current position in the rotation is not confirmed. Refresh after the next round starts.
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                disabled={!canQueue || busy || catalog.isLoading}
                onClick={() => {
                  setResult(null);
                  setReviewOpen(true);
                }}
              >
                Queue next map
              </Button>
              <span className="text-sm text-muted-foreground">
                {selection.map ? selectionSummary(selection, catalog.data) : "Choose map settings to continue."}
              </span>
            </div>
          </>
        )}
        {result ? (
          <div
            className={`mt-4 flex flex-wrap items-center justify-between gap-3 text-sm ${result.uncertain ? "text-amber-500" : "text-muted-foreground"}`}
            role="status"
          >
            <span>{result.message}</span>
            {result.uncertain ? (
              <Button variant="outline" size="sm" onClick={() => void verifyQueuedRound()}>
                Check saved rotation
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog open={reviewOpen} onOpenChange={(open) => !busy && setReviewOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Queue the next round?</DialogTitle>
            <DialogDescription>This updates the saved ordered rotation. The current match continues.</DialogDescription>
          </DialogHeader>
          <p className="rounded-md bg-muted p-3 text-sm">
            {catalog.data ? selectionSummary(selection, catalog.data) : selection.map}
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void queueNext()}>
              {busy ? "Queueing…" : "Confirm queue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function selectionSummary(selection: MatchSelection, catalog: MatchCatalog) {
  const map = catalog.maps.find((entry) => entry.id === selection.map)?.displayName ?? mapDisplayName(selection.map);
  const mode = selection.experiences.map(
    (id) => catalog.experiences.find((entry) => entry.id === id)?.displayName ?? id,
  );
  const lighting = selection.lighting
    ? (catalog.lightings.find((entry) => entry.id === selection.lighting)?.displayName ?? selection.lighting)
    : "";
  const zone =
    selection.zoneAlternator
      ?.replace(/^ZoneAlternator\.[^.]+\./, "")
      .replace(/\.Circle$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2") ?? "";
  return [map, ...mode, zone, lighting].filter(Boolean).join(" · ");
}

export function RotationPanel({
  server,
  settings,
  settingsError,
}: {
  server: AdminServer;
  settings?: MatchSettings;
  settingsError?: Error;
}) {
  const rotationPath = server.role === "admin" ? null : serverApiPath(server.id, "rotation");
  const rotation = useSWR(rotationPath, (path) => readAdminApi(path, rotationSchema), liveRefreshOptions);
  const rows:
    { map: string; experiences?: string[]; lighting?: string; status?: string | null; denied?: boolean }[] | undefined =
    server.role === "admin" ? settings?.rotation.entries : rotation.data?.entries;
  const enabled = server.role === "admin" ? settings?.rotation.enabled : rotation.data?.enabled;
  const mode = server.role === "admin" ? settings?.rotation.mode : rotation.data?.mode;
  const error = server.role === "admin" ? settingsError : rotation.error;
  const currentIndex = settings?.rotation.currentIndex ?? null;
  const nextIndex = settings?.rotation.nextIndex ?? null;
  const entryOccurrences = new Map<string, number>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">Map rotation</h2>
          <p className="mt-1 text-sm text-muted-foreground">Saved order and the game’s current position.</p>
        </div>
        <Badge variant="outline">{enabled ? mode : "Off"}</Badge>
      </div>
      {error && !rows ? (
        <p className="p-4 text-sm text-destructive" role="alert">
          {unavailableCopy(error)}
        </p>
      ) : null}
      {!rows ? (
        <p className="p-4 text-sm text-muted-foreground">Loading rotation…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No maps are saved in the rotation.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-card text-xs tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="w-16 px-4 py-3">#</th>
                <th className="px-4 py-3">Map</th>
                <th className="w-40 px-4 py-3">Position</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry, index) => {
                const identity = JSON.stringify(entry);
                const duplicateNumber = entryOccurrences.get(identity) ?? 0;
                entryOccurrences.set(identity, duplicateNumber + 1);
                const position =
                  server.role === "admin"
                    ? index === currentIndex
                      ? "Now"
                      : index === (currentIndex !== null ? (currentIndex + 1) % (rows.length || 1) : nextIndex)
                        ? "Next"
                        : "In rotation"
                    : entry.status || "In rotation";
                const label = `${mapDisplayName(entry.map)}${entry.experiences?.length ? ` · ${entry.experiences.join(" · ")}` : ""}${entry.lighting ? ` · ${entry.lighting}` : ""}`;
                return (
                  <tr key={`${identity}-${duplicateNumber}`} className={index % 2 ? "bg-muted/20" : ""}>
                    <td className="border-t px-4 py-3 text-muted-foreground">{index + 1}</td>
                    <td className="border-t px-4 py-3 font-medium">{label}</td>
                    <td className="border-t px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={
                            position === "Now"
                              ? "size-2 rounded-full bg-green-500"
                              : position === "Next"
                                ? "size-2 rounded-full bg-orange-500"
                                : "size-2 rounded-full bg-muted-foreground/40"
                          }
                          aria-hidden="true"
                        />
                        {entry.denied ? "Unavailable" : position}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function VotingPanel({ server, role }: { server: AdminServer; role: AdminServer["role"] }) {
  const path = role === "admin" ? serverApiPath(server.id, "map-votes") : null;
  const votes = useSWR(path, (url) => readAdminApi(url, matchVotesSchema), liveRefreshOptions);
  const openVotes = useMemo(() => votes.data?.votes ?? [], [votes.data?.votes]);
  if (role !== "admin")
    return (
      <ReadOnlyNotice title="Voting" detail="Map vote controls and ballot history are available to administrators." />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">Map voting</h2>
          <p className="mt-1 text-sm text-muted-foreground">Ballots and automatic voting status for this server.</p>
        </div>
        <Badge variant="outline">{votes.data?.enabled ? "Enabled" : votes.error ? "Unavailable" : "Off"}</Badge>
      </div>
      {votes.error && !votes.data ? (
        <p className="p-4 text-sm text-destructive" role="alert">
          {unavailableCopy(votes.error)}
        </p>
      ) : null}
      {votes.data && !votes.data.enabled ? (
        <p className="m-4 rounded-md border border-muted-foreground/20 bg-muted/20 p-3 text-sm text-muted-foreground">
          Map voting is not configured for this server.
        </p>
      ) : null}
      {votes.data?.automatic ? (
        <div className="border-b px-4 py-3 text-sm">
          <span className="font-medium">Automatic voting · </span>
          <span className="text-muted-foreground">{votes.data.automatic.message}</span>
        </div>
      ) : null}
      {!votes.data ? (
        <p className="p-4 text-sm text-muted-foreground">
          {votes.error ? "Ballot history could not be loaded." : "Loading ballots…"}
        </p>
      ) : openVotes.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No ballots have been recorded.</p>
      ) : (
        <div className="min-h-0 flex-1 divide-y overflow-auto">
          {openVotes.map((vote) => (
            <article key={vote.id} className="px-4 py-3 even:bg-muted/20">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{vote.choices.map((choice) => mapDisplayName(choice.map)).join(" vs ")}</h3>
                <Badge variant="outline">{stateLabel(vote.state)}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {vote.reason} · {formatObservedTime(vote.createdAt)} · closes {formatObservedTime(vote.closesAt)}
              </p>
              {vote.counted ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Votes: {vote.counts.join(" · ")}
                  {vote.winner !== null
                    ? ` · winner: ${mapDisplayName(vote.choices[vote.winner]?.map ?? "Unknown")}`
                    : ""}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function EventsPanel({ server, role }: { server: AdminServer; role: AdminServer["role"] }) {
  const path = role === "admin" ? serverApiPath(server.id, "events") : null;
  const events = useSWR(path, (url) => readAdminApi(url, matchEventsSchema), liveRefreshOptions);
  if (role !== "admin")
    return <ReadOnlyNotice title="Events" detail="Optional match events are available to administrators." />;
  const records = events.data?.events ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">Match events</h2>
          <p className="mt-1 text-sm text-muted-foreground">Optional server events and their current state.</p>
        </div>
        <Badge variant="outline">{events.data?.enabled ? "Enabled" : events.error ? "Unavailable" : "Off"}</Badge>
      </div>
      {events.error && !events.data ? (
        <p className="p-4 text-sm text-destructive" role="alert">
          {unavailableCopy(events.error)}
        </p>
      ) : null}
      {events.data && !events.data.enabled ? (
        <p className="m-4 rounded-md border border-muted-foreground/20 bg-muted/20 p-3 text-sm text-muted-foreground">
          Optional events are not enabled.
        </p>
      ) : null}
      {!events.data ? (
        <p className="p-4 text-sm text-muted-foreground">
          {events.error ? "Event history could not be loaded." : "Loading events…"}
        </p>
      ) : records.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No match events have been recorded.</p>
      ) : (
        <div className="min-h-0 flex-1 divide-y overflow-auto">
          {records.map((event) => (
            <article key={event.id} className="px-4 py-3 even:bg-muted/20">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">
                  {event.options.teams.join(" vs ")} · {event.options.durationMinutes} min
                </h3>
                <Badge variant="outline">{stateLabel(event.state)}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {event.reason} · Started {formatObservedTime(event.createdAt)}
                {event.state !== "complete" ? ` · Ends ${formatObservedTime(event.endsAt)}` : ""}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{event.stop?.reason ?? event.message}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadOnlyNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border bg-card p-8 text-center">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
