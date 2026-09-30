import { useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { ActionName, ActionResult, Catalog } from "../../api/types";
import { useResource } from "../../api/use-resource";
import { useAdmin } from "../../app/context";
import { Modal, ReasonField } from "../../components/ui";
import { TeamMoveDialog } from "../players/team-move";
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
      <Modal title="Player unavailable" onClose={onClose}>
        <p>Refresh the live roster and select a connected player.</p>
      </Modal>
    );
  }
  return <ActionForm action={action} steamId={steamId} onClose={onClose} />;
}

function ActionForm({ action, steamId, onClose }: { action: ActionName; steamId?: string; onClose: () => void }) {
  const admin = useAdmin();
  const id = useRef(crypto.randomUUID());
  const submitted = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const permitted = allowed(action, admin.me, admin.overview, admin.stale, admin.busy);
  const needsCatalog = action === "map" || action === "lighting";
  const catalog = useResource<Catalog>(
    needsCatalog && allowed(action, admin.me, admin.overview, admin.stale, false) ? "catalog" : null,
  );
  const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
  const [title, description] = actionDefinitions[action];
  const requiresPlayer = playerActions.includes(action);
  const phrase = confirmationPhrases[action];
  const requiresConfirmation = confirmedActions.includes(action);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !permitted || (needsCatalog && !catalog.data)) return;
    const values = new FormData(event.currentTarget);
    const reason = String(values.get("reason") ?? "").trim();
    const target = steamId || String(values.get("steamId") ?? "");
    const confirm = String(values.get("confirm") ?? "");
    if (!singleLine(reason, 3)) {
      setError("Enter a single-line reason between 3 and 200 characters.");
      return;
    }
    if (requiresPlayer && !/^7656119\d{10}$/.test(target)) {
      setError("Enter a SteamID64: 17 digits starting with 7656119.");
      return;
    }
    if (requiresConfirmation && confirm !== (phrase ?? target)) {
      setError("The confirmation must match exactly. Nothing was sent.");
      return;
    }
    const input: Record<string, string | string[]> = { id: id.current, action, reason };
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
      const lighting = String(values.get("lighting") ?? "");
      if ((lighting || action === "lighting") && !data.lightings.some((entry) => entry.id === lighting)) {
        setError("Choose a supported lighting preset.");
        return;
      }
      if (lighting) input.lighting = lighting;
      if (action === "map") {
        const map = String(values.get("map") ?? "");
        const experiences = values.getAll("experiences").map(String);
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
        id: id.current,
        state: ["applied", "accepted", "pending", "failed", "unknown"].includes(response.state)
          ? response.state
          : "unknown",
      };
      setResult(outcome);
      admin.notify(
        `${outcome.message} Action ID: ${id.current}`,
        outcome.state === "failed"
          ? "error"
          : ["unknown", "pending", "accepted"].includes(outcome.state)
            ? "warning"
            : "success",
      );
    } catch (failure) {
      setResult({
        id: id.current,
        state: rejectionState(failure),
        message: `${errorMessage(failure)} Check Action history before repeating this action; the connection can fail after the game acts.`,
      });
      admin.invalidateOverview();
    } finally {
      setSending(false);
      admin.setBusy(false);
      void admin.refresh();
    }
  }

  return (
    <Modal title={title} description={description} onClose={onClose} busy={sending}>
      <form onSubmit={(event) => void submit(event)}>
        {result ? (
          <div
            className={`notice ${result.state === "failed" ? "error" : ["unknown", "pending", "accepted"].includes(result.state) ? "warning" : "info"}`}
            role="status"
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
            <small>Action ID: {id.current}</small>
            <p>No repeat request will be sent from this review. Check Action history before starting another action.</p>
          </div>
        ) : (
          <>
            <fieldset disabled={sending}>
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
                      pattern="7656119[0-9]{10}"
                      maxLength={17}
                      placeholder="7656119…"
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
              {needsCatalog && !catalog.data && (
                <p role="status">
                  {catalog.error
                    ? "The server options could not be loaded. Close this review and try again."
                    : "Loading server options…"}
                </p>
              )}
              {action === "map" && catalog.data && (
                <>
                  <label>
                    Map
                    <select name="map" required defaultValue={admin.overview?.status.map}>
                      {catalog.data.maps.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.displayName || entry.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Experiences <span className="muted">(optional; Ctrl / Cmd to select several)</span>
                    <select name="experiences" multiple>
                      {catalog.data.experiences.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.displayName || entry.id}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {needsCatalog && catalog.data && (
                <label>
                  Lighting
                  <select name="lighting" required={action === "lighting"}>
                    {action === "map" && <option value="">Game default</option>}
                    {catalog.data.lightings.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName || entry.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <ReasonField />
              {requiresConfirmation && (
                <label>
                  Type {phrase ? <strong>{phrase}</strong> : "the player's SteamID64"} to confirm
                  <input name="confirm" required autoComplete="off" placeholder={phrase || steamId || "SteamID64"} />
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
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={sending}>
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button
              type="submit"
              className="button primary"
              disabled={!permitted || sending || submitted.current || (needsCatalog && !catalog.data)}
            >
              {sending ? "Sending…" : "Confirm action"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
