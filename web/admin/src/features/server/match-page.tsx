import { mapLabel, modeLabel, lightingLabel, zoneLabel } from "../../../../../src/common/map-labels";
import { useEffect } from "react";
import type { SettingsSnapshot } from "../../../../../src/common/server-settings";
import { ServerLink as Link } from "../../app/server-link";
import { useGameAdmin as useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import type { Rotation } from "../../api/types";
import { ActionButton, Badge, Card, Empty, Table } from "../../components/ui";
import { RotationEditor } from "./settings-page";
import { MapVoteStatus } from "../map-votes/vote-status";
function MatchMapControls() {
  const admin = useAdmin();
  const { data, error, loading, refresh } = useResource<SettingsSnapshot>("settings");
  const { setUnsavedChanges } = admin;
  useEffect(() => () => setUnsavedChanges(false), [setUnsavedChanges]);
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
          active
          initialView="next"
          onUnsavedChange={setUnsavedChanges}
        />
      ) : (
        !error && <Empty title="Loading map controls…" />
      )}
    </section>
  );
}
export function MatchPage() {
  const { overview, me } = useAdmin();
  const { data: rotation, error, loading } = useResource<Rotation>(me.role === "admin" ? null : "rotation");
  if (!overview) return <Empty title="Waiting for the server" />;
  const { status } = overview;
  return (
    <>
      {me.role === "admin" && (
        <div className="toolbar">
          <Link className="text-button" to="/events">
            Optional event modes →
          </Link>
        </div>
      )}
      <div className={me.role === "admin" ? "match-management" : "split"}>
        <Card title="Current match" badge={<Badge>{mapLabel(status.map)}</Badge>}>
          <div className="card-body">
            <div className="info-row">
              <span>Map</span>
              <strong>{mapLabel(status.map)}</strong>
            </div>
            <div className="info-row">
              <span>Lighting</span>
              <strong>{(status.lighting && lightingLabel(status.lighting)) || "Not supplied"}</strong>
            </div>
            <div className="info-row">
              <span>Mode &amp; rules</span>
              <strong>{status.experiences?.map((id) => modeLabel(id)).join(", ") || "Not supplied"}</strong>
            </div>
            <div className="info-row">
              <span>Zone layout</span>
              <strong>{status.alternator ? zoneLabel(status.alternator) : "Not supplied"}</strong>
            </div>
            <div className="action-list">
              <ActionButton action="lighting">Set lighting</ActionButton>
            </div>
            <details>
              <summary>Change, end or restart the current match</summary>
              <p className="notice warning">
                These controls affect everyone playing. Each action requires a separate confirmation.
              </p>
              <div className="action-list">
                <ActionButton action="map" kind="danger small">
                  Change map
                </ActionButton>
                <ActionButton action="match-end" kind="danger small">
                  End match
                </ActionButton>
                <ActionButton action="match-restart" kind="danger small">
                  Restart match
                </ActionButton>
              </div>
            </details>
          </div>
        </Card>
        {me.role === "admin" ? (
          <>
            <MapVoteStatus />
            <MatchMapControls />
          </>
        ) : (
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
        )}
      </div>
      <div className="notice info">
        Server process restarts, host scheduling, and configuration outside the game remain in the hosting panel.
        “Restart match” only reloads the current round.
      </div>
    </>
  );
}
