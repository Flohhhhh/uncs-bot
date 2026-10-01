import { useState } from "react";
import type { ActionName, Player } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, Search } from "../../components/ui";
import { DataTable, CopyValue } from "../../components/data-table";
import { actionDefinitions, allowed } from "../actions/policy";
import { FactionChip, FactionOptions, liveFactions, playerFaction } from "./factions";
import { TeamMoveDialog, TeamResults, type TeamMoveResult } from "./team-move";

export function PlayersPage() {
  const admin = useAdmin();
  const [query, setQuery] = useState("");
  const [nameOnly, setNameOnly] = useState(false);
  const [teamFilter, setTeamFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [bulkFaction, setBulkFaction] = useState("");
  const [move, setMove] = useState<{ players: Player[]; faction: string; key: string } | null>(null);
  const [lastMove, setLastMove] = useState<TeamMoveResult | null>(null);
  const [managedId, setManagedId] = useState<string | null>(null);
  const players = admin.overview?.players ?? [];
  const teams = liveFactions(admin.overview);
  const canMove = allowed("team", admin.me, admin.overview, admin.stale, admin.busy);
  const found = players.filter(
    (player) =>
      (!teamFilter ||
        playerFaction(player, teams)?.name === teamFilter ||
        (teamFilter === "unassigned" && !playerFaction(player, teams))) &&
      (nameOnly
        ? [player.name]
        : [player.name, player.steamId, player.faction, playerFaction(player, teams)?.label]
      ).some((value) => (value ?? "").toLowerCase().includes(query.toLowerCase())),
  );
  const selection = players.filter((player) => selected.has(player.steamId));
  const allShownSelected = found.length > 0 && found.every((player) => selected.has(player.steamId));
  const unassigned = players.filter((player) => !playerFaction(player, teams)).length;
  const managedPlayer = players.find((player) => player.steamId === managedId);
  const manageAllowed = !admin.busy && !admin.stale && Boolean(admin.me && admin.me.role !== "viewer");

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
    setLastMove(result);
    const attempted = new Set(result.items.filter((item) => item.state !== "queued").map((item) => item.steamId));
    setSelected((previous) => new Set([...previous].filter((id) => !attempted.has(id))));
    setDestinations((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !attempted.has(id))));
  }

  return (
    <>
      {!!admin.overview?.unlinkedPlayerCount && (
        <p className="notice warning" role="status" aria-label="Incomplete player roster">
          {admin.overview.unlinkedPlayerCount} roster{" "}
          {admin.overview.unlinkedPlayerCount === 1 ? "entry has" : "entries have"} no usable SteamID. Player controls
          and team counts below exclude {admin.overview.unlinkedPlayerCount === 1 ? "it" : "them"}.
        </p>
      )}
      <div className="team-counts">
        {teams.map((team) => {
          const count = players.filter((player) => playerFaction(player, teams)?.name === team.name).length;
          return (
            <div key={team.name} className="team-count">
              <FactionChip team={team} />
              <strong>
                {count}
                <span> player{count === 1 ? "" : "s"}</span>
              </strong>
            </div>
          );
        })}
        {unassigned > 0 && (
          <div className="team-count">
            <span>Unassigned / unrecognized</span>
            <strong>
              {unassigned}
              <span> player{unassigned === 1 ? "" : "s"}</span>
            </strong>
          </div>
        )}
      </div>
      <Search
        value={query}
        onChange={(value) => {
          setQuery(value);
          setNameOnly(false);
        }}
        placeholder="Search name, SteamID, or faction"
      >
        <select
          aria-label="Filter players by team"
          value={teamFilter}
          onChange={(event) => setTeamFilter(event.target.value)}
        >
          <option value="">All teams</option>
          {teams.map((team) => (
            <option key={team.name} value={team.name}>
              {team.label}
            </option>
          ))}
          <option value="unassigned">Unassigned / unrecognized</option>
        </select>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setQuery("UNC");
            setNameOnly(true);
          }}
        >
          UNC in name
        </button>
        {teamFilter && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setTeamFilter("");
              setQuery("");
              setNameOnly(false);
            }}
          >
            Reset filters
          </button>
        )}
      </Search>
      <p className="filter-note">“UNC in name” only searches player names. It does not verify community membership.</p>
      <div className="bulk-team-bar">
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
        <span className="selection-count">
          {selection.length} selected
          {selection.some((player) => !found.includes(player)) && " (includes hidden players)"}
        </span>
        <button
          type="button"
          className="text-button"
          disabled={!selection.length || admin.busy}
          onClick={() => setSelected(new Set())}
        >
          Clear
        </button>
        <div className="bulk-team-controls">
          <select
            aria-label="Destination team for selected players"
            value={bulkFaction}
            onChange={(event) => setBulkFaction(event.target.value)}
            disabled={!canMove || !selection.length}
          >
            <FactionOptions teams={teams} />
          </select>
          <button
            type="button"
            className="button primary"
            disabled={!canMove || !selection.length || !teams.some((team) => team.name === bulkFaction)}
            onClick={() => openMove(selection, bulkFaction)}
          >
            Review move
          </button>
        </div>
      </div>
      {lastMove && (
        <details className="team-results" open={lastMove.stopped || undefined}>
          <summary>
            Last team move · {lastMove.label} ·{" "}
            {lastMove.items.filter((item) => ["applied", "accepted", "pending"].includes(item.state)).length}{" "}
            acknowledged{lastMove.stopped && " · stopped early"}
          </summary>
          <p className="muted">
            Accepted means the game received the request. Assignment confirmation does not force a respawn. Unsent
            players stay selected for a new review.
          </p>
          <TeamResults items={lastMove.items} />
        </details>
      )}
      <Card
        title={`${found.length} player${found.length === 1 ? "" : "s"} shown`}
        subtitle={`${players.length} in the current roster · click a column to sort`}
        badge={<Badge kind={admin.stale ? "warn" : "good"}>{admin.stale ? "LAST ROSTER" : "LIVE ROSTER"}</Badge>}
      >
        {found.length ? (
          <DataTable
            label="Live players"
            rows={found}
            columns={[
              { label: "Select" },
              { label: "Player", value: (player) => player.name },
              { label: "Team", value: (player) => playerFaction(player, teams)?.label ?? player.faction },
              { label: "Kills", value: (player) => player.kills, firstDirection: "descending" },
              { label: "Deaths", value: (player) => player.deaths, firstDirection: "descending" },
              { label: "Ping", value: (player) => player.pingMs },
              { label: "Team / actions" },
            ]}
            renderRow={(player) => {
              const current = playerFaction(player, teams);
              const destination = destinations[player.steamId] ?? "";
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
                  <td>
                    <div className="player-name">
                      <span className="player-icon">{player.name.slice(0, 2).toUpperCase()}</span>
                      <div>
                        <strong>{player.name}</strong>
                        <small>
                          <CopyValue value={player.steamId} />
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <FactionChip team={current} fallback={player.faction || "Choosing team"} />
                  </td>
                  <td>{player.kills ?? "—"}</td>
                  <td>{player.deaths ?? "—"}</td>
                  <td>
                    {player.pingMs ?? "—"} <span className="muted">ms</span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <div className="team-row-controls">
                        <select
                          aria-label={`Destination team for ${player.name}`}
                          value={destination}
                          disabled={!movable}
                          onChange={(event) =>
                            setDestinations((previous) => ({ ...previous, [player.steamId]: event.target.value }))
                          }
                        >
                          <FactionOptions teams={teams} excluded={current?.name} />
                        </select>
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={
                            !movable ||
                            !destination ||
                            destination === current?.name ||
                            !teams.some((team) => team.name === destination)
                          }
                          onClick={() => openMove([player], destination)}
                        >
                          Move
                        </button>
                      </div>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={!manageAllowed}
                        onClick={() => setManagedId(player.steamId)}
                      >
                        More
                      </button>
                    </div>
                  </td>
                </tr>
              );
            }}
          />
        ) : (
          <Empty title="No matching players" detail="Try a different search or refresh the roster." />
        )}
      </Card>
      {managedPlayer && (
        <Modal
          serverScoped
          title={managedPlayer.name}
          description={managedPlayer.steamId}
          onClose={() => setManagedId(null)}
        >
          <div className="action-list">
            {(["message", "kick", "ban", "whitelist-add", "team", "kill"] as ActionName[]).map((action) => (
              <button
                type="button"
                key={action}
                className="button secondary small"
                disabled={!allowed(action, admin.me, admin.overview, admin.stale, admin.busy)}
                onClick={() => {
                  setManagedId(null);
                  admin.openAction(action, managedPlayer.steamId);
                }}
              >
                {actionDefinitions[action][0]}
              </button>
            ))}
          </div>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={() => setManagedId(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
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
