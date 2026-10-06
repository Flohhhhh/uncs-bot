"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { RefreshCwIcon } from "lucide-react";

import { AdminApiError, readAdminApi } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

import { DiscordRolesPreview } from "./discord-roles-preview";
import { DiscordRolesStatusPanel } from "./discord-roles-status";
import {
  discordRolesStatusSchema,
  maxPreviewAgeMs,
  previewReason,
  type DiscordRolesStatus,
  type RolePreview,
} from "./discord-roles-data";
import { reconcileDiscordRoles, reconcileError } from "./discord-roles-api";

const endpoint = "/admin/api/discord-roles";
const refreshOptions = {
  refreshInterval: 15_000,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  keepPreviousData: true,
};

export function DiscordRolesSurface({ csrf, canRead }: { csrf: string; canRead: boolean }) {
  if (!canRead) {
    return (
      <section className="p-4 sm:p-6">
        <Alert>
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>Only administrators can read or manage Discord roles.</AlertDescription>
        </Alert>
      </section>
    );
  }

  return <AdminDiscordRoles csrf={csrf} />;
}

function AdminDiscordRoles({ csrf }: { csrf: string }) {
  const status = useSWR(endpoint, (path) => readAdminApi(path, discordRolesStatusSchema), refreshOptions);
  const [preview, setPreview] = useState<RolePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [confirming, setConfirming] = useState<RolePreview | null>(null);
  const [running, setRunning] = useState(false);
  const previewInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { data, error } = status;
  const permissionError = error instanceof AdminApiError && error.status === 403;
  const unsupportedError = error instanceof AdminApiError && error.status === 404;
  const visibleData = permissionError || unsupportedError ? undefined : data;
  const stale = Boolean(error);

  async function runPreview(previewBlocker: string) {
    if (previewInFlight.current || running || previewBlocker) return;
    previewInFlight.current = true;
    setPreviewing(true);
    setPreviewError("");
    try {
      const response = await reconcileDiscordRoles({
        csrf,
        id: crypto.randomUUID(),
        reason: previewReason,
        dryRun: true,
      });
      if (mounted.current) setPreview({ at: Date.now(), summary: response.summary });
    } catch (failure) {
      if (mounted.current) setPreviewError(reconcileError(failure, true));
    } finally {
      previewInFlight.current = false;
      if (mounted.current) setPreviewing(false);
    }
  }

  const loading = status.isLoading && !visibleData;

  return (
    <section className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Discord roles</h1>
        <Button variant="secondary" size="sm" disabled={status.isValidating} onClick={() => void status.mutate()}>
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </header>

      {permissionError ? (
        <Alert variant="destructive">
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>Only administrators can manage Discord roles.</AlertDescription>
        </Alert>
      ) : unsupportedError ? (
        <Alert>
          <AlertTitle>Discord roles aren’t available on this version</AlertTitle>
          <AlertDescription>
            This version of Gramps doesn’t include automatic Discord roles yet. Nothing has changed; this page will work
            once the roles update is deployed.
          </AlertDescription>
        </Alert>
      ) : loading ? (
        <p className="py-4 text-sm text-muted-foreground" role="status">
          Loading Discord roles…
        </p>
      ) : error && !visibleData ? (
        <Alert variant="destructive">
          <AlertTitle>Discord roles could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{error instanceof Error ? error.message : "The Discord roles status could not be read."}</span>
            <Button variant="outline" size="sm" onClick={() => void status.mutate()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : visibleData ? (
        <>
          {error ? (
            <Alert>
              <AlertTitle>Discord roles could not be refreshed</AlertTitle>
              <AlertDescription>
                The last loaded status is shown. Refresh before previewing or running a role check.
              </AlertDescription>
            </Alert>
          ) : null}
          <DiscordRolesStatusPanel data={visibleData} />
          <DiscordRolesPreview
            csrf={csrf}
            busy={running}
            preview={preview}
            previewing={previewing}
            error={previewError}
            onPreview={() => void runPreview(previewBlocker(visibleData, stale, running))}
            previewBlocker={previewBlocker(visibleData, stale, running)}
            runBlocker={runBlocker(visibleData, preview, stale, running)}
            confirming={confirming}
            onConfirm={() => {
              if (preview && !runBlocker(visibleData, preview, stale, running)) setConfirming(preview);
            }}
            onClose={() => setConfirming(null)}
            onRunningChange={setRunning}
            onRan={() => setPreview(null)}
            onRefresh={() => void status.mutate()}
          />
        </>
      ) : null}
    </section>
  );
}

function previewBlocker(data: DiscordRolesStatus, stale: boolean, running: boolean) {
  if (!data.discordReady) return "Discord is not connected yet, so Gramps can’t read the roles to preview.";
  if (data.running || running) return "A role check is running now. Try again when it finishes.";
  if (stale) return "The status could not be refreshed. Refresh before previewing or running a role check.";
  return "";
}

function runBlocker(data: DiscordRolesStatus, preview: RolePreview | null, stale: boolean, running: boolean) {
  if (!data.enabled) return "Switched off in Railway: DISCORD_ROLES_ENABLED=false";
  if (!data.ready) return "Fix the setup checks above before switching on or running a role check.";
  if (!data.discordReady) return "Discord is not connected yet.";
  if (data.running || running) return "A role check is running now. Try again when it finishes.";
  if (stale) return "The status could not be refreshed. Refresh before previewing or running a role check.";
  if (!preview) return "Preview the changes first, so you can see what would change.";
  if (preview.summary.error) return "The latest preview did not finish. Preview again first.";
  if (Date.now() - preview.at > maxPreviewAgeMs) return "The preview is more than 10 minutes old. Preview again first.";
  return "";
}
