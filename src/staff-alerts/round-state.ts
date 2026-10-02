// Pure round identity for staff alerts. The game API has no round ID, so a round is inferred from
// status reads: a map or rotation change, a match clock that runs backwards, or a complete or
// large score reset. It groups performance counters by round and labels likely restarts; it is
// never authoritative and never decides anything on its own.
import { sameMap } from "../common/map-labels";

/** Reads further apart than this are a gap: a restart or outage may have happened in between. */
export const ROUND_GAP_MS = 60_000;
/** A score reset and map travel (in either order) before anyone scores are one round. */
export const ROUND_MERGE_MS = 180_000;
const CLOCK_JITTER_MS = 30_000;
/** A leading-score drop of 10 points out of 100 with no team scoring is a missed reset. */
const SCORE_DROP = 10;

export type RoundStatus = {
  map: string;
  matchSeconds?: number | null;
  scoreCap?: number | null;
  rotation?: { nowIndex?: number | null } | null;
  factionScores?: { name: string; score: number }[];
};
/** live: the read had usable team scores. unknown: it did not, so nothing is evaluated. */
export type RoundPhase = "unknown" | "live";
/** clock: dated by the match clock. observed: began at a boundary Gramps saw. first-seen: already running. */
export type RoundSource = "clock" | "observed" | "first-seen";
export type StaffRound = {
  id: string;
  map: string;
  /** Epoch milliseconds: from the match clock, the observed boundary, or the first read. */
  startedAt: number;
  source: RoundSource;
};
type Sample = {
  at: number;
  map: string;
  index: number | null;
  matchSeconds: number | null;
  names: string;
  scores: number[];
  /** The leading score, in points out of 100 when the game reports a score cap. */
  leading: number;
};
export type RoundState = {
  round: StaffRound | null;
  phase: RoundPhase;
  /** The last read with usable scores. Reads without them decide nothing. */
  last: Sample | null;
  /** Highest leading score this round. */
  highest: number;
};
export type RoundUpdate = { state: RoundState; changed: boolean };

export const initialRoundState = (): RoundState => ({ round: null, phase: "unknown", last: null, highest: 0 });

function sampleOf(status: RoundStatus, at: number): Sample | null {
  const cap =
    typeof status.scoreCap === "number" && Number.isFinite(status.scoreCap) && status.scoreCap > 0
      ? status.scoreCap
      : null;
  const scores = status.factionScores ?? [];
  const usable =
    !!status.map &&
    Number.isFinite(at) &&
    scores.length >= 2 &&
    new Set(scores.map((item) => item.name)).size === scores.length &&
    scores.every(
      (item) => !!item.name && Number.isFinite(item.score) && item.score >= 0 && (cap === null || item.score <= cap),
    );
  if (!usable) return null;
  const sorted = [...scores].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const top = Math.max(...sorted.map((item) => item.score));
  const clock = status.matchSeconds;
  const index = status.rotation?.nowIndex;
  return {
    at,
    map: status.map,
    index: typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : null,
    matchSeconds: typeof clock === "number" && Number.isFinite(clock) && clock >= 0 ? clock : null,
    names: sorted.map((item) => item.name).join("\n"),
    scores: sorted.map((item) => item.score),
    leading: cap === null ? top : Math.floor((top * 100) / cap),
  };
}

const roundOf = (source: RoundSource, startedAt: number, map: string): StaffRound => ({
  id: `${source}:${Math.round(startedAt)}`,
  map,
  startedAt,
  source,
});

/**
 * One status read. `changed` is true only when a new round began after an earlier one: never for
 * the first read, a merged reset and map travel, or a read without usable scores.
 */
export function observeRound(previous: RoundState, status: RoundStatus, at: number): RoundUpdate {
  const sample = sampleOf(status, at);
  if (!sample) return { state: { ...previous, phase: "unknown" }, changed: false };
  const { last, round } = previous;
  // Repeated or out-of-order reads decide nothing.
  if (last && at <= last.at) return { state: previous, changed: false };
  const clockStart = sample.matchSeconds === null ? null : at - sample.matchSeconds * 1000;
  const keep = (next: StaffRound): RoundUpdate => ({
    state: { round: next, phase: "live", last: sample, highest: Math.max(previous.highest, sample.leading) },
    changed: false,
  });
  const begin = (): RoundUpdate => {
    let next = clockStart === null ? roundOf("observed", at, sample.map) : roundOf("clock", clockStart, sample.map);
    // A clock that kept running through map travel would repeat the old ID.
    if (next.id === round?.id) next = roundOf("observed", at, sample.map);
    return { state: { round: next, phase: "live", last: sample, highest: sample.leading }, changed: true };
  };
  if (!last || !round)
    return {
      state: {
        round: clockStart === null ? roundOf("first-seen", at, sample.map) : roundOf("clock", clockStart, sample.map),
        phase: "live",
        last: sample,
        highest: sample.leading,
      },
      changed: false,
    };
  const dated = (next: StaffRound): StaffRound =>
    clockStart === null ? next : { ...next, startedAt: clockStart, source: "clock" };
  const dropped = sample.leading <= previous.highest - SCORE_DROP;
  const comparable = last.names === sample.names;

  if (at - last.at > ROUND_GAP_MS) {
    // After a gap, the same round only if nothing says otherwise: place, clock and score agree.
    const samePlace =
      sameMap(round.map, sample.map) && (last.index === null || sample.index === null || last.index === sample.index);
    const sameClock =
      clockStart === null ||
      (round.source === "clock"
        ? Math.abs(clockStart - round.startedAt) <= CLOCK_JITTER_MS
        : clockStart <= round.startedAt + CLOCK_JITTER_MS);
    return samePlace && sameClock && !dropped ? keep(dated({ ...round, map: sample.map })) : begin();
  }

  const changed =
    !sameMap(last.map, sample.map) ||
    (last.index !== null && sample.index !== null && last.index !== sample.index) ||
    (sample.matchSeconds !== null &&
      last.matchSeconds !== null &&
      sample.matchSeconds < last.matchSeconds - CLOCK_JITTER_MS / 1000) ||
    (comparable && last.scores.some((score) => score > 0) && sample.scores.every((score) => score === 0)) ||
    (comparable && dropped && sample.scores.every((score, position) => score <= last.scores[position]));
  // A clock that appears mid-round dates the round; one that disappears changes nothing.
  if (!changed) return keep(round.source === "clock" ? round : dated(round));
  if (round.source !== "first-seen" && previous.highest === 0 && at - round.startedAt <= ROUND_MERGE_MS)
    return keep(dated({ ...round, map: sample.map }));
  return begin();
}
