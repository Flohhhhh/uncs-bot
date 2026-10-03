import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { useAdmin } from "../../app/context";
import { CopyValue } from "../../components/data-table";
import { errorMessage } from "../actions/policy";
import type { PatreonSyncResponse, PatreonSyncStatus } from "./types";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;
const valid = (value: string | null): value is string => value !== null && Number.isFinite(Date.parse(value));

/** A rounded length of time: "under a minute", "5 min", "2 h 5 min" or "3 days". */
export function duration(ms: number) {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
/** "just now" or "5 min ago". */
export function ago(at: string, now = Date.now()) {
  const elapsed = now - Date.parse(at);
  return elapsed < 30_000 ? "just now" : `${duration(elapsed)} ago`;
}
/** "in 25 min", or "due now" once the time has passed. */
export function ahead(at: string, now = Date.now()) {
  const remaining = Date.parse(at) - now;
  return remaining <= 0 ? "due now" : `in ${duration(remaining)}`;
}
/** The latest attempt did not succeed: the token was refused, nothing has succeeded yet, or it came after the last success. */
function lastAttemptFailed(sync: PatreonSyncStatus) {
  if (sync.tokenRejected) return true;
  if (!valid(sync.lastAttemptAt)) return false;
  return !valid(sync.lastSuccessAt) || Date.parse(sync.lastAttemptAt) > Date.parse(sync.lastSuccessAt);
}
/** A relative time with the exact time in its tooltip. */
function Moment({ at, children }: { at: string; children: ReactNode }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {children}
    </time>
  );
}

const conflictReasons: Record<PatreonSyncStatus["conflictDetails"][number]["reason"], string> = {
  "discord-in-use": "Patreon's Discord account is already on another supporter record",
  "discord-differs": "Patreon reports a different Discord account than the one recorded",
};

