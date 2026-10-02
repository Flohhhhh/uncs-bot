// Pure statistical outlier tracking from the game's per-player kill and death counters. These are
// prompts for a person to review, never proof of cheating, and never a reason to act automatically.
import type { RoundPhase } from "./round-state";
import type { PerformanceOptions } from "./staff-alerts.config";

export type PerformanceRow = { steamId: string; name: string; kills?: number; deaths?: number };
export type PerformanceReading = {
  /** The round reducer's round ID. */
  roundId: string;
  phase: RoundPhase;
  map: string;
  /** A restart-like boundary inferred by the health reducer: start a new local round. */
  restartLike: boolean;
  players: PerformanceRow[];
};
type Totals = { kills: number; deaths: number };
export type TrackedPlayer = {
  name: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Reads in a row this player was missing from. */
  missed: number;
  base: Totals;
  carried: Totals;
  last: Totals;
  hasDeaths: boolean;
  /** (time, cumulative round kills), covering the last WINDOW + 1 minutes. */
  samples: [number, number][];
  alerted: PerformanceRule[];
};
export type PerformanceRule = "window" | "match";
export type RoundPeak = {
  roundKey: string;
  map: string;
  startedAt: number;
  window: { steamId: string; name: string; kills: number; minutes: number } | null;
  kd: { steamId: string; name: string; kills: number; deaths: number; kd: number } | null;
};
export type PerformanceState = {
  roundId: string | null;
  epoch: number;
  roundKey: string | null;
  map: string | null;
  lastAt: number | null;
  players: Map<string, TrackedPlayer>;
  /** Per-player cooldown ends; kept across rounds. */
  cooldowns: Map<string, number>;
  /** The last 20 rounds, oldest first; the current round is last. */
  peaks: RoundPeak[];
  counters: "unknown" | "available" | "unavailable";
};
export type PerformanceCandidate = {
  kind: "performance-window" | "performance-match";
  rules: PerformanceRule[];
  steamId: string;
  name: string;
  roundKey: string;
  map: string;
  windowKills: number | null;
  windowMinutes: number | null;
  rate: number | null;
  roundKills: number;
  roundDeaths: number | null;
  kd: number | null;
  countedSince: number;
  /** The player already has an alert this round: update that record, post nothing new. */
  amend: boolean;
  suppressed?: "player cooldown";
};
export type PerformanceSettings = Pick<
  PerformanceOptions,
  "windowMinutes" | "windowKills" | "matchKills" | "matchKd" | "cooldownMinutes"
>;

export const MAX_TRACKED = 512;
export const UNSEEN_MS = 15 * 60_000;
export const SAMPLE_GAP_MS = 60_000;
export const MIN_SPAN_MS = 60_000;
const PEAK_ROUNDS = 20;
const PEAK_MIN_KILLS = 10;
const MASS_RESET_SHARE = 0.6;
const MASS_RESET_MIN = 4;

export const initialPerformanceState = (): PerformanceState => ({
  roundId: null,
  epoch: 0,
  roundKey: null,
  map: null,
  lastAt: null,
  players: new Map(),
  cooldowns: new Map(),
  peaks: [],
  counters: "unknown",
});

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
const clone = (player: TrackedPlayer): TrackedPlayer => ({
  ...player,
  base: { ...player.base },
  carried: { ...player.carried },
  last: { ...player.last },
  samples: [...player.samples],
  alerted: [...player.alerted],
});
export const roundKdOf = (kills: number, deaths: number) => Math.round((kills / Math.max(deaths, 1)) * 10) / 10;

function startRound(state: PerformanceState, roundId: string, epoch: number, map: string, now: number) {
  state.roundId = roundId;
  state.epoch = epoch;
  state.roundKey = `${roundId}#${epoch}`;
  state.map = map;
  state.players = new Map();
  state.peaks = [...state.peaks, { roundKey: state.roundKey, map, startedAt: now, window: null, kd: null }].slice(
    -PEAK_ROUNDS,
  );
}

/**
 * One roster read. Counts are deltas from when Gramps first saw each player this round, so a
 * mid-round start under-counts (fewer alerts) and a first observation never alerts. Returns
 * candidates for the worker, which still applies the whitelist skip and the hourly limit.
 */
