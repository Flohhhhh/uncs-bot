import type { WardogsClient } from "../admin/wardogs.client";
import { mapLabel } from "../common/map-labels";
import { changedRound } from "../common/round-tracker";

export type CommunitySnapshot = Awaited<ReturnType<WardogsClient["overview"]>>;
type Status = CommunitySnapshot["status"];
export const LEAVE_GRACE_MS = 60_000;
export const BASELINE_GAP_MS = 30_000;
export const ROUND_HOLD_MS = 180_000;
export const MAX_ROSTER = 512;

export interface CommunityState {
  lastAt: number | null;
  status: Status | null;
  present: Map<string, number>;
  roundAt: number | null;
  pendingRoundAt: number | null;
}

export const initialCommunityState = (): CommunityState => ({
  lastAt: null,
  status: null,
  present: new Map(),
  roundAt: null,
  pendingRoundAt: null,
});

/** Observations imply joins/round transitions; neither is a game-emitted event. */
export function observeCommunity(previous: CommunityState, snapshot: CommunitySnapshot, now: number) {
  const ids = [...new Set(snapshot.players.map((player) => player.steamId))].slice(0, MAX_ROSTER);
  const baseline = previous.lastAt === null || now <= previous.lastAt || now - previous.lastAt > BASELINE_GAP_MS;
  if (baseline) {
    return {
      state: {
        ...initialCommunityState(),
        lastAt: now,
        status: snapshot.status,
        present: new Map(ids.map((id) => [id, now])),
      },
      joined: [] as string[],
      round: false,
      baseline: true,
    };
  }
  const inTransition = previous.roundAt !== null && now - previous.roundAt <= ROUND_HOLD_MS;
  const transitionNow = changedRound(previous.status!, snapshot.status);
  const present = new Map([...previous.present].filter(([, seen]) => inTransition || now - seen < LEAVE_GRACE_MS));
  // A long map load is not a new set of joins. Baseline the first populated
  // roster and preserve known players through the bounded transition window.
  const returningRoster = inTransition && (previous.pendingRoundAt !== null || previous.status!.players.current === 0);
  const joined =
    returningRoster || transitionNow || snapshot.status.players.current <= 0
      ? []
      : ids.filter((id) => !present.has(id));
  for (const id of ids) present.set(id, now);
  // Prefer current players when the bounded grace roster fills up.
  const current = new Set(ids);
  for (const id of present.keys()) {
    if (present.size <= MAX_ROSTER) break;
    if (!current.has(id)) present.delete(id);
  }
  let roundAt = previous.roundAt;
  let pendingRoundAt = previous.pendingRoundAt;
  if (pendingRoundAt !== null && now - pendingRoundAt > ROUND_HOLD_MS) pendingRoundAt = null;
  const recentPlayers = previous.status!.players.current > 0 || present.size > 0;
  if (recentPlayers && transitionNow && (roundAt === null || now - roundAt >= LEAVE_GRACE_MS)) {
    roundAt = now;
    pendingRoundAt = now;
  }
  // A score reset followed by map travel is one transition, not two messages.
  const round = pendingRoundAt !== null && snapshot.status.players.current > 0 && ids.length > 0;
  if (round) pendingRoundAt = null;
  return {
    state: { lastAt: now, status: snapshot.status, present, roundAt, pendingRoundAt },
    joined,
    round,
    baseline: false,
  };
}

/** Game-controlled labels must not introduce mentions, links, formatting or extra lines. */
export function plainLabel(value: string, max = 60) {
  return (
    value
      .replace(/[^\p{L}\p{N} ,'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max) || "Unknown"
  );
}

export function statusCard(snapshot: CommunitySnapshot | null, online: boolean) {
  const lines = ["**The UNCs · Server status**"];
  if (!online) lines.push("Game connection unavailable. Last observed values may be stale.");
  if (snapshot) {
    const status = snapshot.status;
    lines.push(
      `Server: ${plainLabel(status.serverName)}`,
      `Map: ${plainLabel(mapLabel(status.map))}`,
      `Players: ${status.players.current} / ${status.players.max}`,
    );
    for (const faction of status.factionScores.slice(0, 8))
      if (Number.isFinite(faction.score)) lines.push(`${plainLabel(faction.name, 32)}: ${faction.score}`);
    if (Number.isFinite(status.matchSeconds) && status.matchSeconds! >= 0)
      lines.push(`Reported round time: ${Math.floor(status.matchSeconds! / 60)} minutes`);
    const observed = Date.parse(snapshot.observedAt);
    if (Number.isFinite(observed)) lines.push(`Last observed: <t:${Math.floor(observed / 1000)}:R>`);
  } else lines.push("No successful observation this run.");
  return {
    content: lines.join("\n"),
    embeds: [],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
  };
}
