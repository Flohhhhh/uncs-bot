import { sameMap } from "./map-labels";

// Shared with the dashboard: pure functions only, no Node imports.

export type RoundStatus = {
  map: string;
  matchSeconds?: number | null;
  factionScores: { name: string; score: number }[];
};

/** Community-message round detection: a map change, clock rollback or complete observed score reset. */
export function changedRound(previous: RoundStatus, next: RoundStatus) {
  if (!sameMap(previous.map, next.map)) return true;
  const hasClock =
    Number.isFinite(previous.matchSeconds) &&
    Number.isFinite(next.matchSeconds) &&
    previous.matchSeconds! >= 0 &&
    next.matchSeconds! >= 0;
  if (hasClock) return next.matchSeconds! < previous.matchSeconds! - 30;
  const names = (value: RoundStatus) =>
    value.factionScores
      .map((faction) => faction.name)
      .sort()
      .join("\n");
  const validScores = (value: RoundStatus) =>
    value.factionScores.length > 0 &&
    value.factionScores.every((faction) => Number.isFinite(faction.score) && faction.score >= 0);
  if (!validScores(previous) || !validScores(next) || names(previous) !== names(next)) return false;
  // An ordinary score correction is not a round. Without a clock, accept only
  // an observed complete reset; a poll that misses zero may miss this round.
  return (
    previous.factionScores.some((faction) => faction.score > 0) &&
    next.factionScores.every((faction) => faction.score === 0)
  );
}

export type RoundObservation = {
  at: number;
  map: string;
  nowIndex: number | null;
  scores: { name: string; score: number }[];
  players: { current: number; max: number };
  matchSeconds?: number | null;
  scoreCap?: number | null;
  /** The game's "Players to start a match" (20 when it cannot be read). */
  threshold: number;
};
export type RoundSource = "clock" | "observed" | "baseline";
export type TrackedRound = {
  id: string;
  map: string;
  index: number | null;
  /** Epoch milliseconds: from the clock, the observed boundary, or (baseline) the first observation. */
  startedAt: number;
  source: RoundSource;
  /** False after a restart or read gap, when the start was not observed. */
  exact: boolean;
};
export type RoundPhase = "unknown" | "waiting" | "live";
export type RoundTrack = {
  round: TrackedRound;
  phase: RoundPhase;
  firstSeenAt: number;
  /** When play resumed after at least 30 seconds of pre-round waiting. */
  playingSince: number | null;
  /** Highest leading score this round, in points out of 100. */
  highest: number;
  ended: boolean;
  lastSignalAt: number | null;
  waitingSince: number | null;
  last: {
    at: number;
    map: string;
    index: number | null;
    names: string[];
    scores: number[];
    leading: number;
    matchSeconds: number | null;
  };
};
/** A round known from stored work, such as an open ballot, used after a restart or read gap. */
export type RoundSeed = { round: TrackedRound; highest: number };
export type RoundUpdate = { track: RoundTrack; boundary: boolean; reason: string | null };

export const ROUND_GAP_MS = 60_000;
export const ROUND_MERGE_MS = 180_000;
export const ROUND_SETTLE_MS = 30_000;
const CLOCK_JITTER_MS = 30_000;
const WAIT_BEFORE_PLAY_MS = 30_000;
const SCORE_DROP = 10;
const DEFAULT_CAP = 100;

