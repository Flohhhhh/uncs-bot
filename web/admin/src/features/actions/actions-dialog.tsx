import { lightingLabel, mapLabel } from "../../../../../src/common/map-labels";
import { roundStamp } from "../../../../../src/common/game-round";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, type To } from "react-router-dom";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import type { MapSelection, SettingsSnapshot } from "../../../../../src/common/server-settings";
import { useGameApi } from "../../api/server-client";
import type { ActionName, ActionResult, Catalog } from "../../api/types";
import { useResource } from "../../api/use-resource";
import { useGameAdmin as useAdmin } from "../../app/context";
import { CountedTextarea, Modal, OutcomeBadge, ReasonField } from "../../components/ui";
import { nextRoundLine, nextRoundSummary } from "../server/next-round";
import { ActionReceipt } from "./action-receipt";
import { TeamMoveDialog } from "../players/team-move";
import { MapPicker, mapSelectionLabel } from "./map-picker";
import {
  actionDefinitions,
  allowed,
  confirmationPhrases,
  confirmedActions,
  errorMessage,
  playerActions,
  rejectionState,
  singleLine,
} from "./policy";

export function ActionsDialog({
  action,
  steamId,
  initialMessage,
  onClose,
  onNavigate,
}: {
  action: ActionName;
  steamId?: string;
  /** Prefills the message of a broadcast or player message; staff still review and send it. */
  initialMessage?: string;
  onClose: () => void;
  /** Closes the dialog and then opens `to`; navigation is held while a dialog is open. */
  onNavigate?: (to: To) => void;
}) {
  const admin = useAdmin();
  if (action === "team") {
    const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
    return player ? (
      <TeamMoveDialog players={[player]} onClose={onClose} />
    ) : (
      <Modal serverScoped title="Player unavailable" onClose={onClose}>
        <p>Refresh the live roster and select a connected player.</p>
      </Modal>
    );
  }
  return (
    <ActionForm
      action={action}
      steamId={steamId}
      initialMessage={initialMessage}
      onClose={onClose}
      onNavigate={onNavigate}
    />
  );
}

/** One line on what plays after an ended match, only as far as the saved rotation confirms it. */
function reviewNextRound(settings: { data: SettingsSnapshot | null; loading: boolean; error: string }) {
  if (settings.loading && !settings.data) return "Next: checking the rotation…";
  return `${nextRoundLine(nextRoundSummary(settings.error ? null : settings.data))}.`;
}

