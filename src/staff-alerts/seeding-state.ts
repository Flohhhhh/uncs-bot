// Pure seeding inference. Gramps reads the player count over RCON; it cannot see whether the
// server is listed in the in-game browser.
import { formatDuration, formatLocal, formatWindow, windowAt } from "./local-time";
import type { SeedingOptions } from "./staff-alerts.config";

export type SeedingReading = {
  reachable: boolean;
  /** status.players.current, including unlinked players. */
  players: number | null;
  /** The latest restart-like boundary or recovery after game-down. */
  restart: { at: number; kind: "restart" | "back" } | null;
};
export type SeedingEpisode = {
  id: string;
  startedAt: number;
  /** Unreachable spans pause the low timer; game-down covers that time. */
  pauses: [number, number][];
  pausedSince: number | null;
  notLowSince: number | null;
  afterRestartSent: boolean;
  primeDates: string[];
};
export type SeedingState = { episode: SeedingEpisode | null };
export type SeedingAlert = {
  kind: "seeding-after-restart" | "seeding-prime" | "seeding-recovered";
  severity: "info" | "warning" | "high";
  key: string;
  title: string;
  lines: string[];
  facts: Record<string, string | number>;
};

export const SEEDING_END_MS = 5 * 60_000;
const MAX_PAUSES = 50;
export const SEEDING_GUIDANCE =
  "Gramps reads the player count over RCON. It cannot see whether the server is listed in the browser. Check the in-game browser and consider a seed call.";
const NO_ACTION = "Gramps took no action.";

export const initialSeedingState = (): SeedingState => ({ episode: null });

/** Low time since `from`, excluding unreachable spans. */
function lowElapsed(episode: SeedingEpisode, from: number, now: number) {
  const spans = [...episode.pauses, ...(episode.pausedSince !== null ? [[episode.pausedSince, now]] : [])];
  const paused = spans.reduce(
    (total, [start, end]) => total + Math.max(0, Math.min(end, now) - Math.max(start, from)),
    0,
  );
  return Math.max(0, now - from - paused);
}
function lowLabel(below: number) {
  return below === 1 ? "empty" : `below ${below} players`;
}

/**
 * One read. A low episode starts on the first low read and ends only after five minutes in a
 * row that are not low. Each trigger alerts once per episode (prime time once per window date),
 * and a recovery message follows only if a seeding alert was raised.
 */
export function observeSeeding(previous: SeedingState, reading: SeedingReading, now: number, options: SeedingOptions) {
  const alerts: SeedingAlert[] = [];
  let episode: SeedingEpisode | null = previous.episode
    ? { ...previous.episode, pauses: [...previous.episode.pauses], primeDates: [...previous.episode.primeDates] }
    : null;
  if (!reading.reachable || reading.players === null) {
    if (episode && episode.pausedSince === null) episode.pausedSince = now;
    return { state: { episode }, alerts };
  }
  if (episode && episode.pausedSince !== null) {
    episode.pauses = [...episode.pauses, [episode.pausedSince, now] as [number, number]].slice(-MAX_PAUSES);
    episode.pausedSince = null;
  }
  const zone = options.timeZone;
  const low = reading.players < options.below;
  if (!low) {
    if (episode) {
      episode.notLowSince ??= now;
      if (now - episode.notLowSince >= SEEDING_END_MS) {
        if (episode.afterRestartSent || episode.primeDates.length)
          alerts.push({
            kind: "seeding-recovered",
            severity: "info",
            key: `seed-ok:${episode.id}`,
            title: "Players are back",
            lines: [
              `${reading.players} player${reading.players === 1 ? "" : "s"} on after ${formatDuration(episode.notLowSince - episode.startedAt)} below ${options.below}.`,
              NO_ACTION,
            ],
            facts: {
              players: reading.players,
              lowSince: new Date(episode.startedAt).toISOString(),
              recoveredAt: new Date(episode.notLowSince).toISOString(),
            },
          });
        episode = null;
      }
    }
    return { state: { episode }, alerts };
  }

  episode ??= {
    id: String(now),
    startedAt: now,
    pauses: [],
    pausedSince: null,
    notLowSince: null,
    afterRestartSent: false,
    primeDates: [],
  };
  episode.notLowSince = null;
  const threshold = options.minutes * 60_000;
  const restart = reading.restart;
  if (
    options.afterRestartHours > 0 &&
    restart &&
    restart.at <= now &&
    now - restart.at <= options.afterRestartHours * 3_600_000 &&
    !episode.afterRestartSent
  ) {
    const from = Math.max(episode.startedAt, restart.at);
    const elapsed = lowElapsed(episode, from, now);
    if (elapsed >= threshold) {
      episode.afterRestartSent = true;
      const event =
        restart.kind === "restart"
          ? `the ${formatLocal(restart.at, zone)} restart`
          : `RCON came back at ${formatLocal(restart.at, zone)}`;
      alerts.push({
        kind: "seeding-after-restart",
        severity: "warning",
        key: `seed-restart:${episode.id}`,
        title: `Still ${lowLabel(options.below)} ${Math.floor(elapsed / 60_000)} min after ${event}`,
        lines: [
          `${reading.players} player${reading.players === 1 ? "" : "s"} on; below ${options.below} since ${formatLocal(episode.startedAt, zone)}.`,
          SEEDING_GUIDANCE,
          NO_ACTION,
        ],
        facts: {
          players: reading.players,
          lowSince: new Date(episode.startedAt).toISOString(),
          restartAt: new Date(restart.at).toISOString(),
        },
      });
    }
  }
  const window = windowAt(now, options.primeWindows, zone);
  if (window && !episode.primeDates.includes(window.date)) {
    const elapsed = lowElapsed(episode, Math.max(episode.startedAt, window.start), now);
    if (elapsed >= threshold) {
      episode.primeDates = [...episode.primeDates, window.date].slice(-14);
      alerts.push({
        kind: "seeding-prime",
        severity: "high",
        key: `seed-prime:${episode.id}:${window.date}`,
        title: `Still ${lowLabel(options.below)} ${Math.floor(elapsed / 60_000)} min into prime time`,
        lines: [
          `${reading.players} player${reading.players === 1 ? "" : "s"} on; below ${options.below} since ${formatLocal(episode.startedAt, zone)}. Prime time is ${formatWindow(window.window)} (${zone}).`,
          SEEDING_GUIDANCE,
          NO_ACTION,
        ],
        facts: {
          players: reading.players,
          lowSince: new Date(episode.startedAt).toISOString(),
          window: formatWindow(window.window),
          date: window.date,
        },
      });
    }
  }
  return { state: { episode }, alerts };
}

/** For the status: when the current low episode started and which alerts it raised. */
export function seedingView(state: SeedingState) {
  const episode = state.episode;
  return {
    lowSince: episode ? new Date(episode.startedAt).toISOString() : null,
    alerted: episode
      ? [...(episode.afterRestartSent ? ["after-restart"] : []), ...episode.primeDates.map((date) => `prime:${date}`)]
      : [],
  };
}
