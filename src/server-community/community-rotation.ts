/** Returns a number in [0, 1), like `Math.random`. Injected so tests can be deterministic. */
export type RandomSource = () => number;

/** Players whose last welcome variant is remembered per pool; the oldest entry is forgotten first. */
export const MAX_REMEMBERED_PLAYERS = 2048;

/** Welcome variants for players on the server's whitelist are a separate pool with their own history. */
export type WelcomePool = "standard" | "whitelisted";

type WelcomeHistory = { byPlayer: Map<string, number>; last: number | null };

/**
 * In-memory, per-server choice of welcome variants and round messages.
 * It only avoids immediate repeats; it is not persisted and resets on restart.
 */
export class CommunityRotation {
  private readonly welcomes: Record<WelcomePool, WelcomeHistory> = {
    standard: { byPlayer: new Map(), last: null },
    whitelisted: { byPlayer: new Map(), last: null },
  };
  private lastRound: number | null = null;

  constructor(
    private readonly random: RandomSource = Math.random,
    private readonly maxPlayers = MAX_REMEMBERED_PLAYERS,
  ) {}

  /**
   * Chooses a welcome variant index from one pool for a joining player. With two or more variants it never
   * repeats the variant this player was last given from that pool; with three or more it also avoids the
   * pool's previous choice for anyone. Each pool keeps its own history.
   */
  welcome(steamId: string, count: number, pool: WelcomePool = "standard"): number {
    const history = this.welcomes[pool];
    const avoid = new Set<number>();
    const previous = history.byPlayer.get(steamId);
    if (count >= 2 && previous !== undefined) avoid.add(previous);
    if (count >= 3 && history.last !== null) avoid.add(history.last);
    const index = this.choose(count, avoid);
    history.last = index;
    history.byPlayer.delete(steamId);
    history.byPlayer.set(steamId, index);
    while (history.byPlayer.size > this.maxPlayers) {
      const oldest = history.byPlayer.keys().next().value;
      if (oldest === undefined) break;
      history.byPlayer.delete(oldest);
    }
    return index;
  }

  /** Chooses a round message index, never the previous round's when two or more are configured. */
  round(count: number): number {
    const index = this.choose(count, count >= 2 && this.lastRound !== null ? new Set([this.lastRound]) : new Set());
    this.lastRound = index;
    return index;
  }

  private choose(count: number, avoid: Set<number>): number {
    const all = Array.from({ length: Math.max(1, count) }, (_, index) => index);
    const allowed = all.filter((index) => !avoid.has(index));
    const candidates = allowed.length ? allowed : all;
    if (candidates.length === 1) return candidates[0];
    const value = this.random();
    const position = Number.isFinite(value) ? Math.floor(value * candidates.length) : 0;
    return candidates[Math.min(candidates.length - 1, Math.max(0, position))];
  }
}
