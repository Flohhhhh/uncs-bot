import { mapLabel, selectionLabel } from "../../../../../src/common/map-labels";
import { useEffect, useRef, useState } from "react";
import type { MapSelection, SettingsSnapshot } from "../../../../../src/common/server-settings";
import { VoteResults, voteStateLabels as stateLabels, type Vote, type VoteList } from "./vote-status";
import { useGameApi } from "../../api/server-client";
import { useResource } from "../../api/use-resource";
import type { Catalog, Overview } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { ServerLink as Link } from "../../app/server-link";
import { Badge, Card, Empty, Modal, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import { hasRoundTiming, RoundTimingNotice } from "../../components/round-timing";
import { MapPicker } from "../actions/map-picker";
import { errorMessage } from "../actions/policy";

type Draft = { serverId: string; revision: string; choices: MapSelection[]; minutes: number };
const timingMessage =
  "Round timing is unavailable. Voting needs it to check that the winner still belongs to this round.";

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
  const overview = useResource<Overview>(draft ? "overview" : null);
  const blocked = !!draft && statusUnavailable;
  const timingReady = !draft || (!overview.loading && !overview.error && hasRoundTiming(overview.data));
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted.current || blocked || !timingReady) return;
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
      setResult(
        `${errorMessage(error)} Refresh the ballot history and check Discord before starting another vote. This request will not be sent again.`,
      );
    } finally {
      setBusy(false);
      finished();
    }
  }
  return (
    <Modal serverScoped title={vote ? "Close this ballot" : "Review Discord ballot"} onClose={close} busy={busy}>
      {draft && (
        <>
          <ol className="change-summary">
            {draft.choices.map((choice) => (
              <li key={choice.map}>{selectionLabel(choice)}</li>
            ))}
          </ol>
          <p>
            Voting lasts {draft.minutes} minutes. Each Discord member gets one vote and can change it. Ties use the
            first listed option; no votes keeps the rotation.
          </p>
          <p className="muted">
            The winner queues for the next round only if the round, settings and your administrator access still match.
            The current match continues.
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
          <p className="notice" role="status">
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
          {draft && <RoundTimingNotice resource={overview} busy={busy} message={timingMessage} />}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={close}>
              Back
            </button>
            <button className="button primary" disabled={busy || blocked || !timingReady}>
              {busy ? "Saving…" : vote ? "Confirm close" : "Publish ballot"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function MapVotesPage() {
  const admin = useAdmin();
  const resource = useResource<VoteList>(admin.me.role === "admin" ? "map-votes" : null);
  if (admin.me.role !== "admin") return <Empty title="Administrator access required" />;
  if (!resource.data) return <Empty title={resource.error || "Loading map votes…"} />;
  if (!resource.data.enabled)
    return (
      <Card title="Discord map voting is off" subtitle="You can still choose maps manually." badge={<Badge>OFF</Badge>}>
        <div className="card-body">
          <p>
            <Link className="button primary" to="/match">
              Open match &amp; maps
            </Link>
          </p>
          <details>
            <summary>How to enable voting</summary>
            <p>
              A server owner needs to choose a Discord voting channel and enable map voting in Gramps. This setup is not
              available in the dashboard yet. Automatic voting also needs reliable round timing from the game.
            </p>
          </details>
        </div>
      </Card>
    );
  return (
    <EnabledMapVotes
      data={resource.data}
      error={resource.error}
      loading={resource.loading}
      refresh={resource.refresh}
    />
  );
}

function EnabledMapVotes({
  data,
  error,
  loading,
  refresh,
}: {
  data: VoteList;
  error: string;
  loading: boolean;
  refresh: () => void;
}) {
  const admin = useAdmin();
  const active = data.votes.some((vote) => ["publishing", "open", "closing", "needs_review"].includes(vote.state));
  const settings = useResource<SettingsSnapshot>(active ? null : "settings");
  const catalog = useResource<Catalog>(active ? null : "catalog");
  const overview = useResource<Overview>(active ? null : "overview");
  const [selection, setSelection] = useState<MapSelection>({ map: "", experiences: [] });
  const [selectionReady, setSelectionReady] = useState(false);
  const [choices, setChoices] = useState<MapSelection[]>([]);
  const [revision, setRevision] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [review, setReview] = useState<{ draft?: Draft; vote?: Vote } | null>(null);
  const dirty = !!choices.length || !!selection.map || !!selection.lighting || minutes !== 5;
  const { setUnsavedChanges } = admin;
  useEffect(() => {
    setUnsavedChanges(dirty);
    return () => setUnsavedChanges(false);
  }, [dirty, setUnsavedChanges]);
  const rotation = settings.data?.rotation;
  const changed = revision !== null && revision !== settings.data?.revision;
  const unavailable =
    loading || !!error || admin.busy || !!settings.error || settings.loading || !!catalog.error || catalog.loading;
  const rotationReady =
    rotation?.editable && rotation.enabled && rotation.mode === "Ordered" && rotation.currentIndex !== null;
  const canEdit = !active && !unavailable && !changed && rotationReady;
  const canStart = canEdit && !overview.loading && !overview.error && hasRoundTiming(overview.data);
  function clear() {
    setChoices([]);
    setSelection({ map: "", experiences: [] });
    setRevision(null);
    setMinutes(5);
  }
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          <p>{error}</p>
          <p>Showing last-known ballots. Check history before publishing another vote.</p>
          <button type="button" className="button secondary" disabled={admin.busy || loading} onClick={refresh}>
            Refresh ballot history
          </button>
        </div>
      )}
      <p>
        <Link className="text-button" to="/match">
          ← Match &amp; maps
        </Link>
      </p>
      <VoteResults data={data} error={error} />
      <Card title="Ballot controls" subtitle="Publish a ballot in the community’s configured Discord channel.">
        <div className="card-body">
          {!active && <RoundTimingNotice resource={overview} busy={admin.busy} message={timingMessage} />}
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
                catalog={{
                  ...catalog.data,
                  maps: catalog.data.maps.filter(
                    (map) => map.id !== rotation?.currentMap && !choices.some((choice) => choice.map === map.id),
                  ),
                }}
              />
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    !canEdit ||
                    !selectionReady ||
                    choices.length >= 5 ||
                    selection.map === rotation?.currentMap ||
                    choices.some((choice) => choice.map === selection.map)
                  }
                  onClick={() => {
                    setRevision(revision ?? settings.data!.revision);
                    setChoices([...choices, selection]);
                    setSelection({ map: "", experiences: [] });
                  }}
                >
                  Add map option
                </button>
              </div>
              <ol className="rotation-editor" aria-label="Ballot choices">
                {choices.map((choice) => (
                  <li key={choice.map}>
                    <span>{selectionLabel(choice)}</span>
                    <button
                      className="button secondary small"
                      disabled={admin.busy}
                      aria-label={`Remove ${mapLabel(choice.map)}`}
                      onClick={() => setChoices(choices.filter((entry) => entry.map !== choice.map))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
              <div className="settings-grid">
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
              <p className="muted">Choose 2–5 maps. The current map is excluded.</p>
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
    </>
  );
}
