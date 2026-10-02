import { Injectable } from "@nestjs/common";
import { GameServers } from "./game-servers";
import type { Overview } from "./wardogs.client";
import type { SettingsSnapshot } from "../common/server-settings";
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
    // Repeated or out-of-order reads of a shared overview do not decide anything twice.
    if (state && (state.observedAt === overview.observedAt || at < state.update.track.last.at))
      return { connection, state: { ...state.update, boundary: false, reason: null }, threshold, repeated: true };
    const update = trackRound(
      state?.update.track ?? null,
      roundObservation(overview.status, at, threshold),
      options.seed,
    );
    return { connection, state: update, threshold, repeated: false };
  }

  /** Feeds one status read. Idempotent per `observedAt`; `seed` applies only when empty or after a gap. */
  observe(
    serverId: string,
    overview: Pick<Overview, "status" | "observedAt">,
    options: { fields?: SettingsSnapshot["fields"]; seed?: RoundSeed | null } = {},
  ): RoundObserved {
    const result = this.compute(serverId, overview, options);
    if (!result.repeated)
      this.states.set(serverId, {
        connection: result.connection,
        observedAt: overview.observedAt,
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
