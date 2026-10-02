// Pure health inference from RCON reads. Gramps cannot see uptime, a boot ID, CPU, tick rate or
// the server browser, so every finding here is inferred and says so.
import type { RconErrorKind } from "../admin/rcon-protocol";
import { mapLabel, sameMap } from "../common/map-labels";
import { ROUND_HOLD_MS } from "../server-community/community-state";
import { ROUND_GAP_MS } from "./round-state";
import { formatDuration, formatLocal, scheduledMatch } from "./local-time";
import type { HealthOptions } from "./staff-alerts.config";

export type HealthFailureKind = Exclude<RconErrorKind, "paused">;
export type HealthReading =
  | {
      ok: true;
      map: string;
      players: number;
      matchSeconds: number | null;
      build: string | null;
      /** The round reducer reports a different round than the previous read. */
      roundChanged: boolean;
    }
  | { ok: false; kind: RconErrorKind };
type GoodRead = { at: number; map: string; players: number; matchSeconds: number | null; build: string | null };
export type HealthOutage = {
  since: number;
  failures: number;
  kind: HealthFailureKind;
  downSent: boolean;
  successes: number;
  firstSuccessAt: number | null;
};
/** A restart that a map load could also explain, held until the roster stays near empty. */
export type PendingRestart = { at: number; playersBefore: number; signals: string[] };
export type HealthState = {
  lastGood: GoodRead | null;
  outage: HealthOutage | null;
  pending: PendingRestart | null;
  /** Last non-empty build; null until the first one after boot (the silent baseline). */
  build: string | null;
  lastRestartAt: number | null;
  lastRestartAlertAt: number | null;
  /** The latest restart-like boundary or recovery after game-down; starts the post-restart seeding watch. */
  watch: { at: number; kind: "restart" | "back" } | null;
};
export type HealthAlert = {
  kind: "game-down" | "game-back" | "game-restart" | "game-build";
  severity: "info" | "warning" | "high";
  key: string;
  title: string;
  lines: string[];
  facts: Record<string, string | number>;
  suppressed?: string;
};

export const RESTART_ALERT_MS = 30 * 60_000;
/** The community worker's map-load hold: a map load refills the roster sooner than this. */
export const RESTART_HOLD_MS = ROUND_HOLD_MS;
const BUILD_AFTER_RESTART_MS = 10 * 60_000;
const NO_ACTION = "Gramps took no action.";
const INFERRED = "Inferred from RCON reads.";

export const initialHealthState = (): HealthState => ({
  lastGood: null,
  outage: null,
  pending: null,
  build: null,
  lastRestartAt: null,
  lastRestartAlertAt: null,
  watch: null,
});

/** A build label safe to compare and show: no control characters, trimmed, at most 64 characters. */
export function cleanBuild(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const text = [...value]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 64);
  return text || null;
}

function downText(kind: HealthFailureKind, minutes: number, since: string) {
  switch (kind) {
    case "rejected":
      return {
        title: `RCON credentials rejected for ${minutes} min`,
        line: `RCON rejected Gramps' credentials since ${since}.`,
      };
    case "unreadable":
      return {
        title: `Game answers unreadable for ${minutes} min`,
        line: `RCON gave an unreadable answer since ${since}.`,
      };
    case "error":
      return { title: `Game reads failing for ${minutes} min`, line: `RCON returned errors since ${since}.` };
    default:
      return { title: `Game unreachable for ${minutes} min`, line: `Could not reach RCON since ${since}.` };
  }
}

/**
 * One RCON read. A failed read that is not `paused` starts or extends an outage: `game-down` after
 * at least two failures spanning the configured minutes, then `game-back` after two good reads.
 * The first good read after a read gap or an outage is compared with the last good read for a
 * likely restart. A single failed read inside the normal read gap is a hitch: only a new build
 * counts at once, and an emptied roster is held like a fast crash. Anything a map load could also
 * explain is held until the roster stays near empty past RESTART_HOLD_MS. The first good read
 * after boot only sets the baseline.
 */
