"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import useSWRMutation from "swr/mutation";
import { RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

import { AddPaypalSupporterDialog } from "./add-paypal-supporter-dialog";
import {
  readSupporters,
  supporterSearchText,
  supporterWorkState,
  supportersApiPath,
  syncPatreon,
  type SupporterRecord,
} from "./supporters-data";
import { SupportersTable } from "./supporters-table";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const emptySupporters: SupporterRecord[] = [];
type SupporterFilter = "all" | "needs" | "founders";

export function SupportersSurface({ csrf, canRead }: { csrf: string; canRead: boolean }) {
  if (!canRead) {
    return (
      <section className="p-4 sm:p-6">
        <Alert>
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>Supporter records are private and only administrators can view them.</AlertDescription>
        </Alert>
      </section>
    );
  }

  return <SupportersList csrf={csrf} />;
}

function SupportersList({ csrf }: { csrf: string }) {
  const supporters = useSWR(supportersApiPath, readSupporters, { ...refreshOptions, keepPreviousData: true });
  const sync = useSWRMutation(supportersApiPath, () => syncPatreon(csrf));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SupporterFilter>("all");
  const [syncError, setSyncError] = useState<string | null>(null);

  const records = supporters.data?.supporters ?? emptySupporters;
  const counts = useMemo(
    () => ({
      all: records.length,
      needs: records.filter((record) => supporterWorkState(record) === "needs").length,
      founders: records.filter((record) => record.founder !== null).length,
    }),
    [records],
  );
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return records.filter((record) => {
      const matchesFilter =
        filter === "all" || (filter === "founders" ? record.founder !== null : supporterWorkState(record) === "needs");
      return matchesFilter && (!search || supporterSearchText(record).includes(search));
    });
  }, [filter, query, records]);

  async function syncNow() {
    setSyncError(null);
    try {
      await sync.trigger(null);
      await supporters.mutate();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Patreon could not be synced.");
      void supporters.mutate();
    }
  }

  const filters: { id: SupporterFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "needs", label: "Needs you" },
    { id: "founders", label: "Founders" },
  ];
  const syncing = sync.isMutating || Boolean(supporters.data?.sync.running);

  return (
    <section className="flex h-[calc(100svh-3rem)] min-h-0 flex-none flex-col gap-5 overflow-hidden p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Supporters</h1>
        <Button
          variant="secondary"
          disabled={!supporters.data?.sync.configured || supporters.error !== undefined || syncing}
          onClick={() => void syncNow()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {syncing ? "Syncing…" : "Sync Patreon"}
        </Button>
      </header>

      {supporters.error && supporters.data ? (
        <Alert>
          <AlertTitle>Supporter list refresh failed</AlertTitle>
          <AlertDescription>The last successful list is still shown. Refresh before using the data.</AlertDescription>
        </Alert>
      ) : null}
      {supporters.error && !supporters.data ? (
        <Alert variant="destructive">
          <AlertTitle>Supporters could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Supporter records are unavailable. Check the dashboard connection and try again.</span>
            <Button variant="outline" size="sm" onClick={() => void supporters.mutate()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {syncError ? (
        <Alert variant="destructive">
          <AlertTitle>Patreon sync could not be confirmed</AlertTitle>
          <AlertDescription>{syncError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Input
            type="search"
            aria-label="Search supporters"
            placeholder="Search name, Discord ID, SteamID, or Patreon ID"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="max-w-xl"
          />
          <span className="shrink-0 text-sm text-muted-foreground" aria-live="polite">
            {supporters.data ? `${rows.length} shown · ${records.length} total` : "Loading supporters"}
          </span>
        </div>
        <AddPaypalSupporterDialog
          csrf={csrf}
          available={Boolean(supporters.data) && !supporters.error}
          founderMinimumCents={supporters.data?.founderPolicy.amountCents ?? 500}
          onRecorded={() => void supporters.mutate()}
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">Filter supporters</span>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(value) => value && setFilter(value as SupporterFilter)}
          aria-label="Filter supporters"
          className="flex flex-wrap gap-2"
        >
          {filters.map((entry) => (
            <ToggleGroupItem
              key={entry.id}
              value={entry.id}
              className="rounded-full px-4"
              aria-label={`${entry.label}, ${counts[entry.id]} supporters`}
            >
              {entry.label} <span className="text-xs text-muted-foreground">{counts[entry.id]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <SupportersTable
        entries={rows}
        isLoading={supporters.isLoading}
        emptyMessage={
          records.length && (query.trim() || filter !== "all")
            ? "No supporters match these filters."
            : "No supporters yet."
        }
      />
    </section>
  );
}
