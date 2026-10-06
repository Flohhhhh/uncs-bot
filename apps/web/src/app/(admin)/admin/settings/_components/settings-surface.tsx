"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { RefreshCwIcon } from "lucide-react";

import { useSelectedAdminServer } from "~/components/admin-server-context";
import { serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { TabRail } from "~/components/ui/tab-rail";

import { ServerIdentityReadout } from "./server-identity-readout";
import { readServerSettings, SettingsReadError } from "./settings-api";
import { SettingFieldControl } from "./setting-field-control";
import { SettingsReviewDialog } from "./settings-review-dialog";
import {
  reviewGroups,
  settingFields,
  settingFieldById,
  settingGroups,
  settingsRefreshOptions,
  type SettingGroup,
  type SettingValue,
  type SettingsChanges,
  type SettingsSnapshot,
} from "./settings-data";

type Draft = { snapshot: SettingsSnapshot; changes: SettingsChanges };
type Review = { snapshot: SettingsSnapshot; changes: SettingsChanges; groups: { title: string; items: string[] }[] };

export function SettingsSurface({ csrf }: { csrf: string }) {
  const server = useSelectedAdminServer();
  if (!server) return null;
  return <ServerSettings key={server.id} server={server} csrf={csrf} />;
}

function ServerSettings({
  server,
  csrf,
}: {
  server: NonNullable<ReturnType<typeof useSelectedAdminServer>>;
  csrf: string;
}) {
  const settingsPath = server.role === "admin" ? serverApiPath(server.id, "settings") : null;
  const settings = useSWR(settingsPath, readServerSettings, settingsRefreshOptions);
  const [group, setGroup] = useState<SettingGroup>("Identity");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [validation, setValidation] = useState("");

  useEffect(() => {
    if (!draft) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [draft]);

  const { data, error } = settings;
  const permissionError = error instanceof SettingsReadError && error.status === 403;
  const unsupportedError = error instanceof SettingsReadError && error.status === 404;
  const visibleData = permissionError ? undefined : data;
  const changes = draft?.changes ?? {};
  const changeCount = Object.keys(changes).length;
  const changedGroups = new Set<SettingGroup>(
    Object.keys(changes).flatMap((id) => {
      const field = settingFieldById[id];
      return field ? [field.group] : [];
    }),
  );
  const outdated = Boolean(draft && data && draft.snapshot.revision !== data.revision);
  const stale = Boolean(error);
  const editingLocked = Boolean(stale || !visibleData?.writable || !csrf || server.role !== "admin");

  function update(id: string, value: SettingValue, clearPassword = false) {
    setValidation("");
    setDraft((current) => {
      const base = current?.snapshot ?? visibleData;
      if (!base) return current;
      const nextChanges = { ...current?.changes };
      const field = settingFieldById[id];
      const original = base.fields.find((entry) => entry.id === id)?.value;
      if ((field?.secret && value === "" && !clearPassword) || (!field?.secret && value === original)) {
        delete nextChanges[id];
      } else {
        nextChanges[id] = value;
      }
      return Object.keys(nextChanges).length ? { snapshot: base, changes: nextChanges } : null;
    });
  }

  function startReview() {
    if (!draft) return;
    try {
      setReview({
        snapshot: draft.snapshot,
        changes: draft.changes,
        groups: reviewGroups(draft.changes, draft.snapshot),
      });
      setValidation("");
    } catch (failure) {
      setValidation(failure instanceof Error ? failure.message : "Correct the settings before reviewing them.");
    }
  }

  function changeTab(next: SettingGroup) {
    setGroup(next);
  }

  function renderFields(selected: Exclude<SettingGroup, "Host controls">) {
    if (!visibleData) return null;
    return (
      <div className="grid min-w-0 gap-4 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
        {selected === "Identity" ? <ServerIdentityReadout server={server} /> : null}
        {settingFields
          .filter((field) => field.group === selected)
          .map((field) => {
            const observed = visibleData.fields.find((entry) => entry.id === field.id);
            const hasDraft = Object.hasOwn(changes, field.id);
            const value = changes[field.id] ?? observed?.value ?? "";
            const removingPassword = field.secret && hasDraft && value === "";
            return (
              <SettingFieldControl
                key={field.id}
                field={field}
                snapshot={visibleData}
                observed={observed}
                value={value}
                changed={hasDraft}
                locked={editingLocked || outdated}
                removing={Boolean(removingPassword)}
                onUpdate={update}
                onClearPassword={(id) => update(id, "", true)}
              />
            );
          })}
        {selected === "Rotation" ? (
          <p className="text-sm sm:col-span-2">
            <Link
              className="font-medium text-orange-400 underline-offset-4 hover:underline"
              href={`/admin/match?server=${encodeURIComponent(server.id)}&view=rotation`}
            >
              Edit maps in Match &amp; Maps →
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  const tabs = settingGroups.map((name) => ({
    value: name,
    label: changedGroups.has(name) ? (
      <>
        {name}
        <span className="ml-1 text-orange-400" aria-hidden="true">
          •
        </span>
        <span className="sr-only">, unsaved</span>
      </>
    ) : (
      name
    ),
  }));
  const loading = settings.isLoading && !visibleData;
  const reviewUnavailable = stale
    ? "Settings could not be refreshed. Refresh before saving."
    : outdated
      ? "Settings changed on the server. Close this review, discard the draft, and refresh before saving."
      : !visibleData?.writable
        ? "These settings are read-only on this server."
        : "";
  const formGroup = group === "Host controls" ? null : group;

  return (
    <section className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Server settings</h1>
        <Button
          variant="secondary"
          size="sm"
          disabled={settings.isValidating || server.role !== "admin"}
          onClick={() => void settings.mutate()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </header>

      {server.role !== "admin" ? (
        <Alert>
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>Only administrators can read or change server settings.</AlertDescription>
        </Alert>
      ) : null}
      {permissionError ? (
        <Alert variant="destructive">
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>
            The selected server did not allow this settings read. Refresh the server selection or sign in again.
          </AlertDescription>
        </Alert>
      ) : null}
      {unsupportedError ? (
        <Alert>
          <AlertTitle>Server settings are unavailable on this build</AlertTitle>
          <AlertDescription>This server does not expose its saved configuration to the dashboard.</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          Loading server settings…
        </p>
      ) : null}
      {error && !visibleData && !permissionError && !unsupportedError ? (
        <Alert variant="destructive">
          <AlertTitle>Server settings could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{error instanceof Error ? error.message : "The saved settings could not be read safely."}</span>
            <Button variant="outline" size="sm" onClick={() => void settings.mutate()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {error && visibleData ? (
        <Alert>
          <AlertTitle>Settings could not be refreshed</AlertTitle>
          <AlertDescription>
            The last loaded values remain visible. Refresh before reviewing or saving changes.
          </AlertDescription>
        </Alert>
      ) : null}
      {visibleData?.notice ? (
        <Alert>
          <AlertTitle>Configuration is read-only</AlertTitle>
          <AlertDescription>{visibleData.notice}</AlertDescription>
        </Alert>
      ) : null}
      {outdated ? (
        <Alert variant="destructive">
          <AlertTitle>Settings changed on the server</AlertTitle>
          <AlertDescription>Discard your draft and reload the latest values before saving.</AlertDescription>
        </Alert>
      ) : null}

      {visibleData ? (
        <TabRail
          value={group}
          onValueChange={changeTab}
          tabs={tabs}
          ariaLabel="Server settings groups"
          panelClassName="pt-5"
        >
          {formGroup === null ? <HostControls /> : renderFields(formGroup)}
        </TabRail>
      ) : null}

      {changeCount > 0 ? (
        <div className="sticky bottom-0 z-10 -mx-4 mt-auto flex flex-wrap items-center gap-2 border-t bg-background/95 px-4 py-3 shadow-[0_-8px_20px_-16px_rgba(0,0,0,0.65)] backdrop-blur sm:-mx-6 sm:px-6">
          <strong className="mr-auto text-sm">
            {changeCount} unsaved change{changeCount === 1 ? "" : "s"}
          </strong>
          <Button
            type="button"
            variant="outline"
            disabled={settings.isValidating && !visibleData}
            onClick={() => {
              setDraft(null);
              setValidation("");
              void settings.mutate();
            }}
          >
            Discard
          </Button>
          <Button type="button" disabled={editingLocked || outdated} onClick={startReview}>
            Review changes
          </Button>
        </div>
      ) : null}
      {validation ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{validation}</AlertDescription>
        </Alert>
      ) : null}
      {review ? (
        <SettingsReviewDialog
          server={server}
          csrf={csrf}
          snapshot={review.snapshot}
          changes={review.changes}
          groups={review.groups}
          unavailable={reviewUnavailable}
          onClose={() => setReview(null)}
          onComplete={(state) => {
            if (state !== "failed") setDraft(null);
            void settings.mutate();
          }}
        />
      ) : null}
    </section>
  );
}

function HostControls() {
  const controls = [
    {
      title: "Daily restart time",
      description: "xREALM Settings. Enter local time; the host stores UTC. Restart the server to apply.",
    },
    {
      title: "Restart after the match",
      description: (
        <>
          xREALM match-end restart task.{" "}
          <a
            className="text-orange-400 underline-offset-4 hover:underline"
            href="https://www.xrealm.com/en/blog/wardogs-server-restart-after-match-end"
            target="_blank"
            rel="noopener noreferrer"
          >
            Setup guide ↗
          </a>
        </>
      ),
    },
    {
      title: "RCON hosts, port, password and TLS",
      description: "Host configuration. Credentials stay out of this dashboard.",
    },
    {
      title: "Game-event feed",
      description: "Set the destination in the host panel; check delivery after the next normal start.",
    },
    {
      title: "Server description",
      description: "The official console keeps it in that browser; the server listing is unchanged.",
    },
  ];
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b px-4 py-4 sm:px-5">
        <CardTitle>Managed through the host</CardTitle>
        <CardDescription>Change these in the selected server’s host panel.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {controls.map((control) => (
            <li
              key={control.title}
              className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(12rem,0.35fr)_1fr] sm:gap-5 sm:px-5"
            >
              <strong className="text-sm">{control.title}</strong>
              <span className="text-sm text-muted-foreground">{control.description}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
