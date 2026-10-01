import { useState } from "react";
import type { GameLog } from "../../../../../src/admin/game-log";
import { useResource } from "../../api/use-resource";
import { Card, Empty, date } from "../../components/ui";
import { DataTable } from "../../components/data-table";

export function GameLogView() {
  const { data, error, loading, refresh } = useResource<GameLog>("game-log");
  const [all, setAll] = useState(false);
  const entries =
    data?.entries
      .map((entry, index) => ({ ...entry, key: index }))
      .filter((entry) => all || entry.changesState || entry.event === "COMMAND") ?? [];
  return (
    <Card title="Game command log" subtitle="Recent RCON activity, including other admin tools.">
      <div className="card-body">
        <p className="filter-note">
          This limited log does not identify Discord staff. HTTP status confirms a response, not that a change took
          effect. Private details are omitted.
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error} {data && "Showing the last snapshot."}
          </p>
        )}
        <div className="toolbar">
          <label>
            <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} /> Include reads and
            connections
          </label>
          <button type="button" className="button secondary small" disabled={loading} onClick={refresh}>
            Refresh game log
          </button>
        </div>
        {data && (
          <p className="filter-note">
            {entries.length} shown from {data.entries.length} recent records (up to {data.limit}). Read{" "}
            {date(data.observedAt)}.
          </p>
        )}
        {!data ? (
          <Empty title={error ? "Game log unavailable" : "Loading game log…"} />
        ) : !data.available ? (
          <Empty title="This game build does not provide the command log" />
        ) : entries.length ? (
          <DataTable
            label="Game command log"
            rows={entries}
            columns={[
              {
                label: "When",
                value: (entry) => (entry.timestamp ? Date.parse(entry.timestamp) : null),
                firstDirection: "descending",
              },
              { label: "Event", value: (entry) => entry.event },
              { label: "Request", value: (entry) => entry.operation },
              { label: "HTTP status", value: (entry) => entry.statusCode },
            ]}
            renderRow={(entry) => (
              <tr key={entry.key}>
                <td>{entry.timestamp ? date(entry.timestamp) : "Not supplied"}</td>
                <td>{entry.event}</td>
                <td>{entry.operation || "Details omitted"}</td>
                <td>{entry.statusCode ?? "—"}</td>
              </tr>
            )}
          />
        ) : (
          <Empty
            title={all ? "No recent listener records" : "No commands in these recent records"}
            detail={all ? undefined : "Older commands may have left the game's recent log."}
          />
        )}
      </div>
    </Card>
  );
}
