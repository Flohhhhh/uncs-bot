"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";

import { apiResponseCacheKey, readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import type { AdminServer } from "~/lib/admin-servers";

import { ApplicationReviewDialog } from "./application-review-dialog";
import {
  BulkApplicationApproveDialog,
  bulkApprovalProblems,
  bulkApprovalSummary,
  type BulkApprovalItem,
} from "./bulk-application-approve-dialog";
import {
  applicationFilterOptions,
  applicationsResponseSchema,
  whitelistOverviewSchema,
  type ApplicationStatusFilter,
  type ApplicationsResponse,
  type WhitelistApplication,
} from "./whitelist-data";
import { ApplicationsTable } from "./applications-table";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };
const EMPTY_APPLICATIONS: WhitelistApplication[] = [];

export function ApplicationsSection({
  server,
  csrf,
  onDataChanged,
}: {
  server: AdminServer;
  csrf: string;
  onDataChanged: () => Promise<void>;
}) {
  const path = serverApiPath(server.id, "applications");
  const overviewPath = serverApiPath(server.id, "overview");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [lastSuccessfulResponse, setLastSuccessfulResponse] = useState<ApplicationsResponse>();
  const pruneSelection = useCallback(
    (data: ApplicationsResponse) => {
      setLastSuccessfulResponse(data);
      const pendingIds = new Set(
        data.applications.filter((record) => record.status === "pending").map((record) => record.id),
      );
      setSelectedIds((current) => {
        const next = new Set([...current].filter((id) => pendingIds.has(id)));
        return next.size === current.size ? current : next;
      });
    },
    [setLastSuccessfulResponse, setSelectedIds],
  );
  const applications = useSWR(
    server.role === "admin" ? path : null,
    (key) => readAdminApi(key, applicationsResponseSchema),
    { ...refreshOptions, keepPreviousData: true, onSuccess: pruneSelection },
  );
  const overview = useSWR(
    apiResponseCacheKey(server.role === "admin" ? overviewPath : null, "whitelist-overview"),
    ([key]) => readAdminApi(key, whitelistOverviewSchema),
    refreshOptions,
  );
  const response = applications.data ?? lastSuccessfulResponse;
  const records = response?.applications ?? EMPTY_APPLICATIONS;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ApplicationStatusFilter>("all");
  const [inspected, setInspected] = useState<WhitelistApplication | null>(null);
  const [bulkSelection, setBulkSelection] = useState<WhitelistApplication[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [lastBulk, setLastBulk] = useState<BulkApprovalItem[] | null>(null);
  const filter = applicationFilterOptions.find((option) => option.id === status) ?? applicationFilterOptions[0]!;
  const needle = query.trim().toLocaleLowerCase();

  const filtered = useMemo(
    () =>
      records.filter(
        (record) =>
          filter.matches(record) &&
          [record.discordDisplayName, record.discordUserId, record.steamId].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          ),
      ),
    [filter, needle, records],
  );
  const selectedApplications = useMemo(
    () => records.filter((record) => record.status === "pending" && selectedIds.has(record.id)),
    [records, selectedIds],
  );
  const filteredIds = useMemo(() => new Set(filtered.map((record) => record.id)), [filtered]);
  const hiddenSelectedCount = selectedApplications.filter((record) => !filteredIds.has(record.id)).length;
  const unavailable = Boolean(applications.error) || !response || batchBusy;
  const disabled = !response || batchBusy;

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleMany(ids: string[], checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function completeBulk(items: BulkApprovalItem[]) {
    const attempted = new Set(items.filter((item) => item.state !== "queued").map((item) => item.id));
    setSelectedIds((current) => new Set([...current].filter((id) => !attempted.has(id))));
    setLastBulk(bulkApprovalProblems(items).length ? items : null);
    setBulkSelection(null);
    void onDataChanged();
  }

  const pendingCount = records.filter((record) => record.status === "pending").length;

  return (
    <section aria-labelledby="whitelist-applications-title" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="whitelist-applications-title" className="text-xl font-semibold">
            Applications
          </h2>
          <p className="text-sm text-muted-foreground">
            {server.role === "admin"
              ? response?.enabled === false
                ? "Website applications are currently turned off."
                : records.length + " loaded · " + pendingCount + " awaiting review"
              : "Application details are available to administrators only."}
          </p>
        </div>
        <Badge variant="outline">ADMIN ONLY</Badge>
      </header>

      <div className="space-y-4">
        {server.role !== "admin" ? (
          <Alert>
            <AlertTitle>Administrator access required</AlertTitle>
            <AlertDescription>
              Application records contain private contact details and are visible only to admins.
            </AlertDescription>
          </Alert>
        ) : applications.error && !response ? (
          <Alert variant="destructive">
            <AlertTitle>Applications could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>Try again after checking the dashboard connection.</span>
              <Button variant="outline" size="sm" onClick={() => void applications.mutate()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : !response ? (
          <div className="space-y-3" aria-label="Loading applications" role="status">
            <Skeleton className="h-10 w-full" />
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-12 w-full" />
            ))}
          </div>
        ) : response.enabled === false ? (
          <Alert>
            <AlertTitle>Website applications are turned off</AlertTitle>
            <AlertDescription>
              Enable website applications in the server configuration to receive and review requests. The server
              whitelist remains available below.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {applications.error ? (
              <Alert>
                <AlertTitle>Application refresh failed</AlertTitle>
                <AlertDescription>
                  The last successful application list is still shown. Refresh before reviewing a request.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Input
                  aria-label="Search applications"
                  placeholder="Search Discord name, Discord ID, or SteamID"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  className="max-w-lg"
                />
                <span className="shrink-0 text-sm text-muted-foreground">{records.length} loaded</span>
              </div>
              <ToggleGroup
                type="single"
                value={status}
                onValueChange={(value) => value && setStatus(value as ApplicationStatusFilter)}
                aria-label="Filter applications by status"
                className="flex flex-wrap justify-start gap-2 xl:justify-end"
              >
                {applicationFilterOptions.map((option) => (
                  <ToggleGroupItem key={option.id} value={option.id} className="rounded-full px-3">
                    {option.label}
                    <span className="ml-1 text-xs text-muted-foreground">{records.filter(option.matches).length}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <div
              className={
                selectedApplications.length
                  ? "flex min-h-11 items-center justify-between gap-3 rounded-md border bg-card px-3"
                  : "hidden"
              }
            >
              <p className="min-w-0 truncate text-sm font-medium" role="status">
                {selectedApplications.length} selected
                {hiddenSelectedCount > 0 ? " · " + hiddenSelectedCount + " outside current filters" : ""}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  disabled={unavailable || !selectedApplications.length}
                  onClick={() => setBulkSelection(selectedApplications)}
                >
                  Approve {selectedApplications.length}
                </Button>
                <Button variant="ghost" size="sm" disabled={batchBusy} onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
              </div>
            </div>

            {lastBulk ? (
              <Alert variant="destructive">
                <AlertTitle>Last bulk approval: {bulkApprovalSummary(lastBulk)}</AlertTitle>
                <AlertDescription>
                  <ul className="mt-2 space-y-2">
                    {bulkApprovalProblems(lastBulk).map((item) => (
                      <li key={item.id}>
                        <span className="font-medium">{item.name}</span>
                        {item.message ? <span className="text-muted-foreground"> · {item.message}</span> : null}
                      </li>
                    ))}
                  </ul>
                  <Button variant="ghost" size="sm" className="mt-2" onClick={() => setLastBulk(null)}>
                    Dismiss
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <ApplicationsTable
              key={status + "|" + query + "|" + filtered.length}
              applications={filtered}
              selectedIds={selectedIds}
              onToggle={toggleOne}
              onToggleAll={toggleMany}
              onInspect={setInspected}
              disabled={disabled}
            />
          </>
        )}
      </div>

      {inspected ? (
        <ApplicationReviewDialog
          application={inspected}
          server={server}
          csrf={csrf}
          unavailable={unavailable}
          onClose={() => setInspected(null)}
          onReviewed={() => void onDataChanged()}
        />
      ) : null}
      {bulkSelection ? (
        <BulkApplicationApproveDialog
          applications={bulkSelection}
          overview={overview.data}
          server={server}
          csrf={csrf}
          unavailable={unavailable}
          onBusyChange={setBatchBusy}
          onClose={() => setBulkSelection(null)}
          onComplete={completeBulk}
        />
      ) : null}
    </section>
  );
}
