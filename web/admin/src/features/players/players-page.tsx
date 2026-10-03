import { useEffect, useState, type ReactNode } from "react";
import type { Player } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Card, Empty, Search } from "../../components/ui";
import { DataTable } from "../../components/data-table";
import { allowed } from "../actions/policy";
import { PlayerButton, PlayerSheet, type SheetPlayer } from "./player-actions";
import { FactionChip, FactionOptions, liveFactions, playerFaction } from "./factions";
import { TeamMoveDialog, TeamResults, type TeamMoveResult } from "./team-move";
import { EmptyRoster } from "./empty-roster";

/** A one-line, honest summary of a move that finished without a failure or stop. */
function moveSummary(result: TeamMoveResult) {
  const count = (state: string) => result.items.filter((item) => item.state === state).length;
  const parts = [
    count("applied") && `${count("applied")} applied`,
    count("accepted") && `${count("accepted")} accepted, not verified`,
    count("pending") && `${count("pending")} pending`,
    count("skipped") && `${count("skipped")} already on that team`,
    // Players who left or changed team after the review, whether the dialog or the server caught it.
    count("unmatched") + count("refused") && `${count("unmatched") + count("refused")} skipped, roster changed`,
  ].filter(Boolean);
  return `Team move to ${result.label}: ${parts.join(", ") || "no requests sent"}.`;
}