function ActionForm({
  action,
  steamId,
  initialMessage,
  onClose,
  onNavigate,
}: {
  action: ActionName;
  steamId?: string;
  initialMessage?: string;
  onClose: () => void;
  onNavigate?: (to: To) => void;
}) {
  const api = useGameApi();
  const admin = useAdmin();
  const location = useLocation();
  const [id, setId] = useState(() => crypto.randomUUID());
  const readRound = () => {
    const snapshot = admin.overview;
    if (!snapshot?.status.map) return null;
    return (
      roundStamp(snapshot.status, Date.parse(snapshot.observedAt)) ?? { map: snapshot.status.map, startedAt: null }
    );
  };
  const [reviewedRound, setReviewedRound] = useState(readRound);
  const form = useRef<HTMLFormElement>(null);
  const returningToEdits = useRef(false);
  const submitted = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [selection, setSelection] = useState<MapSelection>({ map: "", experiences: [] });
  const [mapReady, setMapReady] = useState(false);
  const permitted = allowed(action, admin.me, admin.overview, admin.stale, admin.busy);
  const needsCatalog = action === "map" || action === "lighting";
  const catalog = useResource<Catalog>(
    needsCatalog && allowed(action, admin.me, admin.overview, admin.stale, false) ? "catalog" : null,
  );
  const catalogReady =
    !needsCatalog || Boolean(catalog.data && !catalog.loading && !catalog.refreshing && !catalog.error);
  // Only an ended match follows the rotation; reading it never blocks the review.
  const settings = useResource<SettingsSnapshot>(
    action === "match-end" && allowed(action, admin.me, admin.overview, false, false) ? "settings" : null,
  );
  const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
  const [title, description] = actionDefinitions[action];
  const requiresPlayer = playerActions.includes(action);
  const phrase = confirmationPhrases[action];
  const requiresConfirmation = confirmedActions.includes(action);
  const requiresReason = ["kick", "ban", "unban", "whitelist-remove"].includes(action);
  const choicesReady = catalogReady && (action !== "map" || mapReady);
  const roundReady = !phrase || !!reviewedRound;
  const affectsEveryone = !!phrase || action === "lighting";
  const warnLiveImpact = affectsEveryone || ["kick", "ban", "kill"].includes(action);
  const connected = admin.overview?.status.players.current;
  const audience = connected === undefined ? "everyone connected" : `${connected} player${connected === 1 ? "" : "s"}`;
  const reviewedMap = reviewedRound && mapLabel(reviewedRound.map);
  const impact =
    reviewedMap && (action === "match-end" || action === "map")
      ? `Ends ${reviewedMap} for ${audience}.`
      : reviewedMap && action === "match-restart"
        ? `Restarts ${reviewedMap} for ${audience}.`
        : `Affects everyone · ${connected ?? "Unknown number of"} players connected`;
  const uncertain = !!result && ["unknown", "pending", "accepted"].includes(result.state);
  const selectedServer = new URLSearchParams(location.search).get("server");
  const history: To = {
    pathname: "/activity",
    search: `?${new URLSearchParams([
      ...(selectedServer ? [["server", selectedServer]] : []),
      ["view", "actions"],
      ["id", id],
    ])}`,
  };
  const historyLink = (text: string) => (
    <Link
      to={history}
      onClick={(event) => {
        // A plain click closes this result first; a modified click opens a new tab as usual.
        if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        onNavigate(history);
      }}
    >
      {text}
    </Link>
  );
  useEffect(() => {
    if (!result && returningToEdits.current) {
      returningToEdits.current = false;
      form.current
        ?.querySelector<HTMLElement>(
          "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button[type=submit]",
        )
        ?.focus();
    }
  }, [result]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !permitted || !choicesReady || !roundReady) return;
    const values = new FormData(event.currentTarget);
    const reason = requiresReason ? String(values.get("reason") ?? "").trim() : `Staff action: ${title}.`;
    const target = steamId || String(values.get("steamId") ?? "");
    if (!singleLine(reason, 3)) {
      setError("Enter a single-line reason between 3 and 200 characters.");
      return;
    }
    if (requiresPlayer && !isPublicIndividualSteamId(target)) {
      setError("Enter a 17-digit SteamID64 for a personal Steam account.");
      return;
    }
    const input: Record<string, unknown> = { id, action, reason };
    if (phrase) input.expectedRound = reviewedRound;
    if (requiresPlayer) input.steamId = target;
    if (requiresConfirmation) input.confirm = phrase ?? target;
    if (action === "message" || action === "broadcast") {
      const message = String(values.get("message") ?? "").trim();
      if (!singleLine(message)) {
        setError("Enter a single-line message between 1 and 200 characters.");
        return;
      }
      input.message = message;
    }
    if (needsCatalog) {
      const data = catalog.data!;
      const lighting = action === "map" ? selection.lighting : String(values.get("lighting") ?? "");
      if ((lighting || action === "lighting") && !data.lightings.some((entry) => entry.id === lighting)) {
        setError("Choose a supported lighting preset.");
        return;
      }
      if (lighting) input.lighting = lighting;
      if (action === "map") {
        const { map, experiences, zoneAlternator } = selection;
        if (
          !data.maps.some((entry) => entry.id === map) ||
          experiences.length > 10 ||
          experiences.some((value) => !data.experiences.some((entry) => entry.id === value))
        ) {
          setError("Choose a supported map and up to 10 experiences.");
          return;
        }
        input.map = map;
        if (experiences.length) input.experiences = experiences;
        if (zoneAlternator) input.zoneAlternator = zoneAlternator;
      }
    }
    submitted.current = true;
    setSending(true);
    setError("");
    admin.setBusy(true);
    try {
      const response = await api<ActionResult>("actions", { method: "POST", body: JSON.stringify(input) });
      const outcome: ActionResult = {
        ...response,
        id,
        state: ["applied", "accepted", "pending", "failed", "unknown"].includes(response.state)
          ? response.state
          : "unknown",
      };
      setResult(outcome);
    } catch (failure) {
      setResult({
        id,
        state: rejectionState(failure),
        message: errorMessage(failure),
      });
      admin.invalidateOverview();
    } finally {
      setSending(false);
      admin.setBusy(false);
      void admin.refresh();
    }
  }

  return (
    <Modal
      serverScoped
      title={title}
      description={warnLiveImpact ? undefined : description}
      onClose={onClose}
      busy={sending}
      eyebrow={result ? null : undefined}
    >
      {!result && warnLiveImpact && (
        <div
          className="notice warning"
          role="note"
          aria-label={affectsEveryone ? "Live match warning" : "Player action warning"}
        >
          {affectsEveryone && <strong>{impact}</strong>}
          {action === "match-end" && reviewedRound && <p>{reviewNextRound(settings)}</p>}
          <p>{description}</p>
          {phrase && reviewedRound && (
            <p>
              {reviewedRound.startedAt === null
                ? `Checked again before sending: still ${reviewedMap}. A new round on the same map can't be detected.`
                : `Checked again before sending: still this round of ${reviewedMap}.`}
            </p>
          )}
          {phrase && !reviewedRound && (
            <p>
              The current map is unavailable. Close this review and refresh the dashboard before making a match change.
            </p>
          )}
          {action === "map" && <p>Use Queue next map to keep the current round running.</p>}
        </div>
      )}
      <form ref={form} onSubmit={(event) => void submit(event)}>
        {result && (
          <div
            className={`notice ${result.state === "failed" ? "error" : result.state === "applied" ? "success" : "warning"}`}
            role="status"
            aria-label="Action result"
          >
            <p className="action-result-outcome">
              <OutcomeBadge state={result.state} />
            </p>
            <p>{result.message}</p>
            {uncertain &&
              (/action history/i.test(result.message) ? (
                <p>{historyLink("Open this action in Action history")}</p>
              ) : (
                <p>Check {historyLink("Action history")} for confirmation before repeating this action.</p>
              ))}
            <ActionReceipt id={id} />
          </div>
        )}
        {(!result || result.state === "failed") && (
          <div hidden={!!result}>
            <fieldset disabled={sending || !!result}>
              {requiresPlayer &&
                (steamId ? (
                  <div className="target-box">
                    {player?.name ?? "Selected player"}
                    <small>{steamId}</small>
                  </div>
                ) : (
                  <label>
                    SteamID64
                    <input
                      name="steamId"
                      required
                      pattern="[0-9]{17}"
                      maxLength={17}
                      placeholder="17-digit SteamID64"
                      inputMode="numeric"
                    />
                  </label>
                ))}
              {(action === "message" || action === "broadcast") && (
                <CountedTextarea
                  label={
                    <>
                      In-game message <span className="muted">(up to 200 characters)</span>
                    </>
                  }
                  name="message"
                  required
                  rows={4}
                  placeholder="Write your message…"
                  defaultValue={initialMessage}
                />
              )}
              {needsCatalog && !catalogReady && (
                <p role="status">
                  {catalog.error
                    ? "The server options could not be loaded. Close this review and try again."
                    : "Loading server options…"}
                </p>
              )}
              {action === "map" && catalog.data && (
                <MapPicker
                  value={selection}
                  change={setSelection}
                  catalog={catalog.data}
                  disabled={!catalogReady || sending}
                  onReadyChange={setMapReady}
                />
              )}
              {action === "lighting" && catalog.data && (
                <label>
                  Lighting
                  <select name="lighting" required={action === "lighting"}>
                    {catalog.data.lightings.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {lightingLabel(entry.id, entry.displayName)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {requiresReason && <ReasonField />}
            </fieldset>
            {!permitted && !sending && (
              <p className="notice warning">
                Unavailable for your role, connection, or server build. Refresh the dashboard before trying again.
              </p>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        <div className="dialog-actions">
          {action === "map" && !result && catalog.data && selection.map && (
            <span className="map-picker-chip dialog-choice">
              <span className="sr-only">Selected: </span>
              {mapSelectionLabel(selection, catalog.data)}
            </span>
          )}
          <button type="button" className="button secondary" onClick={onClose} disabled={sending}>
            {result ? "Close" : "Cancel"}
          </button>
          {result?.state === "failed" && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                submitted.current = false;
                returningToEdits.current = true;
                setId(crypto.randomUUID());
                setReviewedRound(readRound());
                setResult(null);
              }}
            >
              Back to edits
            </button>
          )}
          {!result && (
            <button
              type="submit"
              className={`button ${phrase || action === "kill" || action === "ban" ? "danger" : "primary"}`}
              disabled={!permitted || sending || submitted.current || !choicesReady || !roundReady}
            >
              {sending ? "Sending…" : title}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