export function observeHealth(previous: HealthState, reading: HealthReading, now: number, options: HealthOptions) {
  const alerts: HealthAlert[] = [];
  const state: HealthState = { ...previous, outage: previous.outage ? { ...previous.outage } : null };
  const zone = options.timeZone;
  if (!reading.ok) {
    if (reading.kind === "paused") return { state: previous, alerts, restartLike: false };
    const outage: HealthOutage = state.outage ?? {
      since: now,
      failures: 0,
      kind: reading.kind,
      downSent: false,
      successes: 0,
      firstSuccessAt: null,
    };
    outage.failures++;
    outage.kind = reading.kind;
    outage.successes = 0;
    outage.firstSuccessAt = null;
    state.outage = outage;
    const elapsed = now - outage.since;
    if (!outage.downSent && outage.failures >= 2 && elapsed >= options.downMinutes * 60_000) {
      outage.downSent = true;
      const minutes = Math.floor(elapsed / 60_000);
      const text = downText(outage.kind, minutes, formatLocal(outage.since, zone));
      alerts.push({
        kind: "game-down",
        severity: "high",
        key: `down:${outage.since}`,
        title: text.title,
        lines: [text.line, INFERRED, NO_ACTION],
        facts: { since: new Date(outage.since).toISOString(), failures: outage.failures, kind: outage.kind },
      });
    }
    return { state, alerts, restartLike: false };
  }

  const build = cleanBuild(reading.build);
  const current: GoodRead = {
    at: now,
    map: reading.map,
    players: reading.players,
    matchSeconds: reading.matchSeconds,
    build,
  };
  const last = state.lastGood;
  const outage = state.outage;
  const gap = !!last && now - last.at > ROUND_GAP_MS;
  const firstAfterOutage = !!outage && outage.successes === 0;
  let restartLike = false;
  if (last && (firstAfterOutage || (!outage && gap))) {
    const place: string[] = [];
    if (!sameMap(last.map, current.map)) place.push(`map ${mapLabel(last.map)} to ${mapLabel(current.map)}`);
    const rolledBack =
      last.matchSeconds !== null && current.matchSeconds !== null && current.matchSeconds < last.matchSeconds - 30;
    if (rolledBack || reading.roundChanged) place.push(rolledBack ? "match clock reset" : "new round");
    const emptied = last.players >= 5 && current.players <= 1 ? `players ${last.players} to ${current.players}` : null;
    const rebuilt = last.build && build && last.build !== build ? `build ${last.build} to ${build}` : null;
    const signals = [...place, ...(emptied ? [emptied] : []), ...(rebuilt ? [rebuilt] : [])];
    const restartAt = outage ? outage.since : last.at;
    const lost = outage
      ? `connection lost ${formatDuration(now - outage.since)}`
      : `no reads for ${formatDuration(now - last.at)}`;
    // One failed read inside the normal read gap can be a hitch during map travel. A new map, clock
    // or round then proves nothing, and an empty roster may be the next map loading. The gap is
    // measured on each side of the failed read, so its timeout and the slower retry do not count.
    const hitch =
      !!outage && outage.failures < 2 && outage.since - last.at <= ROUND_GAP_MS && now - outage.since <= ROUND_GAP_MS;
    if (!hitch || rebuilt) {
      if (signals.length) {
        restartLike = true;
        alerts.push(...restartAlert(state, restartAt, last.players, [...signals, lost], now, options));
      }
    } else if (emptied) state.pending ??= { at: restartAt, playersBefore: last.players, signals: [...signals, lost] };
  } else if (last && !outage && last.players >= 10 && current.players === 0 && reading.roundChanged) {
    // A fast crash can return before a read fails: a full server empties at a round boundary. An
    // ordinary map load looks the same at first, so wait to see whether the players come back.
    state.pending ??= {
      at: now,
      playersBefore: last.players,
      signals: [`players ${last.players} to 0`, "new round", "no failed read"],
    };
  }
  const pending = state.pending;
  if (restartLike) state.pending = null;
  else if (pending) {
    if (current.players > 1) state.pending = null;
    else if (now - pending.at > RESTART_HOLD_MS) {
      state.pending = null;
      restartLike = true;
      const held = `still empty ${formatDuration(now - pending.at)} later`;
      alerts.push(...restartAlert(state, pending.at, pending.playersBefore, [...pending.signals, held], now, options));
    }
  }

  if (outage) {
    outage.successes++;
    outage.firstSuccessAt ??= now;
    if (outage.successes >= 2) {
      if (outage.downSent) {
        const back = outage.firstSuccessAt;
        alerts.push({
          kind: "game-back",
          severity: "info",
          key: `back:${outage.since}`,
          title: "Game reachable again",
          lines: [
            `RCON answered again at ${formatLocal(back, zone)} after ${formatDuration(back - outage.since)} (failing since ${formatLocal(outage.since, zone)}).`,
            INFERRED,
            NO_ACTION,
          ],
          facts: {
            since: new Date(outage.since).toISOString(),
            back: new Date(back).toISOString(),
            minutes: Math.floor((back - outage.since) / 60_000),
          },
        });
        state.watch = { at: back, kind: "back" };
      }
      state.outage = null;
    }
  }

  if (build) {
    if (state.build !== null && state.build !== build) {
      const afterRestart =
        restartLike || (state.lastRestartAt !== null && now - state.lastRestartAt <= BUILD_AFTER_RESTART_MS);
      alerts.push({
        kind: "game-build",
        severity: "info",
        key: `build:${build}`,
        title: "Game build changed",
        lines: [
          `Build ${state.build} to ${build}${afterRestart ? ", after a restart (likely game update)" : ""}.`,
          "Reported by the game's RCON capabilities. " + INFERRED,
          NO_ACTION,
        ],
        facts: { from: state.build, to: build },
      });
    }
    state.build = build;
  }
  state.lastGood = current;
  return { state, alerts, restartLike };
}

function restartAlert(
  state: HealthState,
  restartAt: number,
  playersBefore: number,
  signals: string[],
  now: number,
  options: HealthOptions,
): HealthAlert[] {
  state.lastRestartAt = restartAt;
  state.watch = { at: restartAt, kind: "restart" };
  if (state.lastRestartAlertAt !== null && now - state.lastRestartAlertAt < RESTART_ALERT_MS) return [];
  state.lastRestartAlertAt = now;
  const scheduled = scheduledMatch(restartAt, options.scheduledRestarts, options.timeZone) !== null;
  const withPlayers = playersBefore >= options.restartPlayers;
  const text = signals.join(", ");
  return [
    {
      kind: "game-restart",
      severity: withPlayers ? "warning" : "info",
      key: `restart:${Math.floor(restartAt / RESTART_ALERT_MS)}`,
      title: withPlayers ? "Likely restart with players on" : "Likely restart",
      lines: [
        `${text.charAt(0).toUpperCase()}${text.slice(1)} (${scheduled ? "scheduled" : "unscheduled"}).`,
        `Around ${formatLocal(restartAt, options.timeZone)}. Gramps cannot see uptime or a boot ID; this is inferred from RCON reads.`,
        NO_ACTION,
      ],
      facts: {
        at: new Date(restartAt).toISOString(),
        playersBefore,
        scheduled: scheduled ? "yes" : "no",
      },
      ...(scheduled && !withPlayers ? { suppressed: "scheduled restart, recorded only" } : {}),
    },
  ];
}