export function PlayersPage() {
  const admin = useAdmin();
  const [query, setQuery] = useState("");
  const [uncOnly, setUncOnly] = useState(false);
  const [teamFilter, setTeamFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkFaction, setBulkFaction] = useState("");
  const [move, setMove] = useState<{ players: Player[]; faction: string; key: string } | null>(null);
  const [lastMove, setLastMove] = useState<TeamMoveResult | null>(null);
  const [moved, setMoved] = useState<{ text: string; key: string } | null>(null);
  const [managed, setManaged] = useState<SheetPlayer | null>(null);
  const players = admin.overview?.players ?? [];
  const teams = liveFactions(admin.overview);
  const canMove = allowed("team", admin.me, admin.overview, admin.stale, admin.busy);
  const search = query.trim().toLowerCase();
  const found = players.filter(
    (player) =>
      (!teamFilter ||
        playerFaction(player, teams)?.name === teamFilter ||
        (teamFilter === "unassigned" && !playerFaction(player, teams))) &&
      (!uncOnly || player.name.toLowerCase().includes("unc")) &&
      [player.name, player.steamId, player.faction, playerFaction(player, teams)?.label].some((value) =>
        (value ?? "").toLowerCase().includes(search),
      ),
  );
  const selection = players.filter((player) => selected.has(player.steamId));
  const allShownSelected = found.length > 0 && found.every((player) => selected.has(player.steamId));
  const unassigned = players.filter((player) => !playerFaction(player, teams)).length;
  useEffect(() => {
    if (!moved) return;
    const timer = window.setTimeout(() => setMoved(null), 8000);
    return () => window.clearTimeout(timer);
  }, [moved]);

  function toggle(id: string, checked: boolean) {
    if (!canMove) return;
    setSelected((previous) => {
      const next = new Set([...previous].filter((value) => players.some((player) => player.steamId === value)));
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function openMove(targets: Player[], faction = "") {
    if (!canMove || !targets.length) return;
    setMove({
      players: targets,
      faction: teams.some((team) => team.name === faction) ? faction : "",
      key: crypto.randomUUID(),
    });
  }
  function completed(result: TeamMoveResult) {
    const attempted = new Set(result.items.filter((item) => item.state !== "queued").map((item) => item.steamId));
    setSelected((previous) => new Set([...previous].filter((id) => !attempted.has(id))));
    // Keep the full results only when something needs attention: they list the unsent players.
    if (result.stopped || result.items.some((item) => item.state === "failed" || item.state === "unknown")) {
      setLastMove(result);
      setMoved(null);
    } else {
      setLastMove(null);
      setMoved({ text: moveSummary(result), key: crypto.randomUUID() });
    }
  }
  function chip(id: string, label: ReactNode, count: number) {
    return (
      <button
        type="button"
        key={id || "all"}
        className="filter-chip"
        aria-pressed={teamFilter === id}
        onClick={() => setTeamFilter(id)}
      >
        {label} <span className="chip-count">{count}</span>
      </button>
    );
  }

  if (!admin.overview)
    return <Empty title="Waiting for the player list" detail="The roster will appear when the server responds." />;

  return (
    <>
      {!!admin.overview?.unlinkedPlayerCount && (
        <p className="notice warning" role="status" aria-label="Incomplete player roster">
          {admin.overview.unlinkedPlayerCount} roster{" "}
          {admin.overview.unlinkedPlayerCount === 1 ? "entry has" : "entries have"} no usable SteamID. Player controls
          and team counts below exclude {admin.overview.unlinkedPlayerCount === 1 ? "it" : "them"}.
        </p>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search name, SteamID, or faction">
        <div className="filter-chips" role="group" aria-label="Filter players by team">
          {chip("", "All", players.length)}
          {teams.map((team) =>
            chip(
              team.name,
              <FactionChip team={team} />,
              players.filter((player) => playerFaction(player, teams)?.name === team.name).length,
            ),
          )}
          {/* A filtered team that has left the match stays visible, so the filter is never hidden and All clears it. */}
          {teamFilter &&
            teamFilter !== "unassigned" &&
            !teams.some((team) => team.name === teamFilter) &&
            chip(teamFilter, `${teamFilter} (not in this match)`, 0)}
          {(unassigned > 0 || teamFilter === "unassigned") && chip("unassigned", "Unassigned", unassigned)}
          <button
            type="button"
            className="filter-chip"
            aria-pressed={uncOnly}
            title="Matches player names only. It does not verify community membership."
            onClick={() => setUncOnly((value) => !value)}
          >
            UNC in name
          </button>
        </div>
      </Search>
      <div className={selection.length ? "bulk-team-bar" : "sr-only"}>
        <span className="selection-count" role="status">
          {selection.length} selected
          {selection.some((player) => !found.includes(player)) && " (includes hidden players)"}
        </span>
        {selection.length > 0 && (
          <div className="bulk-team-controls">
            <span aria-hidden="true">Move to</span>
            <select
              aria-label="Destination team for selected players"
              value={bulkFaction}
              onChange={(event) => setBulkFaction(event.target.value)}
              disabled={!canMove}
            >
              <FactionOptions teams={teams} />
            </select>
            <button
              type="button"
              className="button primary small"
              disabled={!canMove || !teams.some((team) => team.name === bulkFaction)}
              onClick={() => openMove(selection, bulkFaction)}
            >
              Review move
            </button>
            <button type="button" className="text-button" disabled={admin.busy} onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}
      </div>
      {moved && (
        <p className="team-move-status" role="status">
          {moved.text}
        </p>
      )}
      {lastMove && (
        <details className="team-results" open>
          <summary>
            Last team move · {lastMove.label} ·{" "}
            {lastMove.items.filter((item) => ["applied", "accepted", "pending"].includes(item.state)).length}{" "}
            acknowledged{lastMove.stopped && " · stopped early"}
          </summary>
          <p className="muted">Unsent players stay selected for a new review.</p>
          <TeamResults items={lastMove.items} />
        </details>
      )}
      <Card
        className="player-roster"
        title={`${found.length} player${found.length === 1 ? "" : "s"} shown`}
        subtitle={`${players.length} in the current roster`}
        badge={
          <div className="roster-tools">
            <label className="selection-label">
              <input
                type="checkbox"
                aria-label="Select all shown players"
                checked={allShownSelected}
                disabled={!canMove || !found.length}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((previous) => {
                    const next = new Set([...previous].filter((id) => players.some((player) => player.steamId === id)));
                    for (const player of found) {
                      if (checked) next.add(player.steamId);
                      else next.delete(player.steamId);
                    }
                    return next;
                  });
                }}
              />
              Select shown
            </label>
            <Badge kind={admin.stale ? "warn" : "good"}>{admin.stale ? "LAST ROSTER" : "LIVE ROSTER"}</Badge>
          </div>
        }
      >
        {found.length ? (
          <DataTable
            label="Live players"
            rows={found}
            columns={[
              { label: "Select", hideLabel: true },
              { label: "Player", value: (player) => player.name },
              { label: "Team", value: (player) => playerFaction(player, teams)?.label ?? player.faction },
              { label: "Kills", value: (player) => player.kills, firstDirection: "descending" },
              { label: "Deaths", value: (player) => player.deaths, firstDirection: "descending" },
              { label: "Ping", value: (player) => player.pingMs },
            ]}
            renderRow={(player) => {
              const current = playerFaction(player, teams);
              const movable = canMove && teams.some((team) => team.name !== current?.name);
              return (
                <tr key={player.steamId}>
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select ${player.name}`}
                      checked={selected.has(player.steamId)}
                      disabled={!movable}
                      onChange={(event) => toggle(player.steamId, event.target.checked)}
                    />
                  </td>
                  <td className="player-identity">
                    <PlayerButton player={player} onOpen={setManaged} />
                  </td>
                  <td className="player-team">
                    <FactionChip team={current} fallback={player.faction || "Choosing team"} />
                  </td>
                  <td>{player.kills ?? "—"}</td>
                  <td>{player.deaths ?? "—"}</td>
                  <td>
                    {player.pingMs ?? "—"} <span className="muted">ms</span>
                  </td>
                </tr>
              );
            }}
          />
        ) : players.length ? (
          <Empty title="No matching players" detail="Change or clear the filters to see more players." />
        ) : (
          <EmptyRoster overview={admin.overview} stale={admin.stale} />
        )}
      </Card>
      {managed && <PlayerSheet player={managed} onClose={() => setManaged(null)} onTeamMoveComplete={completed} />}
      {move && (
        <TeamMoveDialog
          key={move.key}
          players={move.players}
          initialFaction={move.faction}
          onClose={() => setMove(null)}
          onComplete={completed}
        />
      )}
    </>
  );
}
