import { lightingLabel } from "../../../../../src/common/map-labels";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import type { MapSelection } from "../../../../../src/common/server-settings";
import { useGameApi } from "../../api/server-client";
import type { ActionName, ActionResult, Catalog } from "../../api/types";
import { useResource } from "../../api/use-resource";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Modal, ReasonField } from "../../components/ui";
import { CopyValue } from "../../components/data-table";
import { TeamMoveDialog } from "../players/team-move";
import { MapPicker } from "./map-picker";
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
  onClose,
}: {
  action: ActionName;
  steamId?: string;
  onClose: () => void;
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
  return <ActionForm action={action} steamId={steamId} onClose={onClose} />;
}

function ActionForm({ action, steamId, onClose }: { action: ActionName; steamId?: string; onClose: () => void }) {
  const api = useGameApi();
  const admin = useAdmin();
  const [id, setId] = useState(() => crypto.randomUUID());
  const form = useRef<HTMLFormElement>(null);
  const returningToEdits = useRef(false);
  const submitted = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [selection, setSelection] = useState<MapSelection>({ map: "", experiences: [] });
  const [mapReady, setMapReady] = useState(false);
  const permitted = allowed(action, admin.me, admin.overview, admin.stale, admin.busy);
  const needsCatalog = action === "map" || action === "lighting";
  const catalog = useResource<Catalog>(
    needsCatalog && allowed(action, admin.me, admin.overview, admin.stale, false) ? "catalog" : null,
  );
  const catalogReady = !needsCatalog || Boolean(catalog.data && !catalog.loading && !catalog.error);
  const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
  const [title, description] = actionDefinitions[action];
  const requiresPlayer = playerActions.includes(action);
  const phrase = confirmationPhrases[action];
  const requiresConfirmation = confirmedActions.includes(action);
  const requiresReason = ["kick", "ban", "unban", "whitelist-remove"].includes(action);
  const choicesReady = catalogReady && (action !== "map" || mapReady);
  const confirmationReady = !phrase || confirmation === phrase;
  const affectsEveryone = !!phrase || action === "lighting";
  const warnLiveImpact = affectsEveryone || ["kick", "ban", "kill"].includes(action);
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
    if (submitted.current || !permitted || !choicesReady || !confirmationReady) return;
    const values = new FormData(event.currentTarget);
    const reason = requiresReason ? String(values.get("reason") ?? "").trim() : `Staff action: ${title}.`;
    const target = steamId || String(values.get("steamId") ?? "");
    const confirm = phrase ? String(values.get("confirm") ?? "") : target;
    if (!singleLine(reason, 3)) {
      setError("Enter a single-line reason between 3 and 200 characters.");
      return;
    }
    if (requiresPlayer && !isPublicIndividualSteamId(target)) {
      setError("Enter a 17-digit SteamID64 for a personal Steam account.");
      return;
    }
    if (requiresConfirmation && confirm !== (phrase ?? target)) {
      setError("The confirmation must match exactly. Nothing was sent.");
      return;
    }
    const input: Record<string, string | string[]> = { id, action, reason };
    if (requiresPlayer) input.steamId = target;
    if (requiresConfirmation) input.confirm = confirm;
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
    >
      {!result && warnLiveImpact && (
        <div
          className="notice warning"
          role="note"
          aria-label={affectsEveryone ? "Live match warning" : "Player action warning"}
        >
          {affectsEveryone && (
            <strong>
              Affects everyone · {admin.overview?.status.players.current ?? "Unknown number of"} players connected
            </strong>
          )}
          <p>{description}</p>
          {action === "map" && <p>Use Queue next map to keep the current round running.</p>}
        </div>
      )}
      <form ref={form} onSubmit={(event) => void submit(event)}>
        {result && (
          <div
            className={`notice ${result.state === "failed" ? "error" : ["unknown", "pending", "accepted"].includes(result.state) ? "warning" : "info"}`}
            role="status"
            aria-label="Action result"
          >
            <strong>
              {result.state === "applied"
                ? "Applied"
                : result.state === "accepted"
                  ? "Accepted · not verified"
                  : result.state === "pending"
                    ? "Pending"
                    : result.state === "failed"
                      ? "Failed"
                      : "Unconfirmed"}
            </strong>
            <p>{result.message}</p>
            {["unknown", "pending", "accepted"].includes(result.state) && !/action history/i.test(result.message) && (
              <p>Check Action history for confirmation before repeating this action.</p>
            )}
            <details>
              <summary>Action details</summary>
              <CopyValue value={id} label="action ID" />
            </details>
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
                <label>
                  In-game message <span className="muted">(up to 200 characters)</span>
                  <textarea name="message" maxLength={200} required rows={4} placeholder="Write your message…" />
                </label>
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
              {phrase && (
                <label>
                  Type <strong>{phrase}</strong> to confirm
                  <input
                    name="confirm"
                    required
                    autoComplete="off"
                    placeholder={phrase}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              )}
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
                setConfirmation("");
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
              disabled={!permitted || sending || submitted.current || !choicesReady || !confirmationReady}
            >
              {sending ? "Sending…" : title}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
