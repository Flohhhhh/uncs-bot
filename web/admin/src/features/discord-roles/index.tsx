import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../../api/client";
import { useAdmin } from "../../app/context";
import { Empty } from "../../components/ui";
import { errorStatus, reconcileError } from "./labels";
import { PREVIEW_MAX_AGE_MS, PREVIEW_REASON, PreviewCard, RunDialog, reconcile, type Preview } from "./role-check";
import { AttentionList, LastPasses, RecentLedger, SetupChecks, StatusHeader, SummaryCounts } from "./status-sections";
import { validateRolesStatus, type DiscordRolesStatus } from "./types";

type Failure = { message: string; status: number | null };

/**
 * Reads the roles status on open and with the dashboard's own refresh; it never polls on its own. Opening the page
 * only reads: previews and role checks run only from their buttons. A 404 or 403 replaces the last status.
 */
function useRolesStatus() {
  const { refreshVersion } = useAdmin();
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data: DiscordRolesStatus | null; error: Failure | null }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    void api<unknown>("discord-roles", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setState({ data: validateRolesStatus(value), error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = errorStatus(error);
        setState((previous) => ({
          data: status === 403 || status === 404 ? null : previous.data,
          error: {
            message: error instanceof Error ? error.message : "The Discord roles status could not be read.",
            status,
          },
        }));
      });
    return () => controller.abort();
  }, [refreshVersion, version]);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return { ...state, refresh };
}

const runningNote = "A role check is running now. Try again when it finishes.";
const refreshNote = "The status could not be refreshed. Refresh before previewing or running a role check.";
/** Why the real run is off, or "" when it can be opened. The first reason that applies is shown. */
function runBlocker(data: DiscordRolesStatus, preview: Preview | null, stale: boolean, now: number) {
  if (!data.enabled) return "Switched off in Railway: DISCORD_ROLES_ENABLED=false";
  if (!data.ready) return "Fix the setup checks above before running a role check.";
  if (!data.discordReady) return "Discord is not connected yet.";
  if (data.running) return runningNote;
  if (stale) return refreshNote;
  if (!preview) return "Preview the changes first, so you can see what would change.";
  if (preview.summary.error) return "The latest preview did not finish. Preview again first.";
  if (now - preview.at > PREVIEW_MAX_AGE_MS) return "The preview is more than 10 minutes old. Preview again first.";
  return "";
}
function previewBlocker(data: DiscordRolesStatus, stale: boolean) {
  if (!data.discordReady) return "Discord is not connected yet, so Gramps can’t read the roles to preview.";
  if (data.running) return runningNote;
  if (stale) return refreshNote;
  return "";
}

function AdminDiscordRoles() {
  const { busy } = useAdmin();
  const status = useRolesStatus();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // The preview the open confirmation shows. It stays put while the run's result replaces the page's preview.
  const [confirming, setConfirming] = useState<Preview | null>(null);
  const runNote = useId();
  const previewNote = useId();
  const previewInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { data, error } = status;
  if (error?.status === 404)
    return (
      <Empty
        title="Discord roles aren’t available on this version"
        detail="This version of Gramps doesn’t include automatic Discord roles yet. Nothing has changed; this page works once the roles update is deployed."
      />
    );
  if (error?.status === 403)
    return <Empty title="Administrator access required" detail="Only administrators can manage Discord roles." alert />;
  if (!data)
    return (
      <Empty
        title={error ? "Discord roles could not be loaded" : "Loading Discord roles…"}
        detail={error ? `${error.message} Refresh to try again.` : undefined}
        alert={!!error}
      />
    );

  const stale = Boolean(error);
  const previewOff = previewBlocker(data, stale);
  const runOff = runBlocker(data, preview, stale, Date.now());

  async function runPreview() {
    if (previewInFlight.current || busy || previewOff) return;
    previewInFlight.current = true;
    setPreviewing(true);
    setPreviewError("");
    try {
      const response = await reconcile(crypto.randomUUID(), PREVIEW_REASON, true);
      if (mounted.current) setPreview({ at: Date.now(), summary: response.summary });
    } catch (failure) {
      if (mounted.current) setPreviewError(reconcileError(failure, true));
    } finally {
      previewInFlight.current = false;
      if (mounted.current) setPreviewing(false);
    }
  }

  return (
    <>
      {error && (
        <p className="notice warning" role="alert">
          Discord roles could not be refreshed: {error.message} The last status is shown below.
        </p>
      )}
      <StatusHeader data={data} />
      <div className="stack roles-page">
        <SetupChecks data={data} />
        <SummaryCounts data={data} />
        <PreviewCard preview={preview} previewing={previewing} error={previewError}>
          <div className="action-list roles-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || previewing || !!previewOff}
              aria-describedby={previewOff ? previewNote : undefined}
              onClick={() => void runPreview()}
            >
              {previewing ? "Previewing…" : "Preview changes"}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || previewing || !!runOff}
              aria-describedby={runOff ? (runOff === previewOff ? previewNote : runNote) : undefined}
              onClick={() => {
                if (preview && !runOff) setConfirming(preview);
              }}
            >
              Run role check now
            </button>
          </div>
          {/* Always present, so a reason that appears later is announced. */}
          <p className="muted roles-action-note" id={previewNote} role="status">
            {previewOff}
          </p>
          <p className="muted roles-action-note" id={runNote} role="status">
            {runOff === previewOff ? "" : runOff}
          </p>
        </PreviewCard>
        <LastPasses data={data} />
        <AttentionList items={data.attention} />
        <RecentLedger rows={data.recent} />
      </div>
      {confirming && (
        <RunDialog
          preview={confirming}
          onClose={() => setConfirming(null)}
          onRan={() => setPreview(null)}
          onSettled={status.refresh}
        />
      )}
    </>
  );
}

export function DiscordRolesPage() {
  const { me } = useAdmin();
  return me.role === "admin" ? (
    <AdminDiscordRoles key={`${me.id}:${me.csrf}`} />
  ) : (
    <Empty title="Administrator access required" />
  );
}