export function observePerformance(
  previous: PerformanceState,
  reading: PerformanceReading,
  now: number,
  settings: PerformanceSettings,
  knownGood: ReadonlySet<string>,
) {
  const state: PerformanceState = {
    ...previous,
    players: new Map(previous.players),
    cooldowns: new Map(previous.cooldowns),
    peaks: previous.peaks.map((peak) => ({ ...peak })),
  };
  const candidates: PerformanceCandidate[] = [];
  const rows = new Map<string, { name: string; kills: number; deaths: number | null }>();
  for (const row of reading.players) {
    const kills = count(row.kills);
    if (kills === null || rows.has(row.steamId)) continue;
    rows.set(row.steamId, { name: row.name, kills, deaths: count(row.deaths) });
  }
  if (rows.size === 0 && reading.players.length > 0) {
    state.counters = "unavailable";
    return { state, candidates };
  }

  if (state.roundId !== reading.roundId) startRound(state, reading.roundId, 0, reading.map, now);
  else if (reading.restartLike) startRound(state, reading.roundId, state.epoch + 1, reading.map, now);
  else {
    // A same-map restart without a clock: most tracked players' counters fall in one read.
    let tracked = 0,
      lower = 0;
    for (const [steamId, row] of rows) {
      const player = state.players.get(steamId);
      if (!player) continue;
      tracked++;
      if (row.kills < player.last.kills || (row.deaths !== null && row.deaths < player.last.deaths)) lower++;
    }
    if (lower >= MASS_RESET_MIN && lower >= tracked * MASS_RESET_SHARE)
      startRound(state, reading.roundId, state.epoch + 1, reading.map, now);
  }
  const roundKey = state.roundKey!;
  const peak = state.peaks[state.peaks.length - 1];
  state.map = reading.map;
  const gap = state.lastAt !== null && now - state.lastAt > SAMPLE_GAP_MS;
  const windowMs = settings.windowMinutes * 60_000;
  const evaluate = reading.phase !== "unknown";
  const present = new Set<string>();

  for (const [steamId, row] of rows) {
    present.add(steamId);
    const existing = state.players.get(steamId);
    if (!existing) {
      if (state.players.size >= MAX_TRACKED) {
        let oldest: [string, TrackedPlayer] | null = null;
        for (const entry of state.players)
          if (!rows.has(entry[0]) && (!oldest || entry[1].lastSeenAt < oldest[1].lastSeenAt)) oldest = entry;
        if (!oldest) continue;
        state.players.delete(oldest[0]);
      }
      const totals = { kills: row.kills, deaths: row.deaths ?? 0 };
      state.players.set(steamId, {
        name: row.name,
        firstSeenAt: now,
        lastSeenAt: now,
        missed: 0,
        base: totals,
        carried: { kills: 0, deaths: 0 },
        last: { ...totals },
        hasDeaths: row.deaths !== null,
        samples: [[now, 0]],
        alerted: [],
      });
      continue;
    }
    const player = clone(existing);
    state.players.set(steamId, player);
    if (gap || player.missed >= 2) player.samples = [];
    const deaths = row.deaths ?? player.last.deaths;
    if (row.kills < player.last.kills || deaths < player.last.deaths) {
      // A rejoin or counter reset: keep the round totals, restart the rate window.
      player.carried = {
        kills: player.carried.kills + player.last.kills - player.base.kills,
        deaths: player.carried.deaths + player.last.deaths - player.base.deaths,
      };
      player.base = { kills: row.kills, deaths };
      player.samples = [];
    }
    player.last = { kills: row.kills, deaths };
    player.hasDeaths = row.deaths !== null;
    player.name = row.name;
    player.missed = 0;
    player.lastSeenAt = now;
    const kills = player.carried.kills + player.last.kills - player.base.kills;
    const roundDeaths = player.carried.deaths + player.last.deaths - player.base.deaths;
    player.samples.push([now, kills]);
    player.samples = player.samples.filter(([at]) => at >= now - windowMs - 60_000);
    if (!evaluate) continue;

    let windowKills: number | null = null,
      windowMinutes: number | null = null;
    const inside = player.samples.filter(([at]) => at >= now - windowMs);
    const span = inside.length ? now - inside[0][0] : 0;
    const steady = inside.every((sample, index) => index === 0 || sample[0] - inside[index - 1][0] <= SAMPLE_GAP_MS);
    if (span >= MIN_SPAN_MS && steady) {
      windowKills = kills - inside[0][1];
      windowMinutes = Math.round((span / 60_000) * 10) / 10;
      if (windowKills > 0 && (!peak.window || windowKills > peak.window.kills))
        peak.window = { steamId, name: row.name, kills: windowKills, minutes: windowMinutes };
    }
    const kd = player.hasDeaths ? roundKdOf(kills, roundDeaths) : null;
    // Among players with at least 10 kills; a tie goes to the larger sample.
    if (
      kd !== null &&
      kills >= PEAK_MIN_KILLS &&
      (!peak.kd || kd > peak.kd.kd || (kd === peak.kd.kd && kills > peak.kd.kills))
    )
      peak.kd = { steamId, name: row.name, kills, deaths: roundDeaths, kd };

    const matched: PerformanceRule[] = [];
    if (windowKills !== null && windowKills >= settings.windowKills) matched.push("window");
    if (kd !== null && kills >= settings.matchKills && kills / Math.max(roundDeaths, 1) >= settings.matchKd)
      matched.push("match");
    const fresh = matched.filter((rule) => !player.alerted.includes(rule));
    if (!fresh.length || knownGood.has(steamId)) continue;
    const amend = player.alerted.length > 0;
    player.alerted.push(...fresh);
    let suppressed: PerformanceCandidate["suppressed"];
    if (!amend) {
      if ((state.cooldowns.get(steamId) ?? 0) > now) suppressed = "player cooldown";
      else if (settings.cooldownMinutes > 0) state.cooldowns.set(steamId, now + settings.cooldownMinutes * 60_000);
    }
    candidates.push({
      kind: player.alerted.includes("window") ? "performance-window" : "performance-match",
      rules: [...player.alerted],
      steamId,
      name: row.name,
      roundKey,
      map: reading.map,
      windowKills,
      windowMinutes,
      rate: windowKills !== null && windowMinutes ? Math.round((windowKills / windowMinutes) * 10) / 10 : null,
      roundKills: kills,
      roundDeaths: player.hasDeaths ? roundDeaths : null,
      kd,
      countedSince: player.firstSeenAt,
      amend,
      ...(suppressed ? { suppressed } : {}),
    });
  }

  for (const [steamId, player] of state.players) {
    if (present.has(steamId)) continue;
    if (now - player.lastSeenAt > UNSEEN_MS) state.players.delete(steamId);
    else state.players.set(steamId, { ...player, missed: player.missed + 1 });
  }
  if (state.cooldowns.size > 2000)
    for (const [steamId, until] of state.cooldowns) if (until <= now) state.cooldowns.delete(steamId);
  state.lastAt = now;
  state.counters = rows.size ? "available" : state.counters;
  return { state, candidates };
}
