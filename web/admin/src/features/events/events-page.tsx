import { Fragment, useEffect, useRef, useState } from "react";
import type { eventView, EventOptions } from "../../../../../src/server-events/server-events.types";
import type { SettingsSnapshot } from "../../../../../src/common/server-settings";
import { useGameApi } from "../../api/server-client";
import { useResource } from "../../api/use-resource";
import type { Overview } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import { hasRoundTiming, RoundTimingNotice } from "../../components/round-timing";
import { errorMessage } from "../actions/policy";
import { FactionChip, FactionOptions, liveFactions, type Faction } from "../players/factions";

type Event = ReturnType<typeof eventView>;
type Events = { enabled: boolean; serverId: string; events: Event[] };
type Draft = EventOptions & { serverId: string; revision: string; originalLock: boolean; serverName: string };
type Review = { kind: "start"; draft: Draft } | { kind: "stop" | "restore"; event: Event };
const labels = {
  preparing: "Preparing",
  waiting_round: "Armed for next round",
  warming: "Warning players",
  active: "Active",
  stopping: "Stopping",
  complete: "Stopped",
  needs_review: "Needs review",
};
const stateLabel = (event: Event) =>
  event.stop && !["complete", "needs_review"].includes(event.state) ? "Stop requested" : labels[event.state];

const timingMessage = "Round timing is unavailable. 50v50 needs it to start sorting at the right time.";

/** "● Red · Valkyra vs ● Blue · Lonestar", colored by the teams' current colors where the game reports them. */
function EventTeams({ names, teams }: { names: readonly string[]; teams: Faction[] }) {
  return (
    <span className="event-teams">
      {names.map((name, index) => (
        <Fragment key={index}>
          {index > 0 && " vs "}
          <FactionChip team={teams.find((team) => team.name === name)} fallback={name} />
        </Fragment>
      ))}
    </span>
  );
}

