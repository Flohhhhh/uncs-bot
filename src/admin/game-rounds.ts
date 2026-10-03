import { Injectable } from "@nestjs/common";
import { GameServers } from "./game-servers";
import type { Overview } from "./wardogs.client";
import type { SettingsSnapshot } from "../common/server-settings";
import { sameMap } from "../common/map-labels";
import {
  roundObservation,
  trackRound,
  type RoundSeed,
  type RoundTrack,
  type RoundUpdate,
} from "../common/round-tracker";

/** Observed live on 2 October 2026 ("Players to start a match"); used when the setting cannot be read. */
export const DEFAULT_START_THRESHOLD = 20;
const THRESHOLD_CACHE_MS = 300_000;
const CLOCK_JITTER_MS = 30_000;
const SCORE_DROP = 10;

/**
 * Whether a round first seen already running (after a restart or gap) is the stored `seed` round:
 * the same map and rotation entry, no score reset since, and compatible start times.
 */
export function adoptableSeed(track: RoundTrack, seed: RoundSeed) {
  const round = track.round;
  if (!track.unseeded || seed.round.id === round.id || !sameMap(seed.round.map, round.map)) return false;
  if (seed.round.index !== null && round.index !== null && seed.round.index !== round.index) return false;
  if (track.highest < seed.highest - SCORE_DROP) return false;
  if (round.source === "clock")
    return seed.round.source === "clock"
      ? Math.abs(seed.round.startedAt - round.startedAt) <= CLOCK_JITTER_MS
      : seed.round.startedAt >= round.startedAt - CLOCK_JITTER_MS;
  // A round without a clock is dated from when it was first seen; the stored round began earlier.
  return seed.round.startedAt <= round.startedAt + CLOCK_JITTER_MS;
}
function adopt(track: RoundTrack, seed: RoundSeed): RoundTrack {
  const { unseeded: _unseeded, ...rest } = track;
  const clock = track.round.source === "clock";
  return {
    ...rest,
    round: {
      ...seed.round,
      map: track.round.map,
      index: track.round.index ?? seed.round.index,
      ...(clock ? { startedAt: track.round.startedAt, source: "clock" as const, exact: true } : { exact: false }),
    },
    highest: Math.max(track.highest, seed.highest),
  };
}

export type RoundObserved = RoundUpdate & { threshold: number };

/**
 * One in-memory round tracker per server, shared by the voting and event workers so a boundary
 * one of them sees is not lost to the other. Rebuilt from stored seeds after a restart; run one
 * Gramps worker process.
 */
@Injectable()
export class GameRounds {
  private readonly states = new Map<string, { connection: string; observedAt: string; update: RoundUpdate }>();
  private readonly thresholds = new Map<string, { until: number; value: number }>();
  constructor(private readonly servers: GameServers) {}

  /** The game's "Players to start a match", cached for five minutes; 20 when it cannot be read. */
  threshold(serverId: string, fields?: SettingsSnapshot["fields"]) {
    const value = fields?.find((field) => field.id === "minRequiredPlayers")?.value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1000) {
      this.thresholds.set(serverId, { until: Date.now() + THRESHOLD_CACHE_MS, value });
      return value;
    }
    const cached = this.thresholds.get(serverId);
    return cached && cached.until > Date.now() ? cached.value : DEFAULT_START_THRESHOLD;
  }

  private compute(
    serverId: string,
    overview: Pick<Overview, "status" | "observedAt">,
    options: { fields?: SettingsSnapshot["fields"]; seed?: RoundSeed | null },
  ) {
    const connection = this.servers.connectionHash(serverId);
    let state = this.states.get(serverId);
    if (state && state.connection !== connection) {
      this.states.delete(serverId);
      state = undefined;
    }
    const threshold = this.threshold(serverId, options.fields);
    const at = Date.parse(overview.observedAt);
    if (!Number.isFinite(at)) throw new Error("The observation time is unreadable.");
    let previous = state?.update.track ?? null;
    // A process that restarted may first see a round without the stored work that names it. The
    // other worker's matching stored round (an open ballot or a running event) is adopted, so both
    // workers keep the same round identity.
    const adopted = !!previous && !!options.seed && adoptableSeed(previous, options.seed);
    if (adopted) previous = adopt(previous!, options.seed!);
    // Repeated or out-of-order reads of a shared overview do not decide anything twice.
    if (state && (state.observedAt === overview.observedAt || at < state.update.track.last.at))
      return {
        connection,
        state: { track: previous!, boundary: false, reason: null },
        threshold,
        store: adopted,
        observedAt: state.observedAt,
      };
    const update = trackRound(previous, roundObservation(overview.status, at, threshold), options.seed);
    return { connection, state: update, threshold, store: true, observedAt: overview.observedAt };
  }

  /** Feeds one status read. Idempotent per `observedAt`; `seed` applies only when empty or after a gap. */
  observe(
    serverId: string,
    overview: Pick<Overview, "status" | "observedAt">,
    options: { fields?: SettingsSnapshot["fields"]; seed?: RoundSeed | null } = {},
  ): RoundObserved {
    const result = this.compute(serverId, overview, options);
    if (result.store)
      this.states.set(serverId, {
        connection: result.connection,
        observedAt: result.observedAt,
        update: result.state,
      });
    return { ...result.state, threshold: result.threshold };
  }
  /** What `observe` would return, without recording it (dashboard previews). */
  peek(
    serverId: string,
    overview: Pick<Overview, "status" | "observedAt">,
    options: { fields?: SettingsSnapshot["fields"]; seed?: RoundSeed | null } = {},
  ): RoundObserved {
    const result = this.compute(serverId, overview, options);
    return { ...result.state, threshold: result.threshold };
  }
  current(serverId: string): RoundTrack | null {
    return this.states.get(serverId)?.update.track ?? null;
  }
  clear(serverId: string) {
    this.states.delete(serverId);
  }
}
