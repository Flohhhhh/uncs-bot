import { useId } from "react";
import type { ActionName } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Modal } from "../../components/ui";
import { actionDefinitions, allowed } from "../actions/policy";

export function PlayerActions({ steamId, onClose }: { steamId: string; onClose: () => void }) {
  const admin = useAdmin();
  const notice = useId();
  const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
  const actions = (["message", "kick", "ban", "whitelist-add", "team", "kill"] as ActionName[]).map((action) => ({
    action,
    permitted: allowed(action, admin.me, admin.overview, admin.stale, admin.busy),
  }));
  const off = actions.filter(({ permitted }) => !permitted).length;
  // The open dialog pauses polling, so the snapshot can expire here and turn every action off. Otherwise an
  // action is off for the staff role or the server build. Say why next to the disabled buttons.
  let reason = "";
  if (player && admin.stale)
    reason = "Server details need a fresh check. Close this dialog and refresh before choosing an action.";
  else if (player && off && !admin.busy)
    reason =
      off < actions.length
        ? "Some actions are unavailable for your role, connection, or server build."
        : "Unavailable for your role, connection, or server build. Refresh the dashboard before trying again.";
  return (
    <Modal serverScoped title={player?.name ?? "Player unavailable"} description={steamId} onClose={onClose}>
      {reason && (
        <p className="notice warning" role="status" id={notice}>
          {reason}
        </p>
      )}
      {player ? (
        <div className="action-list">
          {actions.map(({ action, permitted }) => (
            <button
              type="button"
              key={action}
              className="button secondary small"
              disabled={!permitted}
              aria-describedby={!permitted && reason ? notice : undefined}
              onClick={() => {
                onClose();
                admin.openAction(action, steamId);
              }}
            >
              {actionDefinitions[action][0]}
            </button>
          ))}
        </div>
      ) : (
        <p>This player is no longer in the current roster.</p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
