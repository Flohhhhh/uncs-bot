import { roundStamp } from "../../../../src/common/game-round";
import type { Overview } from "../api/types";
import type { useResource } from "../api/use-resource";

/** Whether the game reports a match clock for the current round. Information only: nothing here requires one. */
function hasRoundTiming(overview: Overview | null) {
  return !!overview && !!roundStamp(overview.status, Date.parse(overview.observedAt));
}

/**
 * The game status read behind an event start. A failed read needs a retry; a missing match clock is only
 * explained, because the server confirms the round is live when the event is armed.
 */
export function RoundStatusNotice({
  resource,
  busy,
}: {
  resource: ReturnType<typeof useResource<Overview>>;
  busy: boolean;
}) {
  if (resource.loading) return <p role="status">Checking the current round…</p>;
  if (resource.error)
    return (
      <div className="notice warning" role="alert">
        <p>{resource.error}</p>
        <button
          type="button"
          className="button secondary"
          disabled={busy || resource.refreshing}
          onClick={resource.refresh}
        >
          Check the round again
        </button>
      </div>
    );
  if (hasRoundTiming(resource.data)) return null;
  return (
    <p className="muted">
      The game is not reporting a match clock. 50v50 does not need one: Gramps checks that the round is live when the
      event is armed and refuses while the server waits for players.
    </p>
  );
}
