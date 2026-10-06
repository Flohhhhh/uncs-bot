"use client";

import { useState, type ReactNode } from "react";
import useSWR from "swr";
import { RotateCwIcon } from "lucide-react";

import { useSelectedAdminServer } from "~/components/admin-server-context";
import {
  formatCurrentSetup,
  formatElapsed,
  formatObservedTime,
  mapDisplayName,
  apiResponseCacheKey,
  readAdminApi,
  rotationSchema,
  runningNextRound,
  serverApiPath,
  settingsNextRound,
} from "~/components/overview/overview-data";
import { Button } from "~/components/ui/button";
import { TabRail } from "~/components/ui/tab-rail";
import type { AdminServer } from "~/lib/admin-servers";

import {
  liveRefreshOptions,
  matchOverviewSchema,
  matchSettingsSchema,
  matchVotesSchema,
  voteSummary,
  type MatchControl,
  type MatchOverview,
  type MatchSettings,
} from "./match-data";
import { MatchControlDialog } from "./match-control-dialog";
import { EventsPanel, NextRoundPanel, RotationPanel, VotingPanel } from "./match-panels";

type View = "next" | "rotation" | "voting" | "events";
const tabs = [
  { value: "next" as const, label: "Next round" },
  { value: "rotation" as const, label: "Rotation" },
  { value: "voting" as const, label: "Voting" },
  { value: "events" as const, label: "Events" },
];
const controlRoutes: Record<MatchControl, { method: string; path: string }> = {
  lighting: { method: "PUT", path: "/v1/world/lighting" },
  map: { method: "POST", path: "/v1/match/map" },
  "match-end": { method: "POST", path: "/v1/match/end" },
  "match-restart": { method: "POST", path: "/v1/match/restart" },
};

function currentMatchLabel(status: MatchOverview["status"] | undefined, failed: unknown) {
  if (status) return [mapDisplayName(status.map), formatCurrentSetup(status)].filter(Boolean).join(" · ");
  return failed ? "Current match unavailable" : "Checking current match…";
}

