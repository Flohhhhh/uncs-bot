import { useState } from "react";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Empty, Search, Sheet } from "../../components/ui";
import { FactionChip, liveFactions, playerFaction } from "./factions";

/**
 * Pick a connected player for an action, or enter a SteamID for someone offline. Picking only chooses
 * the target: the action's own review still follows.
 */
export function PlayerPicker({
  title,
  onPick,
  onClose,
}: {
  title: string;
  /** Called with a connected player's SteamID, or with no SteamID to enter one by hand. */
  onPick: (steamId?: string) => void;
  onClose: () => void;
}) {
  const { overview, stale } = useAdmin();
  const [query, setQuery] = useState("");
  const teams = liveFactions(overview);
  const search = query.trim().toLowerCase();
  const players = (overview?.players ?? []).filter((player) =>
    [player.name, player.steamId].some((value) => value.toLowerCase().includes(search)),
  );
  return (
    <Sheet title={title} description="Pick a connected player, or enter a SteamID." onClose={onClose}>
      <div className="player-picker">
        <Search value={query} onChange={setQuery} placeholder="Search name or SteamID" />
        {players.length ? (
          <ul className="picker-list" aria-label={stale ? "Players in the last roster check" : "Connected players"}>
            {players.map((player) => (
              <li key={player.steamId}>
                <button type="button" className="picker-row" onClick={() => onPick(player.steamId)}>
                  <span className="picker-name">
                    <strong>{player.name || player.steamId}</strong>
                    <small>{player.steamId}</small>
                  </span>
                  <FactionChip team={playerFaction(player, teams)} fallback={player.faction || "Choosing team"} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title={search ? "No matching players" : stale ? "No players in the last roster" : "No players connected"}
          />
        )}
        {stale && players.length > 0 && <p className="muted">From the last roster check.</p>}
        <div className="picker-manual">
          <span>Player not connected?</span>
          <button type="button" className="button secondary small" onClick={() => onPick()}>
            Enter a SteamID
          </button>
        </div>
      </div>
    </Sheet>
  );
}