const roundId = (source: RoundSource, startedAt: number) => `${source}:${Math.round(startedAt)}`;
function newRound(map: string, index: number | null, startedAt: number, source: RoundSource, exact: boolean) {
  return { id: roundId(source, startedAt), map, index, startedAt, source, exact } satisfies TrackedRound;
}
function validClock(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function capOf(observation: Pick<RoundObservation, "scoreCap">) {
  const cap = observation.scoreCap;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP;
}
function validScores(scores: RoundObservation["scores"], cap: number) {
  return (
    scores.length >= 2 &&
    new Set(scores.map((item) => item.name)).size === scores.length &&
    scores.every((item) => !!item.name && Number.isFinite(item.score) && item.score >= 0 && item.score <= cap)
  );
}

/**
 * Infers round boundaries from the clock when the game reports one, and otherwise from observable
 * signals: map or rotation index changes, a full score reset, or a large leading-score drop with no
 * team scoring. Pure: the caller keeps the returned track.
 */
export function trackRound(previous: RoundTrack | null, observation: RoundObservation, seed?: RoundSeed | null) {
  const at = observation.at;
  const cap = capOf(observation);
  const valid = validScores(observation.scores, cap);
  const clock = validClock(observation.matchSeconds) ? observation.matchSeconds : null;
  const clockStart = clock === null ? null : at - clock * 1000;
  const index =
    typeof observation.nowIndex === "number" && Number.isSafeInteger(observation.nowIndex) && observation.nowIndex >= 0
      ? observation.nowIndex
      : null;
  const sorted = valid ? [...observation.scores].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : [];
  const leading = valid ? Math.floor((Math.max(...sorted.map((item) => item.score)) * 100) / cap) : 0;
  const allZero = valid && sorted.every((item) => item.score === 0);
  const phase: RoundPhase = !valid
    ? "unknown"
    : observation.players.current < observation.threshold && allZero
      ? "waiting"
      : "live";
  const last: RoundTrack["last"] = {
    at,
    map: observation.map,
    index,
    names: sorted.map((item) => item.name),
    scores: sorted.map((item) => item.score),
    leading,
    matchSeconds: clock,
  };
  const gap = !previous || at < previous.last.at || at - previous.last.at > ROUND_GAP_MS;

  if (gap) {
    const known = seed ?? (previous ? { round: previous.round, highest: previous.highest } : null);
    let round: TrackedRound;
    let highest = leading;
    let boundary = false;
    if (known && (valid || !previous)) {
      const samePlace =
        sameMap(known.round.map, observation.map) &&
        (known.round.index === null || index === null || known.round.index === index);
      const sameClock =
        clockStart === null ||
        (known.round.source === "clock"
          ? Math.abs(clockStart - known.round.startedAt) <= CLOCK_JITTER_MS
          : clockStart <= known.round.startedAt + CLOCK_JITTER_MS);
      if (samePlace && sameClock && (!valid || leading >= known.highest - SCORE_DROP)) {
        round =
          clockStart === null
            ? { ...known.round, index: index ?? known.round.index, exact: false }
            : {
                ...known.round,
                index: index ?? known.round.index,
                startedAt: clockStart,
                source: "clock",
                exact: true,
              };
        highest = Math.max(known.highest, leading);
      } else {
        round =
          clockStart === null
            ? newRound(observation.map, index, at, "baseline", false)
            : newRound(observation.map, index, clockStart, "clock", true);
        boundary = true;
      }
    } else if (known) {
      // Invalid scores after a gap: keep the known round without deciding anything.
      round = { ...known.round, exact: false };
      highest = known.highest;
    } else
      round =
        clockStart === null
          ? newRound(observation.map, index, at, "baseline", false)
          : newRound(observation.map, index, clockStart, "clock", true);
    return {
      track: {
        round,
        phase,
        firstSeenAt: at,
        playingSince: null,
        highest,
        ended: valid && leading >= DEFAULT_CAP,
        lastSignalAt: boundary ? at : null,
        waitingSince: phase === "waiting" ? at : null,
        last: valid ? last : { ...last, names: [], scores: [], leading: highest },
      },
      boundary,
      reason: boundary ? "gap" : null,
    } satisfies RoundUpdate;
  }

  // An unreadable sample decides nothing and keeps the last valid sample for comparison.
  if (!valid) return { track: { ...previous, phase: "unknown" }, boundary: false, reason: null } satisfies RoundUpdate;

  const before = previous.last;
  const comparable = before.names.length > 0 && before.names.join("\n") === last.names.join("\n");
  const fullReset = comparable && before.scores.some((score) => score > 0) && allZero;
  const reason = !sameMap(before.map, observation.map)
    ? "map"
    : before.index !== null && index !== null && before.index !== index
      ? "index"
      : clock !== null && before.matchSeconds !== null && clock < before.matchSeconds - CLOCK_JITTER_MS / 1000
        ? "clock"
        : fullReset
          ? "reset"
          : comparable &&
              leading <= previous.highest - SCORE_DROP &&
              last.scores.every((score, position) => score <= before.scores[position])
            ? "missed-reset"
            : null;

  let round = previous.round;
  let highest = Math.max(previous.highest, leading);
  let ended = previous.ended || leading >= DEFAULT_CAP;
  let firstSeenAt = previous.firstSeenAt;
  let playingSince = previous.playingSince;
  let lastSignalAt = previous.lastSignalAt;
  let boundary = false;
  if (reason) {
    lastSignalAt = at;
    // A score reset followed by map travel (or the reverse) is one round while nobody has scored.
    const merge =
      previous.round.source !== "baseline" && previous.highest === 0 && at - previous.round.startedAt <= ROUND_MERGE_MS;
    if (merge)
      round = {
        ...previous.round,
        map: observation.map,
        index: index ?? previous.round.index,
        ...(clockStart === null ? {} : { startedAt: clockStart, source: "clock" as const, exact: true }),
      };
    else {
      round =
        clockStart === null
          ? newRound(observation.map, index, at, "observed", true)
          : newRound(observation.map, index, clockStart, "clock", true);
      highest = leading;
      ended = leading >= DEFAULT_CAP;
      firstSeenAt = at;
      playingSince = null;
      boundary = true;
    }
  } else {
    if (round.index === null && index !== null) round = { ...round, index };
    // A clock that appears mid-round dates the round exactly; one that disappears changes nothing.
    if (clockStart !== null && round.source !== "clock")
      round = { ...round, startedAt: clockStart, source: "clock", exact: true };
  }
  let waitingSince = previous.waitingSince;
  if (phase === "waiting") waitingSince = previous.phase === "waiting" && waitingSince !== null ? waitingSince : at;
  else {
    if (previous.phase === "waiting" && waitingSince !== null && at - waitingSince >= WAIT_BEFORE_PLAY_MS && !boundary)
      playingSince = at;
    waitingSince = null;
  }
  return {
    track: { round, phase, firstSeenAt, playingSince, highest, ended, lastSignalAt, waitingSince, last },
    boundary,
    reason: boundary ? reason : null,
  } satisfies RoundUpdate;
}

/** Seconds since an exactly known round start (or the later end of pre-round waiting); null when inexact. */
export function roundElapsed(track: RoundTrack, at: number) {
  if (!track.round.exact) return null;
  return Math.max(0, (at - Math.max(track.round.startedAt, track.playingSince ?? track.round.startedAt)) / 1000);
}
/** Seconds since this process first saw the round (or play resumed); used when the start is unknown. */
export function observedElapsed(track: RoundTrack, at: number) {
  return Math.max(0, (at - Math.max(track.firstSeenAt, track.playingSince ?? track.firstSeenAt)) / 1000);
}
/** Live, and at least 30 seconds since the round's last boundary signal. */
export function roundSettled(track: RoundTrack, at: number) {
  return track.phase === "live" && at - Math.max(track.round.startedAt, track.lastSignalAt ?? 0) >= ROUND_SETTLE_MS;
}
/** Builds an observation from a status read; players and rotation are optional in older test doubles. */
export function roundObservation(
  status: {
    map: string;
    rotation?: { nowIndex?: number | null } | null;
    players?: { current: number; max: number } | null;
    factionScores?: { name: string; score: number }[];
    matchSeconds?: number | null;
    scoreCap?: number | null;
  },
  at: number,
  threshold: number,
): RoundObservation {
  return {
    at,
    map: status.map,
    nowIndex: status.rotation?.nowIndex ?? null,
    scores: status.factionScores ?? [],
    players: status.players ?? { current: 0, max: 0 },
    matchSeconds: status.matchSeconds ?? null,
    scoreCap: status.scoreCap ?? null,
    threshold,
  };
}