function SummaryCell({ label, children, detail }: { label: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 font-semibold">{children}</dd>
      {detail ? <div className="mt-1 text-sm text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function nextRoundFor(
  server: AdminServer,
  map: string | undefined,
  settings: MatchSettings | undefined,
  settingsError: Error | undefined,
  rotation: ReturnType<typeof rotationSchema.parse> | undefined,
  rotationError: Error | undefined,
) {
  if (!map) return null;
  if (server.role === "admin") return settings && !settingsError ? settingsNextRound(settings.rotation, map) : null;
  return rotation && !rotationError ? runningNextRound(rotation, map) : null;
}

function matchControlAvailable(server: AdminServer, csrf: string, routes: string[], action: MatchControl) {
  if (server.role !== "admin" || !csrf) return false;
  const { method, path } = controlRoutes[action];
  return routes.some((route) => route.trim().replace(/\{[^}]*\}|:[^/\s]+/g, "*") === `${method} ${path}`);
}

function MatchSummary({
  server,
  status,
  observedAt,
  label,
  next,
  nextUnavailable,
  vote,
}: {
  server: AdminServer;
  status?: MatchOverview["status"];
  observedAt?: string;
  label: string;
  next: { label: string; note?: string } | null;
  nextUnavailable: boolean;
  vote: string;
}) {
  return (
    <dl className="grid min-w-0 grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <SummaryCell
        label="Now"
        detail={
          status
            ? [formatElapsed(status.matchSeconds), observedAt ? `Checked ${formatObservedTime(observedAt)}` : ""]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
      >
        <span className="block truncate" title={label}>
          {label}
        </span>
      </SummaryCell>
      <SummaryCell
        label="Next"
        detail={next?.note ?? (nextUnavailable ? "Rotation unavailable" : "Checking rotation…")}
      >
        <span className="block truncate" title={next?.label}>
          {next?.label ?? "Not confirmed"}
        </span>
      </SummaryCell>
      {server.role === "admin" ? (
        <SummaryCell label="Vote">{vote}</SummaryCell>
      ) : (
        <SummaryCell label="Players" detail={status ? `of ${status.players.max} slots` : undefined}>
          {status?.players.current ?? "—"}
        </SummaryCell>
      )}
    </dl>
  );
}

function MatchControlButtons({
  server,
  available,
  onSelect,
}: {
  server: AdminServer;
  available: (action: MatchControl) => boolean;
  onSelect: (action: MatchControl) => void;
}) {
  if (server.role !== "admin") {
    return <p className="text-sm text-muted-foreground">Match controls are available to administrators.</p>;
  }
  return (
    <>
      <Button variant="outline" disabled={!available("lighting")} onClick={() => onSelect("lighting")}>
        Set lighting
      </Button>
      <Button variant="outline" disabled={!available("map")} onClick={() => onSelect("map")}>
        Change map
      </Button>
      <div className="mx-1 hidden h-7 border-l sm:block" aria-hidden="true" />
      <Button
        variant="outline"
        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={!available("match-end")}
        onClick={() => onSelect("match-end")}
      >
        End match
      </Button>
      <Button
        variant="outline"
        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={!available("match-restart")}
        onClick={() => onSelect("match-restart")}
      >
        Restart match
      </Button>
      {Object.keys(controlRoutes).some((action) => !available(action as MatchControl)) ? (
        <span className="ml-auto text-xs text-muted-foreground">Some controls are unavailable on this server.</span>
      ) : null}
    </>
  );
}

function MatchTabContent({
  view,
  server,
  csrf,
  settings,
  settingsError,
  onSettingsRefresh,
}: {
  view: View;
  server: AdminServer;
  csrf: string;
  settings?: MatchSettings;
  settingsError?: Error;
  onSettingsRefresh: () => Promise<unknown>;
}) {
  switch (view) {
    case "next":
      return (
        <NextRoundPanel
          server={server}
          csrf={csrf}
          settings={settings}
          settingsError={settingsError}
          onRefresh={onSettingsRefresh}
        />
      );
    case "rotation":
      return <RotationPanel server={server} settings={settings} settingsError={settingsError} />;
    case "voting":
      return <VotingPanel server={server} role={server.role} />;
    case "events":
      return <EventsPanel server={server} role={server.role} />;
  }
}

function MatchControlOverlay({
  action,
  server,
  csrf,
  overview,
  onClose,
  onRefresh,
}: {
  action: MatchControl | null;
  server: AdminServer;
  csrf: string;
  overview?: MatchOverview;
  onClose: () => void;
  onRefresh: () => void;
}) {
  if (!action) return null;
  return (
    <MatchControlDialog
      action={action}
      server={server}
      csrf={csrf}
      overview={overview}
      onClose={onClose}
      onRefresh={onRefresh}
    />
  );
}

export function MatchSurface({ csrf }: { csrf: string }) {
  const server = useSelectedAdminServer();
  if (!server) return null;
  return <ServerMatch key={server.id} server={server} csrf={csrf} />;
}

function ServerMatch({ server, csrf }: { server: AdminServer; csrf: string }) {
  const [view, setView] = useState<View>("next");
  const [control, setControl] = useState<MatchControl | null>(null);
  const overviewPath = serverApiPath(server.id, "overview");
  const settingsPath = server.role === "admin" ? serverApiPath(server.id, "settings") : null;
  const rotationPath = server.role === "admin" ? null : serverApiPath(server.id, "rotation");
  const overview = useSWR(
    apiResponseCacheKey(overviewPath, "match-overview"),
    ([path]) => readAdminApi(path, matchOverviewSchema),
    liveRefreshOptions,
  );
  const settings = useSWR(
    apiResponseCacheKey(settingsPath, "match-settings"),
    ([path]) => readAdminApi(path, matchSettingsSchema),
    liveRefreshOptions,
  );
  const rotation = useSWR(rotationPath, (path) => readAdminApi(path, rotationSchema), liveRefreshOptions);
  const votes = useSWR(
    apiResponseCacheKey(server.role === "admin" ? serverApiPath(server.id, "map-votes") : null, "match-votes"),
    ([path]) => readAdminApi(path, matchVotesSchema),
    liveRefreshOptions,
  );
  const status = overview.data?.status;
  const next = nextRoundFor(server, status?.map, settings.data, settings.error, rotation.data, rotation.error);
  const matchLabel = currentMatchLabel(status, overview.error);
  const available = (action: MatchControl) =>
    matchControlAvailable(server, csrf, overview.data?.capabilities.routes ?? [], action);

  return (
    <section className="grid h-[calc(100svh-3rem)] min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-5 overflow-hidden p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Match &amp; Maps</h1>
        <Button
          variant="secondary"
          size="sm"
          disabled={overview.isLoading || settings.isLoading || rotation.isLoading}
          onClick={() => void Promise.all([overview.mutate(), settings.mutate(), rotation.mutate(), votes.mutate()])}
        >
          <RotateCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </header>

      <section aria-label="Current match summary" className="overflow-hidden rounded-lg border bg-card">
        <MatchSummary
          server={server}
          status={status}
          observedAt={overview.data?.observedAt}
          label={matchLabel}
          next={next}
          nextUnavailable={Boolean(settings.error || rotation.error)}
          vote={votes.data && !votes.error ? voteSummary(votes.data) : votes.error ? "Unavailable" : "Checking…"}
        />
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <MatchControlButtons server={server} available={available} onSelect={setControl} />
        </div>
      </section>

      <TabRail value={view} onValueChange={setView} tabs={tabs} ariaLabel="Match and map views" panelClassName="pt-4">
        <MatchTabContent
          view={view}
          server={server}
          csrf={csrf}
          settings={settings.data}
          settingsError={settings.error}
          onSettingsRefresh={settings.mutate}
        />
      </TabRail>

      <MatchControlOverlay
        action={control}
        server={server}
        csrf={csrf}
        overview={overview.data}
        onClose={() => setControl(null)}
        onRefresh={() => void Promise.all([overview.mutate(), settings.mutate(), rotation.mutate(), votes.mutate()])}
      />
    </section>
  );
}
