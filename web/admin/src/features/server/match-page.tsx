import { lightingLabel, mapLabel } from "../../../../../src/common/map-labels";
import { roundStamp } from "../../../../../src/common/game-round";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SettingsSnapshot } from "../../../../../src/common/server-settings";
import { useGameAdmin as useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import type { Overview, Rotation } from "../../api/types";
import { ActionButton, Badge, Card, Empty, Table, Tabs } from "../../components/ui";
import { RotationEditor } from "./rotation-editor";
import { nextRoundSummary, roundLabel, runningRotationSnapshot } from "./next-round";
import { voteSummary, type VoteList } from "../map-votes/vote-status";
import { MapVotesPage } from "../map-votes/map-votes-page";
import { EventsPage } from "../events/events-page";

type View = "next" | "rotation" | "voting" | "events";
type MapView = Extract<View, "next" | "rotation">;
type Drafts = { maps: boolean; voting: boolean; events: boolean };
type Report = Record<keyof Drafts, (value: boolean) => void>;
type SettingsResource = ReturnType<typeof useResource<SettingsSnapshot>>;

const shortTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function elapsed(seconds: number) {
  const total = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

function SummaryItem({ term, value, detail }: { term: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </dd>
    </div>
  );
}

/** Now, Next and Vote in one row, followed by the controls for the match being played. */
function CurrentMatch({
  overview,
  next,
  vote,
}: {
  overview: Overview | null;
  next: { label: string; caption?: string };
  vote?: string;
}) {
  const status = overview?.status;
  const now = status
    ? roundLabel({
        map: status.map,
        experiences: status.experiences ?? [],
        zoneAlternator: status.alternator,
        lighting: status.lighting,
      })
    : "";
  // The clock is shown as of the last check, never extrapolated.
  const clock =
    overview && roundStamp(overview.status, Date.parse(overview.observedAt))
      ? `${elapsed(overview.status.matchSeconds!)} elapsed · checked ${shortTime(overview.observedAt)}`
      : undefined;
  return (
    <section className="match-now" aria-label="Current match">
      <dl className="match-summary">
        <SummaryItem term="Now" value={now || (overview ? "Not supplied" : "Waiting for the server")} detail={clock} />
        <SummaryItem term="Next" value={next.label} detail={next.caption} />
        {vote !== undefined && <SummaryItem term="Vote" value={vote} />}
      </dl>
      <div className="match-controls" role="group" aria-label="Match controls">
        <ActionButton action="lighting" kind="secondary">
          Set lighting
        </ActionButton>
        <ActionButton action="map" kind="secondary">
          Change map
        </ActionButton>
        <span className="match-controls-divider" aria-hidden="true" />
        <ActionButton action="match-end" kind="danger-outline">
          End match
        </ActionButton>
        <ActionButton action="match-restart" kind="danger-outline">
          Restart match
        </ActionButton>
      </div>
    </section>
  );
}

function MatchMapControls({
  settings,
  view,
  active,
  onUnsavedChange,
  onEditingChange,
}: {
  settings: SettingsResource;
  view: MapView;
  active: boolean;
  onUnsavedChange: (value: boolean) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const admin = useAdmin();
  const { data, error, loading, refresh } = settings;
  return (
    <section aria-label="Map controls">
      {error && (
        <div className="notice error" role="alert">
          <p>
            {error} {data && "Showing values from the last successful check. Refresh to continue editing."}
          </p>
          <button type="button" className="button secondary small" disabled={admin.busy || loading} onClick={refresh}>
            Retry map controls
          </button>
        </div>
      )}
      {data ? (
        <RotationEditor
          snapshot={data}
          reload={refresh}
          disabled={admin.busy || !!error}
          active={active}
          view={view}
          onUnsavedChange={onUnsavedChange}
          onEditingChange={onEditingChange}
        />
      ) : (
        !error && <Empty title="Loading map controls…" />
      )}
    </section>
  );
}

/** Each view mounts on first visit and then stays mounted while hidden, so its drafts survive a tab switch. */
function MatchViews({
  selected,
  settings,
  report,
  onEditingChange,
}: {
  selected: View;
  settings: SettingsResource;
  report: Report;
  onEditingChange: (editing: boolean) => void;
}) {
  const [visited, setVisited] = useState<readonly View[]>([selected]);
  if (!visited.includes(selected)) setVisited([...visited, selected]);
  const maps = selected === "next" || selected === "rotation";
  const [mapView, setMapView] = useState<MapView>(maps ? selected : "next");
  if (maps && mapView !== selected) setMapView(selected);
  return (
    <>
      {(visited.includes("next") || visited.includes("rotation")) && (
        <div hidden={!maps}>
          <MatchMapControls
            settings={settings}
            view={mapView}
            active={maps}
            onUnsavedChange={report.maps}
            onEditingChange={onEditingChange}
          />
        </div>
      )}
      {visited.includes("voting") && (
        <div hidden={selected !== "voting"}>
          <MapVotesPage onUnsavedChange={report.voting} />
        </div>
      )}
      {visited.includes("events") && (
        <div hidden={selected !== "events"}>
          <EventsPage onUnsavedChange={report.events} />
        </div>
      )}
    </>
  );
}

function AdminMatchPage() {
  const { overview, setUnsavedChanges } = useAdmin();
  const settings = useResource<SettingsSnapshot>("settings");
  const votes = useResource<VoteList>("map-votes");
  const [editingEntry, setEditingEntry] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({ maps: false, voting: false, events: false });
  // One unsaved-changes flag for the page: discarding one view's draft keeps another view's warning.
  const report = useMemo<Report>(() => {
    const view = (key: keyof Drafts) => (value: boolean) =>
      setDrafts((old) => (old[key] === value ? old : { ...old, [key]: value }));
    return { maps: view("maps"), voting: view("voting"), events: view("events") };
  }, []);
  const unsaved = drafts.maps || drafts.voting || drafts.events;
  useEffect(() => setUnsavedChanges(unsaved), [unsaved, setUnsavedChanges]);
  useEffect(() => () => setUnsavedChanges(false), [setUnsavedChanges]);
  const next =
    !settings.data && !settings.error
      ? { label: "Checking…" }
      : nextRoundSummary(settings.error ? null : settings.data);
  const tabs = [
    { id: "next", label: "Next round", disabled: editingEntry },
    { id: "rotation", label: "Rotation" },
    { id: "voting", label: "Voting" },
    { id: "events", label: "Events" },
  ] as const;
  return (
    <>
      <CurrentMatch overview={overview} next={next} vote={voteSummary(votes.data, votes.error).label} />
      <Tabs label="Match & maps" tabs={tabs} param="view" defaultValue="next" className="match-tabs">
        {(selected) => (
          <MatchViews selected={selected} settings={settings} report={report} onEditingChange={setEditingEntry} />
        )}
      </Tabs>
    </>
  );
}

function StaffMatchPage() {
  const { overview } = useAdmin();
  const { data: rotation, error, loading } = useResource<Rotation>("rotation");
  const next = error
    ? nextRoundSummary(null)
    : rotation
      ? nextRoundSummary(runningRotationSnapshot(rotation, overview?.status.map ?? ""))
      : { label: "Checking…" };
  return (
    <>
      <CurrentMatch overview={overview} next={next} />
      <Card title="Map rotation" badge={<Badge>{error ? "UNAVAILABLE" : rotation?.mode || "LOADING"}</Badge>}>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {error ? (
          <Empty title="Rotation could not be loaded" detail="Refresh to try again." />
        ) : !rotation ? (
          <Empty title={loading ? "Loading rotation…" : "Rotation is unavailable"} />
        ) : !rotation.entries.length ? (
          <Empty title="No maps in the saved rotation" />
        ) : (
          <Table headers={["MAP", "LIGHTING", "STATUS"]}>
            {rotation.entries.map((entry) => (
              <tr key={entry.index}>
                <td>{mapLabel(entry.map)}</td>
                <td>{(entry.lighting && lightingLabel(entry.lighting)) || "—"}</td>
                <td>
                  <Badge kind={entry.status === "now" ? "good" : "neutral"}>
                    {entry.denied ? "Unavailable" : entry.status || "In rotation"}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

/** Match & maps: the current match, then the next round, rotation, voting and events as views in `?view=`. */
export function MatchPage() {
  const { me } = useAdmin();
  return me.role === "admin" ? <AdminMatchPage /> : <StaffMatchPage />;
}
