import { useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import type { ActionName, Player } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Sheet } from "../../components/ui";
import { CopyValue } from "../../components/data-table";
import { actionDefinitions, allowed } from "../actions/policy";
import { FactionChip, liveFactions, playerFaction } from "./factions";
import { TeamMoveDialog, type TeamMoveResult } from "./team-move";

/** A player to show in the panel. `name` is used when the player is no longer in the live roster. */
export type SheetPlayer = { steamId: string; name?: string };

/** `/activity?view=…`, keeping only the selected server from the current URL. */
export function activityLink(search: string, view: "feed" | "combat" | "actions", extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  const server = new URLSearchParams(search).get("server");
  if (server) params.set("server", server);
  params.set("view", view);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return { pathname: "/activity", search: `?${params}` };
}
/** `/activity?view=…&player=…`, keeping the selected server. */
export function playerHistory(search: string, view: "combat" | "actions", steamId: string) {
  return activityLink(search, view, { player: steamId });
}

/** Opens the player panel; shown wherever a player's name appears. */
export function PlayerButton({
  player,
  onOpen,
}: {
  player: Player | SheetPlayer;
  onOpen: (player: SheetPlayer) => void;
}) {
  const name = player.name || player.steamId;
  return (
    <button
      type="button"
      className="player-link"
      aria-haspopup="dialog"
      onClick={() => onOpen({ steamId: player.steamId, name })}
    >
      {name}
    </button>
  );
}

/** Every action the panel offers; "team" covers the per-team move buttons. */
const panelActions: ActionName[] = ["message", "team", "kick", "ban", "whitelist-add", "kill"];

const stat = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";

/**
 * The player panel: stats, SteamID, history links and grouped actions. Each action opens its own
 * review on top of the panel, which stays open behind it.
 */
export function PlayerSheet({
  player: target,
  onClose,
  onTeamMoveComplete,
}: {
  player: SheetPlayer;
  onClose: () => void;
  onTeamMoveComplete?: (result: TeamMoveResult) => void;
}) {
  const admin = useAdmin();
  const location = useLocation();
  const [move, setMove] = useState<{ players: Player[]; faction: string; key: string } | null>(null);
  const { steamId } = target;
  const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
  const teams = liveFactions(admin.overview);
  const current = player ? playerFaction(player, teams) : undefined;
  const can = (action: ActionName) => allowed(action, admin.me, admin.overview, admin.stale, admin.busy);
  const notice = useId();
  const off = panelActions.filter((action) => !can(action)).length;
  // The snapshot can expire while the panel is open and turn every action off; the page's own refresh is
  // behind the panel. Otherwise an action is off for the staff role or the server build. Say why next to the
  // disabled buttons.
  let reason = "";
  if (player && admin.stale)
    reason = "Server details need a fresh check. Close this panel and refresh before choosing an action.";
  else if (player && off && !admin.busy)
    reason =
      off < panelActions.length
        ? "Some actions are unavailable for your role, connection, or server build."
        : "Unavailable for your role, connection, or server build. Refresh the dashboard before trying again.";
  const describedBy = (action: ActionName) => (!can(action) && reason ? notice : undefined);
  const button = (action: ActionName, kind = "secondary") => (
    <button
      type="button"
      className={`button ${kind} small`}
      disabled={!can(action)}
      aria-describedby={describedBy(action)}
      onClick={() => admin.openAction(action, steamId)}
    >
      {actionDefinitions[action][0]}
    </button>
  );
  const linkable = isPublicIndividualSteamId(steamId);
  const server = new URLSearchParams(location.search).get("server");
  return (
    <>
      <Sheet title={player?.name ?? target.name ?? steamId} onClose={onClose} className="player-sheet">
        {player ? (
          <>
            <FactionChip team={current} fallback={player.faction || "Choosing team"} />
            <dl className="player-stats">
              <div>
                <dt>Kills</dt>
                <dd>{stat(player.kills)}</dd>
              </div>
              <div>
                <dt>Deaths</dt>
                <dd>{stat(player.deaths)}</dd>
              </div>
              <div>
                <dt>Ping</dt>
                <dd>{typeof player.pingMs === "number" ? `${player.pingMs} ms` : "—"}</dd>
              </div>
              <div>
                <dt>Cash</dt>
                <dd>{stat(player.cash)}</dd>
              </div>
            </dl>
            {admin.stale && <p className="muted">From the last roster check.</p>}
          </>
        ) : !admin.overview ? (
          // Records pages do not read the live roster; never present that as the player leaving.
          <p className="notice info">
            The live roster is not loaded on this page.{" "}
            <Link to={{ pathname: "/players", search: server ? `?${new URLSearchParams({ server })}` : "" }}>
              Open Live players
            </Link>{" "}
            to act on this player.
          </p>
        ) : (
          <p className="notice info">
            {admin.stale ? "Not in the last roster check." : "This player is no longer in the current roster."}
          </p>
        )}
        <p className="player-sheet-id">
          <span className="muted">SteamID</span> <CopyValue value={steamId} />
        </p>
        {linkable && (
          <p className="player-sheet-links">
            <Link className="text-button" to={playerHistory(location.search, "combat", steamId)} onClick={onClose}>
              Combat history →
            </Link>
            <Link className="text-button" to={playerHistory(location.search, "actions", steamId)} onClick={onClose}>
              Actions on this player →
            </Link>
          </p>
        )}
        {/* Always present, so screen readers announce the reason when it is filled in. */}
        <div role="status" id={notice}>
          {reason && <p className="notice warning">{reason}</p>}
        </div>
        {player && (
          <div className="player-sheet-actions">
            <section aria-label="Message">
              <h3>Message</h3>
              <div className="action-list">{button("message")}</div>
            </section>
            <section aria-label="Team">
              <h3>Team</h3>
              <div className="action-list">
                {teams
                  .filter((team) => team.name !== current?.name)
                  .map((team) => (
                    <button
                      type="button"
                      key={team.name}
                      className="button secondary small"
                      aria-label={`Move to ${team.label}`}
                      disabled={!can("team")}
                      aria-describedby={describedBy("team")}
                      onClick={() => setMove({ players: [player], faction: team.name, key: crypto.randomUUID() })}
                    >
                      <FactionChip team={team} />
                    </button>
                  ))}
                {teams.length === 0 && <span className="muted">No teams reported</span>}
              </div>
            </section>
            <section aria-label="Moderation">
              <h3>Moderation</h3>
              <div className="action-list">
                {button("kick", "danger")}
                {button("ban", "danger")}
              </div>
            </section>
            <section aria-label="Whitelist">
              <h3>Whitelist</h3>
              <div className="action-list">{button("whitelist-add")}</div>
            </section>
            <details className="player-sheet-more">
              <summary>More</summary>
              <div className="action-list">{button("kill")}</div>
            </details>
          </div>
        )}
      </Sheet>
      {move && (
        <TeamMoveDialog
          key={move.key}
          players={move.players}
          initialFaction={move.faction}
          onClose={() => setMove(null)}
          onComplete={onTeamMoveComplete}
        />
      )}
    </>
  );
}