/** Counts and review lists from the last successful import. */
function LastImport({ sync }: { sync: PatreonSyncStatus }) {
  const counts: [string, number][] = [
    ["Members listed", sync.members],
    ["New members", sync.newMembers],
    ["Updated members", sync.updated],
    ["New payments", sync.payments],
    ["Payments no longer marked paid", sync.revokedPayments],
    ["Discord accounts linked", sync.discordLinks],
    ["Discord conflicts", sync.conflicts],
    ["Incomplete payment histories", sync.truncated],
    ["Founder records to recheck", sync.founderReviews.length],
  ];
  return (
    <details className="status-about">
      <summary>Last import</summary>
      <div className="status-about-panel">
        <dl className="sync-counts">
          {counts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        {sync.conflictDetails.length > 0 && (
          <>
            <h3>Discord conflicts</h3>
            <ul aria-label="Discord conflicts">
              {sync.conflictDetails.map((conflict) => (
                <li key={`${conflict.supporterId}:${conflict.reason}`}>
                  <CopyValue value={conflict.patreonMemberId} label="Patreon member ID" />
                  <small>{conflictReasons[conflict.reason] ?? "Discord account needs review"}</small>
                </li>
              ))}
            </ul>
          </>
        )}
        {sync.founderReviews.length > 0 && (
          <>
            <h3>Founder records to recheck</h3>
            <ul aria-label="Founder records to recheck">
              {sync.founderReviews.map((review) => (
                <li key={`${review.supporterId}:${review.unverifiedPaymentId}`}>
                  <CopyValue value={review.patreonMemberId} label="Patreon member ID" />
                  <small>Payment {review.unverifiedReference} is not verified</small>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">
          {sync.memberListComplete
            ? "Counts are from the last successful import."
            : "Counts are from the last successful import, which read only part of the member list."}{" "}
          Search a member ID above to review that record.
        </p>
      </div>
    </details>
  );
}

/**
 * "Patreon import: last synced 5 min ago · 12 members · 3 new payments · next in 25 min", the warnings
 * staff can act on, and an administrator's "Sync now". The status never includes the token.
 */
export function PatreonImport({
  sync,
  unavailable,
  disabled,
  onSynced,
}: {
  sync: PatreonSyncStatus;
  /** The latest read failed, so the last status is not shown as current. */
  unavailable: boolean;
  disabled: boolean;
  onSynced: () => void;
}) {
  const { me } = useAdmin();
  const [syncing, setSyncing] = useState(false);
  // A result describes one attempt. A later attempt's status replaces it.
  const [result, setResult] = useState<{ ok: boolean; message: string; attemptAt: string | null } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Only administrators can start a sync; the server checks the role again.
  const canSync = me.role === "admin" && sync.configured;
  const running = syncing || sync.running;

  async function syncNow() {
    if (inFlight.current || disabled || unavailable || !canSync || sync.running) return;
    const before = sync.lastAttemptAt;
    inFlight.current = true;
    setSyncing(true);
    setResult(null);
    try {
      const response = await api<PatreonSyncResponse>("supporters/sync", { method: "POST", body: "{}" });
      if (!mounted.current) return;
      const status = response.sync;
      const attemptAt = status?.lastAttemptAt ?? null;
      const failed = status ? lastAttemptFailed(status) : false;
      // The server reuses any attempt from the last 30 seconds, whether or not it worked.
      if (response.recent)
        setResult(
          failed
            ? { ok: false, message: "The last import failed under 30 seconds ago. Try again in a moment.", attemptAt }
            : {
                ok: !status?.lastError,
                message: "An import finished under 30 seconds ago, so it was not repeated.",
                attemptAt,
              },
        );
      // No new attempt was recorded: the server holds imports while Patreon's rate limit lasts.
      else if (status && !response.joined && attemptAt === before)
        setResult({
          ok: false,
          message: "No import ran because Patreon asked the sync to slow down. It will retry automatically.",
          attemptAt,
        });
      // A failed import is explained by the refreshed status below.
      else if (!failed && !status?.lastError)
        setResult({
          ok: true,
          message: response.joined ? "Joined the import already running. It has finished." : "Patreon import finished.",
          attemptAt,
        });
    } catch (error) {
      if (!mounted.current) return;
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      setResult({
        ok: false,
        message:
          status === 0
            ? "The sync request ended before Patreon finished. The import may still be running; this status updates on the next refresh."
            : errorMessage(error),
        attemptAt: before,
      });
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSyncing(false);
        onSynced();
      }
    }
  }

  const shown = result && result.attemptAt === sync.lastAttemptAt ? result : null;
  const success = valid(sync.lastSuccessAt) ? sync.lastSuccessAt : null;
  const attempt = valid(sync.lastAttemptAt) ? sync.lastAttemptAt : null;
  const next = valid(sync.nextAttemptAt) ? sync.nextAttemptAt : null;
  const now = Date.now();
  const show = !unavailable && sync.configured;
  // An attempt after the last success that is no longer running did not succeed.
  const failedAt =
    show && !running && attempt && (!success || Date.parse(attempt) > Date.parse(success)) ? attempt : null;
  // From the last successful import: founder promises whose payment Patreon no longer reports as paid, and conflicts.
  const founderRechecks = show && success ? sync.founderReviews.length : 0;
  const conflicts = show && success ? sync.conflicts : 0;
  const tone =
    unavailable || sync.tokenRejected || sync.lastError || founderRechecks > 0 || conflicts > 0
      ? "attention"
      : sync.configured && success
        ? "good"
        : "quiet";
  // The schedule's own cadence. A rejected token or Patreon's rate limit can push the next run later, and a failed
  // run's end is not recorded, so allow two minutes past its start.
  const intervalMs = sync.intervalMinutes * 60_000;
  const lastRun = failedAt ?? success;
  const regular =
    !sync.tokenRejected &&
    next !== null &&
    (lastRun === null || Date.parse(next) - Date.parse(lastRun) <= intervalMs + 2 * 60_000);
  const state = unavailable ? (
    "Status unavailable"
  ) : !sync.configured ? (
    "Not configured"
  ) : running ? (
    "Syncing now…"
  ) : success ? (
    <>
      last synced <Moment at={success}>{ago(success, now)}</Moment>
    </>
  ) : (
    "Not synced yet"
  );
  return (
    <>
      <div className="status-row supporter-sync">
        {/* The page is a polite live region; the relative times change every minute and are not announced. */}
        <p className={`status-line ${tone}`} aria-live="off">
          <span>
            Patreon import: <strong>{state}</strong>
          </span>
          {show && running && success && (
            <span>
              last synced <Moment at={success}>{ago(success, now)}</Moment>
            </span>
          )}
          {failedAt && (
            <span>
              last tried <Moment at={failedAt}>{ago(failedAt, now)}</Moment>
            </span>
          )}
          {founderRechecks > 0 && <span>{plural(founderRechecks, "founder record")} to recheck</span>}
          {conflicts > 0 && <span>{plural(conflicts, "Discord conflict")}</span>}
          {show && success && <span>{plural(sync.members, "member")}</span>}
          {show && success && <span>{plural(sync.payments, "new payment")}</span>}
          {show && !running && next && (
            <span title={regular ? `Runs every ${duration(intervalMs)}` : undefined}>
              next <Moment at={next}>{ahead(next, now)}</Moment>
            </span>
          )}
        </p>
        {canSync && (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || unavailable || running}
            onClick={() => void syncNow()}
          >
            {running ? "Syncing…" : "Sync now"}
          </button>
        )}
        {show && success && <LastImport sync={sync} />}
        {!unavailable && !sync.configured && (
          <p className="muted">
            Set PATREON_ENABLED, PATREON_CAMPAIGN_ID and PATREON_CREATOR_ACCESS_TOKEN in Railway to import members.
          </p>
        )}
      </div>
      {!unavailable &&
        (sync.tokenRejected ? (
          <p className="notice warning">
            <strong>Patreon rejected the access token.</strong> Renew the Creator's Access Token on the Patreon client
            page, update PATREON_CREATOR_ACCESS_TOKEN in Railway, and check that PATREON_CAMPAIGN_ID belongs to that
            creator.
          </p>
        ) : sync.lastError ? (
          <p className="notice warning">
            <strong>Patreon import needs attention.</strong> {sync.lastError}
          </p>
        ) : null)}
      {shown && (
        <p className={`notice ${shown.ok ? "success" : "warning"}`} role="status">
          {shown.message}
        </p>
      )}
    </>
  );
}
