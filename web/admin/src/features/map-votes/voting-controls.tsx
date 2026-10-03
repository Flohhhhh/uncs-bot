import { useEffect, useRef, useState } from "react";
import type { VotingControls, VotingPolicy } from "../../../../../src/common/voting-policy";
import { useGameApi } from "../../api/server-client";
import { useResource } from "../../api/use-resource";
import { useGameAdmin } from "../../app/context";
import { errorMessage } from "../actions/policy";

const toggles: { key: keyof VotingPolicy; label: string }[] = [
  { key: "enabled", label: "Automatic community voting" },
  { key: "mapChoices", label: "Offer different maps" },
  { key: "modeChoices", label: "Offer different game modes" },
  { key: "midpointReminder", label: "Score 50 update · current vote totals" },
  { key: "finalReminder", label: "Score 85 reminder · last chance to vote" },
];

export function VotingControlsPanel({ onDirty }: { onDirty: (value: boolean) => void }) {
  const resource = useResource<VotingControls>("map-votes/controls");
  const api = useGameApi();
  const { busy, setBusy } = useGameAdmin();
  const [draft, setDraft] = useState<{ version: number; policy: VotingPolicy } | null>(null);
  const [review, setReview] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const saving = useRef(false);
  // A reload this panel asked for (after a save, or to recover from an uncertain one) keeps the switches locked until
  // fresh controls arrive, so a toggle cannot build on the snapshot being replaced. Background refreshes do not.
  const [reloadingFrom, setReloadingFrom] = useState<VotingControls | null>(null);
  const data = resource.data;
  const reloading = !!data && data === reloadingFrom;
  useEffect(() => {
    onDirty(!!draft);
    return () => onDirty(false);
  }, [draft, onDirty]);
  const policy = draft?.policy ?? data?.policy;
  const changed = !!draft && draft.version !== data?.version;
  // Paused until the controls are saved again: saving them unchanged resumes automatic voting.
  const paused = data?.policy.enabled && data.paused ? data.paused : null;
  const resumable = !!paused && !draft;
  async function save(request = draft) {
    if (
      !data ||
      !request ||
      busy ||
      saving.current ||
      changed ||
      uncertain ||
      resource.loading ||
      resource.refreshing ||
      !data.available ||
      resource.error
    )
      return;
    if (request.policy.enabled && !data.policy.enabled && !review) {
      setReview(true);
      return;
    }
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      await api<VotingControls>("map-votes/controls", {
        method: "POST",
        body: JSON.stringify({ serverId: data.serverId, ...request }),
      });
      setDraft(null);
      setReview(false);
      setMessage(
        request === draft ? "Voting controls saved." : "Voting controls saved unchanged. Automatic voting resumes.",
      );
      setReloadingFrom(data);
      resource.refresh();
    } catch (error) {
      setMessage(`${errorMessage(error)} Reload the saved controls before trying again.`);
      setUncertain(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (!data || !policy)
    return resource.error ? (
      <div className="notice error" role="alert">
        <p>{resource.error}</p>
        <button
          type="button"
          className="button secondary"
          disabled={busy || resource.loading || resource.refreshing}
          onClick={resource.refresh}
        >
          Reload saved controls
        </button>
      </div>
    ) : (
      <p role="status">Loading voting controls…</p>
    );
  return (
    <>
      <p className="muted">{data.message}</p>
      <fieldset
        className="mode-choices"
        disabled={busy || resource.loading || reloading || !data.available || changed || !!resource.error || uncertain}
      >
        <legend>Community voting</legend>
        {toggles.map(({ key, label }) => (
          <label className="checkbox-label" key={key}>
            <input
              type="checkbox"
              checked={policy[key]}
              disabled={key === "enabled" && !data.ready && !policy.enabled}
              onChange={(event) => {
                setReview(false);
                const next = { ...policy, [key]: event.target.checked };
                setDraft(
                  toggles.every(({ key }) => next[key] === data.policy[key])
                    ? null
                    : { version: draft?.version ?? data.version, policy: next },
                );
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="muted">Ballots use up to five map/mode combinations from the saved rotation.</p>
      <p className="muted">
        For 100-point matches: reminders post once in game and Discord at scores 50 and 85. Voting closes at 95.
      </p>
      {changed && (
        <p className="notice warning" role="alert">
          Another administrator changed these controls. Reload before saving.
        </p>
      )}
      {policy.enabled && !policy.mapChoices && !policy.modeChoices && (
        <p role="alert">Offer maps, modes, or both before enabling voting.</p>
      )}
      {resource.error && <p role="alert">{resource.error}</p>}
      {review && (
        <p className="notice warning" role="alert">
          Enable automatic voting for this server? Gramps will post ballots and queue community winners for the next
          round.
        </p>
      )}
      {paused && (
        <div className="notice warning" role="alert">
          <p>Automatic voting is paused. {paused}</p>
          {!draft && (
            <p>
              Save to resume keeps every switch and setting as it is. Gramps then acts for you as the administrator
              responsible for automatic voting.
            </p>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {(draft || uncertain || resource.error || resumable) && (
        <div className="dialog-actions">
          {resumable && (
            <button
              className="button primary"
              disabled={
                busy ||
                resource.loading ||
                resource.refreshing ||
                reloading ||
                !data.available ||
                uncertain ||
                !!resource.error
              }
              onClick={() => void save({ version: data.version, policy: data.policy })}
            >
              Save to resume
            </button>
          )}
          {draft && (
            <button
              className="button primary"
              disabled={
                busy ||
                resource.loading ||
                resource.refreshing ||
                !data.available ||
                changed ||
                uncertain ||
                !!resource.error ||
                (policy.enabled && !policy.mapChoices && !policy.modeChoices)
              }
              onClick={() => void save()}
            >
              {review ? "Confirm enable voting" : "Save voting controls"}
            </button>
          )}
          <button
            className="button secondary"
            disabled={busy || resource.loading || resource.refreshing}
            onClick={() => {
              setDraft(null);
              setReview(false);
              setUncertain(false);
              setMessage("");
              setReloadingFrom(data);
              resource.refresh();
            }}
          >
            Reload saved controls
          </button>
        </div>
      )}
    </>
  );
}
