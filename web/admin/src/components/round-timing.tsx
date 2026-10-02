import { roundStamp } from "../../../../src/common/game-round";
import type { Overview } from "../api/types";
import type { useResource } from "../api/use-resource";

export function hasRoundTiming(overview: Overview | null) {
  return !!overview && !!roundStamp(overview.status, Date.parse(overview.observedAt));
}

export function RoundTimingNotice({
  resource,
  busy,
  message,
}: {
  resource: ReturnType<typeof useResource<Overview>>;
  busy: boolean;
  message: string;
}) {
  if (resource.loading) return <p role="status">Checking round timing…</p>;
  if (!resource.error && hasRoundTiming(resource.data)) return null;
  return (
    <div className="notice warning" role="alert">
      <p>{resource.error || message}</p>
      <button type="button" className="button secondary" disabled={busy} onClick={resource.refresh}>
        Check round timing
      </button>
    </div>
  );
}
