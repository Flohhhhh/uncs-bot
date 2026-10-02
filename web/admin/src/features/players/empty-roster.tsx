import type { Overview } from "../../api/types";
import { Empty } from "../../components/ui";

export function EmptyRoster({ overview, stale }: { overview: Overview; stale: boolean }) {
  if (stale) return <Empty title="No players in the last roster" detail="Refresh to check who is connected now." />;
  if (overview.status.players.current > 0 || overview.unlinkedPlayerCount)
    return (
      <Empty
        title="Player details unavailable"
        detail="No usable player records were returned. Refresh to check the roster again."
      />
    );
  return <Empty title="No players connected" detail="Players will appear here as they join." />;
}