function EventReview({
  review,
  close,
  finished,
  statusUnavailable,
}: {
  review: Review;
  close: () => void;
  finished: () => void;
  statusUnavailable: boolean;
}) {
  const { busy, setBusy, overview } = useAdmin();
  const api = useGameApi();
  const [id] = useState(() => crypto.randomUUID());
  const submitted = useRef(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const settings = useResource<SettingsSnapshot>(review.kind === "restore" ? "settings" : null);
  const roster = useResource<Overview>(review.kind === "start" ? "overview" : null);
  const teams = liveFactions(roster.data ?? overview);
  const canStart = review.kind !== "start" || (!roster.loading && !roster.error && hasRoundTiming(roster.data));
  const confirmation = review.kind === "start" ? "START 50V50" : review.kind === "restore" ? "RESTORE TEAM LOCK" : null;
  const lock = settings.data?.fields.find((field) => field.id === "lockOverpopulated");
  const canRestore =
    review.kind !== "restore" || (!settings.loading && !settings.error && typeof lock?.value === "boolean");
  const blocked = review.kind !== "stop" && statusUnavailable;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted.current || !canStart || !canRestore || blocked) return;
    submitted.current = true;
    setBusy(true);
    let path = "events",
      body: Record<string, unknown> = { id, reason: `Staff requested event ${review.kind}.` };
    if (review.kind === "start") {
      const { serverName: _name, originalLock: _lock, ...draft } = review.draft;
      body = { ...body, ...draft, confirm: confirmation };
    } else {
      path += `/${review.event.id}/${review.kind}`;
      if (review.kind === "restore") body = { ...body, revision: settings.data!.revision, confirm: confirmation };
    }
    try {
      setResult((await api<Event>(path, { method: "POST", body: JSON.stringify(body) })).message);
    } catch (error) {
      setFailed(true);
      setResult(
        `${errorMessage(error)} Refresh event history and inspect this request before another attempt. It will not be sent again.`,
      );
    } finally {
      setBusy(false);
      finished();
    }
  }
  return (
    <Modal
      serverScoped
      title={
        review.kind === "start"
          ? "Review optional 50v50"
          : review.kind === "stop"
            ? "Stop this event"
            : "Review team-lock restoration"
      }
      onClose={close}
      busy={busy}
      eyebrow={result ? null : undefined}
    >
      {review.kind === "start" ? (
        <>
          <p>
            <strong>{review.draft.serverName}</strong> · <EventTeams names={review.draft.teams} teams={teams} />
          </p>
          <ul className="change-summary">
            <li>
              Arms for the next observed round. Ends after {review.draft.durationMinutes} minutes, including waiting
              time.
            </li>
            <li>
              Waits {review.draft.warningSeconds} seconds after warnings; balances active teams during the first{" "}
              {review.draft.balanceWindowSeconds} seconds. Redirects arrivals on the third team throughout the round.
            </li>
            <li>
              Forced respawns:{" "}
              <strong>
                {review.draft.forceRespawn ? "on — gear may be lost" : "off — a normal respawn may be needed"}
              </strong>
              .
            </li>
            <li>
              {review.draft.originalLock
                ? "Turns off the native population lock and restores it after stopping, unless newer edits need review."
                : "The native population lock is already off; it stays unchanged."}
            </li>
          </ul>
          <p className="notice warning">
            Moves happen one player at a time and may take several minutes. Buying stays available. This is supervised
            team automation; it cannot guarantee a purchase-free window or prevent manual team switches.
          </p>
        </>
      ) : (
        <>
          <p>
            <strong>{review.event.serverName}</strong> · <EventTeams names={review.event.options.teams} teams={teams} />
          </p>
          <p className="notice warning">
            {review.kind === "stop"
              ? "Stops new player actions and checks whether the original team lock can be restored. A request already sent to the game cannot be recalled."
              : "Inspect the event and action receipts first. If an action was interrupted, stop the affected Gramps instance before continuing. This saves the original lock value without undoing player moves."}
          </p>
          {review.kind === "restore" && (
            <div>
              <p>
                {settings.error ||
                  (settings.loading
                    ? "Reading current settings…"
                    : `Population lock: ${lock?.value === true ? "on" : lock?.value === false ? "off" : "unavailable"} → ${review.event.originalLock ? "on" : "off"}.`)}
              </p>
              {settings.error && !result && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy || settings.loading}
                  onClick={settings.refresh}
                >
                  Retry lock settings
                </button>
              )}
            </div>
          )}
        </>
      )}
      {result ? (
        <>
          <p className={`notice${failed ? " warning" : ""}`} role="status">
            {result}
          </p>
          <p>
            Request receipt: <CopyValue value={id} label="event request" />
          </p>
          <button className="button secondary" onClick={close}>
            Close
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          {blocked && <p role="alert">Refresh event history before continuing.</p>}
          {review.kind === "start" && <RoundTimingNotice resource={roster} busy={busy} message={timingMessage} />}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={close}>
              Back
            </button>
            <button className="button primary" disabled={busy || !canStart || !canRestore || blocked}>
              {busy
                ? "Saving…"
                : review.kind === "start"
                  ? "Arm event"
                  : review.kind === "stop"
                    ? "Confirm stop"
                    : "Restore reviewed lock"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EventDraft({
  review,
  statusUnavailable,
  onUnsavedChange,
}: {
  review: (draft: Draft) => void;
  statusUnavailable: boolean;
  onUnsavedChange: (value: boolean) => void;
}) {
  const admin = useAdmin();
  const settings = useResource<SettingsSnapshot>("settings"),
    roster = useResource<Overview>("overview");
  const defaults = (): EventOptions => ({
    teams: ["", ""],
    durationMinutes: 60,
    warningSeconds: 30,
    balanceWindowSeconds: 300,
    forceRespawn: false,
  });
  const [options, setOptions] = useState(defaults),
    [revision, setRevision] = useState<string | null>(null);
  useEffect(() => {
    onUnsavedChange(revision !== null);
    return () => onUnsavedChange(false);
  }, [revision, onUnsavedChange]);
  const change = (update: Partial<EventOptions>) => {
    setRevision(revision ?? settings.data?.revision ?? null);
    setOptions({ ...options, ...update });
  };
  const lock = settings.data?.fields.find((field) => field.id === "lockOverpopulated");
  const teams = roster.data?.status.factionScores ?? [];
  const factions = liveFactions(roster.data);
  const stale = revision !== null && revision !== settings.data?.revision;
  const unavailable =
    statusUnavailable || settings.loading || roster.loading || !!settings.error || !!roster.error || admin.busy;
  const ready =
    !unavailable &&
    hasRoundTiming(roster.data) &&
    !stale &&
    typeof lock?.value === "boolean" &&
    (!lock.value || lock.editable) &&
    teams.length === 3 &&
    options.teams.every((name) => teams.some((team) => team.name === name)) &&
    options.teams[0] !== options.teams[1] &&
    [
      [options.durationMinutes, 15, 240],
      [options.warningSeconds, 15, 120],
      [options.balanceWindowSeconds, 60, 600],
    ].every(([value, min, max]) => Number.isInteger(value) && value >= min && value <= max);
  return (
    <Card title="Optional 50v50" subtitle="Warn players, balance two teams, and review event actions.">
      <div className="card-body">
        {(settings.error || stale) && (
          <div className="notice warning" role="alert">
            <p>{settings.error || "Server settings changed. Discard this draft and refresh."}</p>
            {settings.error && (
              <button
                type="button"
                className="button secondary small"
                disabled={admin.busy || settings.loading}
                onClick={settings.refresh}
              >
                Retry server settings
              </button>
            )}
          </div>
        )}
        <RoundTimingNotice resource={roster} busy={admin.busy} message={timingMessage} />
        <div className="settings-grid event-fields">
          {([0, 1] as const).map((index) => (
            <label key={index}>
              Team {index + 1}
              <select
                value={options.teams[index]}
                disabled={unavailable}
                onChange={(event) => {
                  const chosen: [string, string] = [...options.teams];
                  chosen[index] = event.target.value;
                  change({ teams: chosen });
                }}
              >
                <FactionOptions teams={factions} excluded={options.teams[index === 0 ? 1 : 0]} />
              </select>
            </label>
          ))}
          <label>
            Duration (minutes)
            <input
              type="number"
              min={15}
              max={240}
              step={1}
              value={options.durationMinutes}
              disabled={unavailable}
              onChange={(event) => change({ durationMinutes: Number(event.target.value) })}
            />
          </label>
          <label>
            Warning delay (seconds)
            <input
              type="number"
              min={15}
              max={120}
              step={1}
              value={options.warningSeconds}
              disabled={unavailable}
              onChange={(event) => change({ warningSeconds: Number(event.target.value) })}
            />
          </label>
          <label>
            Early balancing (seconds)
            <input
              type="number"
              min={60}
              max={600}
              step={1}
              value={options.balanceWindowSeconds}
              disabled={unavailable}
              onChange={(event) => change({ balanceWindowSeconds: Number(event.target.value) })}
            />
          </label>
        </div>
        <label className="checkbox-label event-respawn">
          <input
            type="checkbox"
            checked={options.forceRespawn}
            disabled={unavailable}
            onChange={(event) => change({ forceRespawn: event.target.checked })}
          />
          Force a respawn after a confirmed move (may cost gear)
        </label>
        <p className="muted">
          Requires at most 100 server slots. Players on the third team move to the smaller event team. Discord channel
          membership is not used.
        </p>
        <div className="dialog-actions">
          {revision && (
            <button
              className="button secondary"
              disabled={admin.busy}
              onClick={() => {
                setOptions(defaults());
                setRevision(null);
                settings.refresh();
                roster.refresh();
              }}
            >
              Discard draft
            </button>
          )}
          <button
            className="button primary"
            disabled={!ready}
            onClick={() =>
              review({
                ...structuredClone(options),
                serverId: admin.server?.id ?? "primary",
                revision: revision ?? settings.data!.revision,
                originalLock: lock!.value as boolean,
                serverName: roster.data!.status.serverName,
              })
            }
          >
            Review event
          </button>
        </div>
      </div>
    </Card>
  );
}

function EventOperations({ event, close }: { event: Event; close: () => void }) {
  const { overview } = useAdmin();
  const resource = useResource<{
    operations: {
      id: string;
      operation: { kind: string };
      state: string;
      message: string;
      createdAt: string;
      actorName: string;
    }[];
  }>(`events/${event.id}/operations`);
  return (
    <Modal serverScoped title="Event actions" onClose={close}>
      <p>
        <EventTeams names={event.options.teams} teams={liveFactions(overview)} /> · {event.serverName}. Latest 100
        actions.
      </p>
      {resource.error && (
        <p className="notice warning" role="alert">
          {resource.error} {resource.data && "Showing the last received actions."}
        </p>
      )}
      {!resource.data ? (
        <Empty title={resource.error ? "Event actions unavailable" : "Loading actions…"} />
      ) : !resource.data.operations.length ? (
        <Empty title="No actions recorded yet" />
      ) : (
        <DataTable
          label="Event actions"
          rows={resource.data.operations}
          columns={[
            { label: "Time", value: (op) => Date.parse(op.createdAt) },
            { label: "Action", value: (op) => op.operation.kind },
            { label: "Result", value: (op) => op.state },
          ]}
          renderRow={(op) => (
            <tr key={op.id}>
              <td>{date(op.createdAt)}</td>
              <td>
                {op.operation.kind.replaceAll("_", " ")}
                <p>{op.actorName}</p>
                <CopyValue value={op.id} label="action receipt" />
              </td>
              <td>
                {op.state}
                <p>{op.message}</p>
              </td>
            </tr>
          )}
        />
      )}
      <div className="dialog-actions">
        <button className="button secondary" disabled={resource.loading} onClick={resource.refresh}>
          Refresh actions
        </button>
        <button className="button secondary" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Optional 50v50 events. `onUnsavedChange` reports this page's draft when it shares a page. */
export function EventsPage({ onUnsavedChange }: { onUnsavedChange?: (value: boolean) => void } = {}) {
  const admin = useAdmin();
  const resource = useResource<Events>(admin.me.role === "admin" ? "events" : null);
  const teams = liveFactions(admin.overview);
  const [review, setReview] = useState<Review | null>(null);
  const [inspect, setInspect] = useState<Event | null>(null);
  if (admin.me.role !== "admin") return <Empty title="Administrator access required" />;
  const errorNotice = resource.error && (
    <div className="notice error" role="alert">
      <p>
        {resource.data?.enabled
          ? "Event history could not be refreshed. Showing the last received records. Refresh before starting or restoring an event; stopping remains available."
          : "Event status could not be loaded. Retry to check whether optional events are enabled."}
      </p>
      <button
        type="button"
        className="button secondary small"
        disabled={admin.busy || resource.loading}
        onClick={resource.refresh}
      >
        Retry event status
      </button>
    </div>
  );
  if (!resource.data || (resource.error && !resource.data.enabled))
    return errorNotice || <Empty title="Loading events…" />;
  if (!resource.data.enabled)
    return (
      <Empty
        title="Optional events are not enabled"
        detail="Verify game controls in a supervised session before enabling optional events in the bot configuration."
      />
    );
  const active = resource.data.events.some((event) => event.state !== "complete");
  return (
    <>
      {errorNotice}
      <div className="stack">
        {!active && (
          <EventDraft
            onUnsavedChange={onUnsavedChange ?? admin.setUnsavedChanges}
            statusUnavailable={resource.loading || !!resource.error}
            review={(draft) => setReview({ kind: "start", draft })}
          />
        )}
        <Card
          title="Event history"
          subtitle="Latest 20 events. Refresh to see worker progress; an unresolved event must be reviewed before another starts."
        >
          {!resource.data.events.length ? (
            <Empty title="No events yet" />
          ) : (
            <DataTable
              label="Optional events"
              rows={resource.data.events}
              columns={[
                { label: "Event", value: (event) => Date.parse(event.createdAt) },
                { label: "Status", value: (event) => stateLabel(event) },
                { label: "Ends", value: (event) => Date.parse(event.endsAt) },
                { label: "Actions" },
              ]}
              renderRow={(event) => (
                <tr key={event.id}>
                  <td>
                    <details>
                      <summary>
                        <EventTeams names={event.options.teams} teams={teams} /> · {event.serverName}
                      </summary>
                      <p>{event.message}</p>
                      <p>
                        Started by {event.actorName}: {event.reason}
                      </p>
                      <p>
                        {event.movedThisRound} confirmed moves this round. Forced respawns:{" "}
                        {event.options.forceRespawn ? "on" : "off"}.
                      </p>
                      {event.stop && (
                        <p>
                          Stopped by {event.stop.actorName}: {event.stop.reason}
                        </p>
                      )}
                      <CopyValue value={event.id} label="event receipt" />
                    </details>
                  </td>
                  <td>
                    <Badge
                      kind={
                        resource.error || event.state === "needs_review"
                          ? "warn"
                          : event.state === "complete"
                            ? "neutral"
                            : "good"
                      }
                    >
                      {resource.error ? `Last known: ${stateLabel(event)}` : stateLabel(event)}
                    </Badge>
                  </td>
                  <td>{date(event.endsAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="button secondary small"
                        disabled={admin.busy}
                        onClick={() => setInspect(event)}
                      >
                        View actions
                      </button>
                      {event.state !== "complete" && !event.stop && (
                        <button
                          className="button secondary small"
                          disabled={admin.busy}
                          onClick={() => setReview({ kind: "stop", event })}
                        >
                          Stop event
                        </button>
                      )}
                      {event.stop && event.state === "needs_review" && (
                        <button
                          className="button secondary small"
                          disabled={admin.busy || resource.loading || !!resource.error}
                          onClick={() => setReview({ kind: "restore", event })}
                        >
                          Review restoration
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            />
          )}
        </Card>
      </div>
      {review && (
        <EventReview
          statusUnavailable={resource.loading || !!resource.error}
          review={review}
          close={() => setReview(null)}
          finished={resource.refresh}
        />
      )}
      {inspect && <EventOperations event={inspect} close={() => setInspect(null)} />}
    </>
  );
}
