import { sameMap } from "./map-labels";

export type RoundStamp = { map: string; startedAt: number };

export function roundStamp(
  status: { map: string; matchSeconds?: number | null },
  observedAt: number,
): RoundStamp | null {
  if (
    !status.map ||
    !Number.isFinite(observedAt) ||
    typeof status.matchSeconds !== "number" ||
    !Number.isFinite(status.matchSeconds) ||
    status.matchSeconds < 0
  )
    return null;
  return { map: status.map, startedAt: observedAt - status.matchSeconds * 1000 };
}

/** The API exposes an elapsed clock, not an authoritative round ID. Allow sampling jitter only. */
export function sameRound(a: RoundStamp, b: RoundStamp) {
  return sameMap(a.map, b.map) && Math.abs(a.startedAt - b.startedAt) <= 30_000;
}
