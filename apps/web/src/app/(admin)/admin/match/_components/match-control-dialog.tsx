"use client";

import { useState } from "react";
import useSWR from "swr";

import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { AdminServer } from "~/lib/admin-servers";

import { MatchMutationError, sendMatchAction } from "./match-api";
import {
  isMatchSelectionReady,
  liveRefreshOptions,
  mapOptionsSchema,
  matchCatalogSchema,
  type MatchControl,
  type MatchOverview,
  type MatchSelection,
} from "./match-data";
import { MatchSelectionFields } from "./match-selection-fields";

function unavailableCopy(error: unknown) {
  return error instanceof Error ? error.message : "The server data could not be loaded.";
}

export function MatchControlDialog({
  action,
  server,
  csrf,
  overview,
  onClose,
  onRefresh,
}: {
  action: MatchControl;
  server: AdminServer;
  csrf: string;
  overview?: MatchOverview;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [selection, setSelection] = useState<MatchSelection>({ map: "", experiences: [] });
  const catalogPath = action === "map" || action === "lighting" ? serverApiPath(server.id, "catalog") : null;
  const catalog = useSWR(catalogPath, (path) => readAdminApi(path, matchCatalogSchema), {
    ...liveRefreshOptions,
    refreshInterval: 60_000,
  });
  const mapOptionsPath =
    action === "map" && selection.map
      ? serverApiPath(server.id, `catalog/maps/${encodeURIComponent(selection.map)}`)
      : null;
  const mapOptions = useSWR(mapOptionsPath, (path) => readAdminApi(path, mapOptionsSchema), {
    ...liveRefreshOptions,
    keepPreviousData: false,
    refreshInterval: 60_000,
  });
  const [phrase, setPhrase] = useState("");
  const [reason, setReason] = useState("Updated from Match & Maps");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertainOutcome, setUncertainOutcome] = useState(false);
  const phraseRequired = action === "map" || action === "match-end" || action === "match-restart";
  const phraseValue = action === "map" ? "CHANGE MAP" : action === "match-end" ? "END MATCH" : "RESTART MATCH";
  const title =
    action === "lighting"
      ? "Set match lighting"
      : action === "map"
        ? "Change map"
        : action === "match-end"
          ? "End match"
          : "Restart match";
  const expectedRound = overview
    ? {
        map: overview.status.map,
        startedAt:
          overview.status.matchSeconds === undefined
            ? null
            : Date.parse(overview.observedAt) - overview.status.matchSeconds * 1000,
      }
    : undefined;
  const canSubmit = Boolean(
    overview &&
    csrf &&
    reason.trim().length >= 3 &&
    (!phraseRequired || phrase === phraseValue) &&
    (action === "lighting"
      ? selection.lighting && catalog.data?.lightings.some((lighting) => lighting.id === selection.lighting)
      : action === "map"
        ? selection.map && isMatchSelectionReady(selection, catalog.data, mapOptions.data)
        : true) &&
    !busy,
  );

  async function submit() {
    if (!overview || !canSubmit) return;
    setBusy(true);
    setMessage("");
    const input: Record<string, unknown> = {
      id: crypto.randomUUID(),
      serverId: server.id,
      serverVersion: server.version,
      action,
      reason: reason.trim(),
    };
    if (action === "lighting") input.lighting = selection.lighting;
    if (action === "map") Object.assign(input, selection, { confirm: phraseValue, expectedRound });
    if (action === "match-end" || action === "match-restart")
      Object.assign(input, { confirm: phraseValue, expectedRound });
    try {
      const result = await sendMatchAction({ server, csrf, input });
      setMessage(result.message);
      setUncertainOutcome(result.state === "unknown");
      if (result.state !== "failed") {
        onRefresh();
        if (result.state !== "unknown") onClose();
      }
    } catch (error) {
      setMessage(unavailableCopy(error));
      const uncertain = error instanceof MatchMutationError && error.uncertain;
      setUncertainOutcome(uncertain);
      if (uncertain) onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {action === "lighting"
              ? "Apply a lighting preset to the running match."
              : action === "map"
                ? "The current round will be rechecked before the map change is sent."
                : action === "match-end"
                  ? "The current round will be rechecked before ending the match."
                  : "The current round will be rechecked before restarting the match."}
          </DialogDescription>
        </DialogHeader>
        {action === "lighting" ? (
          <label className="grid gap-2 text-sm font-medium">
            Lighting
            <Select
              value={selection.lighting ?? ""}
              onValueChange={(lighting) => setSelection({ ...selection, lighting })}
              disabled={!catalog.data}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose lighting" />
              </SelectTrigger>
              <SelectContent>
                {(catalog.data?.lightings ?? []).map((lighting) => (
                  <SelectItem key={lighting.id} value={lighting.id}>
                    {lighting.displayName || lighting.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : action === "map" ? (
          catalog.data ? (
            <MatchSelectionFields
              catalog={catalog.data}
              options={mapOptions.data}
              value={selection}
              onChange={setSelection}
              optionsLoading={mapOptions.isLoading}
              optionsError={Boolean(mapOptions.error)}
              disabled={busy}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {catalog.error ? unavailableCopy(catalog.error) : "Loading map choices…"}
            </p>
          )
        ) : null}
        <label className="grid gap-2 text-sm font-medium">
          Reason
          <Input maxLength={200} value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
        </label>
        {phraseRequired ? (
          <label className="grid gap-2 text-sm font-medium">
            Type <span className="font-mono">{phraseValue}</span> to confirm
            <Input autoComplete="off" value={phrase} onChange={(event) => setPhrase(event.currentTarget.value)} />
          </label>
        ) : null}
        {message ? (
          <p className={`text-sm ${uncertainOutcome ? "text-amber-500" : "text-destructive"}`} role="status">
            {message}
            {uncertainOutcome ? " Check the current match before attempting this action again." : ""}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={phraseRequired ? "destructive" : "default"}
            disabled={
              !canSubmit ||
              uncertainOutcome ||
              (action === "map" && !catalog.data) ||
              (action === "lighting" && !catalog.data)
            }
            onClick={() => void submit()}
          >
            {busy ? "Sending…" : title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
