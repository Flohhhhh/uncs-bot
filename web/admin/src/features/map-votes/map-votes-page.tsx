import { selectionLabel } from "../../../../../src/common/map-labels";
import { voteChoiceKey } from "../../../../../src/common/voting-policy";
import { VotingControlsPanel } from "./voting-controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MapSelection, SettingsSnapshot } from "../../../../../src/common/server-settings";
import type { MapVoteSetup } from "../../../../../src/common/map-vote-automation";
import { VoteResults, voteStateLabels as stateLabels, type Vote, type VoteList } from "./vote-status";
import { useGameApi } from "../../api/server-client";
import { useResource } from "../../api/use-resource";
import type { Catalog } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import { MapPicker } from "../actions/map-picker";
import { errorMessage } from "../actions/policy";

type Draft = { serverId: string; revision: string; choices: MapSelection[]; minutes: number };
function positionReady(settings?: SettingsSnapshot | null) {
  const rotation = settings?.rotation;
  return (
    !!rotation && rotation.editable && rotation.enabled && rotation.mode === "Ordered" && rotation.currentIndex !== null
  );
}

function VoteReview({
  draft,
  vote,
  close,
  finished,
  statusUnavailable,
}: {
  draft?: Draft;
  vote?: Vote;
  close: () => void;
  finished: () => void;
  statusUnavailable: boolean;
}) {
  const { busy, setBusy } = useAdmin();
  const api = useGameApi();
  const [id] = useState(() => crypto.randomUUID());
  const submitted = useRef(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const settings = useResource<SettingsSnapshot>(draft ? "settings" : null);
  const blocked = !!draft && statusUnavailable;
  const rotationReady =
    !draft ||
    (!settings.loading &&
      !settings.error &&
      positionReady(settings.data) &&
      settings.data?.revision === draft.revision);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted.current || blocked || !rotationReady) return;
    const reason = vote ? "Staff closed map vote." : "Staff started map vote.";
    submitted.current = true;
    setBusy(true);
    try {
      const response = await api<Vote>(vote ? `map-votes/${vote.id}/cancel` : "map-votes", {
        method: "POST",
        body: JSON.stringify({ ...draft, id, reason }),
      });
      setResult(response.message);
    } catch (error) {
      setFailed(true);
      setResult(
        `${errorMessage(error)} Refresh the ballot history and check Discord before starting another vote. This request will not be sent again.`,
      );
    } finally {
      setBusy(false);
      finished();
    }
  }
  return (
    <Modal
      serverScoped
      title={vote ? "Close this ballot" : "Review Discord ballot"}
      onClose={close}
      busy={busy}
      eyebrow={result ? null : undefined}
    >
      {draft && (
        <>
          <ol className="change-summary">
            {draft.choices.map((choice) => (
              <li key={voteChoiceKey(choice)}>{selectionLabel(choice)}</li>
            ))}
          </ol>
          <p>
            Voting lasts {draft.minutes} minutes. Each Discord member gets one vote and can change it. A tie or no votes
            keeps the rotation.
          </p>
          <p className="muted">
            The winner queues for the next round only if the rotation position, settings and your administrator access
            still match. The current match continues.
          </p>
        </>
      )}
      {vote && (
        <p className="notice warning">
          Stop accepting votes and close this record. This does not undo a queued map. For an interrupted operation,
          inspect Discord and the action receipt first.
        </p>
      )}
      {result ? (
        <>
          <p className={`notice${failed ? " warning" : ""}`} role="status">
            {result}
          </p>
          <p>
            Ballot receipt: <CopyValue value={vote?.id ?? id} label="ballot receipt" />
          </p>
          <button type="button" className="button secondary" onClick={close}>
            Close
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          {blocked && <p role="alert">Refresh ballot history before publishing.</p>}
          {draft && !rotationReady && (
            <div className="notice warning" role="alert">
              <p>
                {settings.error ||
                  (settings.loading
                    ? "Checking the rotation…"
                    : "The rotation changed or its position is unavailable. Return to the ballot and refresh.")}
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={busy || settings.loading}
                onClick={settings.refresh}
              >
                Check rotation
              </button>
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={close}>
              Back
            </button>
            <button className="button primary" disabled={busy || blocked || !rotationReady}>
              {busy ? "Saving…" : vote ? "Confirm close" : "Publish ballot"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function VotingSetupCheck() {
  const api = useGameApi();
  const [result, setResult] = useState<MapVoteSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    if (loading) return;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      setResult(await api<MapVoteSetup>("map-votes/setup"));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <p>
        <button className="button secondary" disabled={loading} onClick={() => void check()}>
          {loading ? "Checking setup…" : "Check voting setup"}
        </button>
      </p>
      <p className="muted">Read-only check. It does not enable voting or post a message.</p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <ul>
            {result.checks.map((item) => (
              <li key={item.label}>
                <strong>{item.label}</strong> ·{" "}
                {item.status === "ok" ? "Checked" : item.status === "review" ? "Review needed" : "Needs setup"}
                <p>{item.message}</p>
              </li>
            ))}
          </ul>
          <small className="muted">
            Checked {date(result.checkedAt)}. Stored ballots can resume when voting is enabled.
          </small>
        </div>
      )}
    </>
  );
}

function VotingSettings({ onDirty }: { onDirty: (value: boolean) => void }) {
  return (
    <Card title="Voting settings">
      <div className="card-body">
        <VotingControlsPanel onDirty={onDirty} />
      </div>
    </Card>
  );
}

/** Ballots, results and voting settings. `onUnsavedChange` reports this page's drafts when it shares a page. */
export function MapVotesPage({ onUnsavedChange }: { onUnsavedChange?: (value: boolean) => void } = {}) {
  const admin = useAdmin();
  const [policyDirty, setPolicyDirty] = useState(false);
  const [ballotDirty, setBallotDirty] = useState(false);
  const setUnsavedChanges = onUnsavedChange ?? admin.setUnsavedChanges;
  useEffect(() => {
    setUnsavedChanges(policyDirty || ballotDirty);
    return () => setUnsavedChanges(false);
  }, [policyDirty, ballotDirty, setUnsavedChanges]);
  const resource = useResource<VoteList>(admin.me.role === "admin" ? "map-votes" : null);
  if (admin.me.role !== "admin") return <Empty title="Administrator access required" />;
  return (
    <>
      {resource.error && (
        <div className="notice error" role="alert">
          <p>{resource.error}</p>
          {resource.data && <p>Showing last-known ballots and settings. Refresh before making voting changes.</p>}
          <button
            type="button"
            className="button secondary"
            disabled={admin.busy || resource.loading}
            onClick={resource.refresh}
          >
            Refresh ballot history
          </button>
        </div>
      )}
      {!resource.data ? (
        !resource.error && <Empty title="Loading map votes…" />
      ) : !resource.data.enabled ? (
        <div className="stack">
          <Card
            title={resource.error ? "Voting status unavailable" : "Discord map voting is off"}
            subtitle="You can still queue the next round yourself."
            badge={<Badge kind={resource.error ? "warn" : "neutral"}>{resource.error ? "Unavailable" : "OFF"}</Badge>}
          >
            <div className="card-body">
              <p>
                To enable voting, choose a Discord voting channel in Gramps and check its permissions. Prepare the
                settings below, then enable live voting only after a controlled test.
              </p>
              <VotingSetupCheck />
            </div>
          </Card>
          <VotingSettings onDirty={setPolicyDirty} />
        </div>
      ) : (
        <EnabledMapVotes
          data={resource.data}
          error={resource.error}
          loading={resource.loading}
          refresh={resource.refresh}
          onDirty={setBallotDirty}
        >
          <VotingSettings onDirty={setPolicyDirty} />
        </EnabledMapVotes>
      )}
    </>
  );
}

function EnabledMapVotes({
  data,
  error,
  loading,
  refresh,
  onDirty,
  children,
}: {
  data: VoteList;
  error: string;
  loading: boolean;
  refresh: () => void;
  onDirty: (value: boolean) => void;
  /** Shown between the ballot and its history. */
  children: ReactNode;
}) {
  const admin = useAdmin();
  const active = data.votes.some((vote) => ["publishing", "open", "closing", "needs_review"].includes(vote.state));
  const settings = useResource<SettingsSnapshot>(active ? null : "settings");
  const catalog = useResource<Catalog>(active ? null : "catalog");
  const [selection, setSelection] = useState<MapSelection>({ map: "", experiences: [] });
  const [selectionReady, setSelectionReady] = useState(false);
  const [choices, setChoices] = useState<MapSelection[]>([]);
  const [revision, setRevision] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [review, setReview] = useState<{ draft?: Draft; vote?: Vote } | null>(null);
  const dirty = !!choices.length || !!selection.map || !!selection.lighting || minutes !== 5;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const rotation = settings.data?.rotation;
  const changed = revision !== null && revision !== settings.data?.revision;
  const unavailable =
    loading || !!error || admin.busy || !!settings.error || settings.loading || !!catalog.error || catalog.loading;
  const rotationReady = positionReady(settings.data);
  const canEdit = !active && !unavailable && !changed && rotationReady;
  const canStart = canEdit;
  function clear() {
    setChoices([]);
    setSelection({ map: "", experiences: [] });
    setRevision(null);
    setMinutes(5);
  }
  return (
    <div className="stack">
      <VoteResults data={data} error={error} />
      <Card
        title={data.automatic?.enabled ? "Staff override ballot" : "Manual ballot"}
        subtitle="Publish a ballot in the community’s configured Discord channel."
      >
        <div className="card-body">
          {active && (
            <p className="notice warning">
              An active ballot or unresolved result needs attention below before another vote can start.
            </p>
          )}
          {!active &&
            (changed || settings.error || catalog.error || (!settings.loading && rotation && !rotationReady)) && (
              <p className="notice warning">
                {settings.error ||
                  catalog.error ||
                  (changed
                    ? "Server settings changed. Discard this draft and refresh."
                    : "Voting needs an editable, enabled, ordered rotation and a known current map.")}
              </p>
            )}
          {!active && catalog.data && (
            <>
              <MapPicker
                value={selection}
                change={setSelection}
                onReadyChange={setSelectionReady}
                disabled={!canEdit}
                catalog={catalog.data}
              >
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    !canEdit ||
                    !selectionReady ||
                    choices.length >= 5 ||
                    choices.some((choice) => voteChoiceKey(choice) === voteChoiceKey(selection))
                  }
                  onClick={() => {
                    setRevision(revision ?? settings.data!.revision);
                    setChoices([...choices, selection]);
                    setSelection({ map: "", experiences: [] });
                  }}
                >
                  Add map option
                </button>
              </MapPicker>
              <ol className="rotation-editor" aria-label="Ballot choices">
                {choices.map((choice) => (
                  <li key={voteChoiceKey(choice)}>
                    <span>{selectionLabel(choice)}</span>
                    <button
                      className="button secondary small"
                      disabled={admin.busy}
                      aria-label={`Remove ${selectionLabel(choice)}`}
                      onClick={() =>
                        setChoices(choices.filter((entry) => voteChoiceKey(entry) !== voteChoiceKey(choice)))
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
              <div className="settings-grid ballot-fields">
                <label>
                  Voting duration (minutes)
                  <input
                    type="number"
                    min={2}
                    max={30}
                    step={1}
                    value={minutes}
                    disabled={!canEdit}
                    onChange={(event) => setMinutes(Number(event.target.value))}
                  />
                </label>
              </div>
              <p className="muted">
                Choose 2–5 map, mode or layout combinations. The same map can appear with different modes.
              </p>
              <div className="dialog-actions">
                {dirty && (
                  <button className="button secondary" disabled={admin.busy} onClick={clear}>
                    Discard draft
                  </button>
                )}
                <button
                  className="button primary"
                  disabled={
                    !canStart || choices.length < 2 || !Number.isInteger(minutes) || minutes < 2 || minutes > 30
                  }
                  onClick={() =>
                    setReview({
                      draft: {
                        serverId: data.serverId,
                        revision: revision!,
                        choices: structuredClone(choices),
                        minutes,
                      },
                    })
                  }
                >
                  Review ballot
                </button>
              </div>
            </>
          )}
        </div>
      </Card>
      {children}
      <Card title="Ballot history" subtitle="Latest 20 ballots. Open a row for choices and its receipt.">
        {!data.votes.length ? (
          <Empty title="No ballots yet" />
        ) : (
          <DataTable
            label="Map votes"
            rows={data.votes}
            columns={[
              { label: "Ballot", value: (vote) => Date.parse(vote.createdAt) },
              { label: "Status", value: (vote) => stateLabels[vote.state] },
              { label: "Closes", value: (vote) => Date.parse(vote.closesAt) },
              { label: "Actions" },
            ]}
            renderRow={(vote) => (
              <tr key={vote.id}>
                <td>
                  <details>
                    <summary>
                      {date(vote.createdAt)} · {vote.serverName}
                    </summary>
                    <p>{vote.message}</p>
                    <ol>
                      {vote.choices.map((choice, index) => (
                        <li key={choice.map}>
                          {selectionLabel(choice)}
                          {vote.counted && ` — ${vote.counts[index]} votes`}
                        </li>
                      ))}
                    </ol>
                    <p>
                      Started by {vote.actorName}: {vote.reason}
                    </p>
                    {vote.cancellation && (
                      <p>
                        Closed by {vote.cancellation.actorName}: {vote.cancellation.reason}
                        <br />
                        Previous result: {vote.cancellation.previousMessage}
                      </p>
                    )}
                    <p>
                      Ballot / next-map receipt: <CopyValue value={vote.id} label="ballot receipt" />
                    </p>
                  </details>
                </td>
                <td>
                  <Badge kind={vote.state === "needs_review" ? "warn" : vote.state === "queued" ? "good" : "neutral"}>
                    {stateLabels[vote.state]}
                  </Badge>
                </td>
                <td>{date(vote.closesAt)}</td>
                <td>
                  <div className="row-actions">
                    {vote.messageUrl && (
                      <a className="button secondary small" href={vote.messageUrl} target="_blank" rel="noreferrer">
                        View in Discord ↗
                      </a>
                    )}
                    {["open", "needs_review"].includes(vote.state) && (
                      <button
                        className="button secondary small"
                        disabled={admin.busy}
                        onClick={() => setReview({ vote })}
                      >
                        Close ballot
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>
      {review && (
        <VoteReview
          {...review}
          statusUnavailable={loading || !!error || active}
          close={() => setReview(null)}
          finished={() => {
            if (review.draft) clear();
            refresh();
          }}
        />
      )}
    </div>
  );
}
