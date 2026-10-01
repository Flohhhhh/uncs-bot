import type { ActionName } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Modal } from "../../components/ui";
import { actionDefinitions, allowed } from "../actions/policy";

export function PlayerActions({ steamId, onClose }: { steamId: string; onClose: () => void }) {
  const admin = useAdmin();
  const player = admin.overview?.players.find((entry) => entry.steamId === steamId);
  return (
    <Modal serverScoped title={player?.name ?? "Player unavailable"} description={steamId} onClose={onClose}>
      {player ? (
        <div className="action-list">
          {(["message", "kick", "ban", "whitelist-add", "team", "kill"] as ActionName[]).map((action) => (
            <button
              type="button"
              key={action}
              className="button secondary small"
              disabled={!allowed(action, admin.me, admin.overview, admin.stale, admin.busy)}
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
