import { z } from "zod";
import type { AdminAction } from "../admin/admin.types";
import type { WardogsClient } from "../admin/wardogs.client";
import { roundStamp, type RoundStamp } from "../common/game-round";
import { gameServerId } from "../common/game-server";
import type { RoundTrack } from "../common/round-tracker";
export { sameRound, type RoundStamp } from "../common/game-round";
const reason = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32));
const revision = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n"]+$/);
const faction = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[\w./-]+$/);
export const startEventSchema = z
  .object({
    id: z.uuid(),
    serverId: gameServerId,
    reason,
    revision,
    teams: z.tuple([faction, faction]).refine(([a, b]) => a !== b),
    durationMinutes: z.number().int().min(15).max(240),
    warningSeconds: z.number().int().min(15).max(120),
    balanceWindowSeconds: z.number().int().min(60).max(600),
    forceRespawn: z.boolean(),
    confirm: z.literal("START 50V50"),
  })
  .strict();
export const stopEventSchema = z.object({ id: z.uuid(), reason }).strict();
export const restoreEventSchema = z
  .object({ id: z.uuid(), reason, revision, confirm: z.literal("RESTORE TEAM LOCK") })
  .strict();
/** A 50v50 started by a community ballot. The event ID is the winning ballot's ID. */
export type EventSource = {
  kind: "vote";
  voteId: string;
  /** The rotation entry that plays as 50v50. */ label?: string;
};
export type EventOptions = Pick<
  z.infer<typeof startEventSchema>,
  "teams" | "durationMinutes" | "warningSeconds" | "balanceWindowSeconds" | "forceRespawn"
> & {
  // Vote-started events only; staff-started events omit them and run until stopped.
  /** Rounds the 50v50 lasts, counted by confirmed round warnings. */
  rounds?: number;
  /** End by itself after the last round and restore the team lock. */
  autoEnd?: boolean;
  /** The faction emptied each round, or null for the smallest team when sorting starts. */
  closedFaction?: string | null;
  /** False when the game cannot message one player: arrivals count as warned when first seen. */
  playerMessages?: boolean;
  source?: EventSource;
};
export type EventState =
  | "preparing"
  | "waiting_round"
  | "warming"
  | "active"
  | "stopping"
  | "complete"
  | "needs_review";
export type EventProgress = {
  round: RoundStamp;
  lastObservedAt: number;
  warned: Record<string, number>;
  moved: string[];
  readyAnnounced: boolean;
  roundWarningAt: number | null;
  pendingRespawn: { steamId: string; faction: string } | null;
  // Rows written before round tracking omit the fields below.
  /** The tracked round the event last warned (or, before its first warning, the round it was armed in). */
  roundId?: string;
  /** Confirmed round warnings: the 50v50 rounds started so far. */
  roundsStarted?: number;
  /** The shared round tracker's state, kept so a restarted process continues the same round. */
  tracker?: RoundTrack;
  /** Vote-started events: this round's two kept teams, resolved when sorting starts. */
  teams?: [string, string];
  /** Vote-started events: when each player's move was accepted, including unconfirmed ("pending") moves. */
  movedAt?: Record<string, number>;
  rosterIssueSince?: number;
  /** When Gramps confirmed the team lock off for this event. */
  lockDisabledAt?: number;
  lockIssueSince?: number;
  disableAttempts?: number;
  restoreAttempts?: { count: number; lastAt: number };
  /** Consecutive retried results that were not confirmed (vote-started events). */
  failures?: number;
  waitingSince?: number;
  endedAt?: number;
};
export type EventOperation = {
  id: string;
  kind:
    | "disable_lock"
    | "restore_lock"
    | "round_warning"
    | "player_warning"
    | "move"
    | "respawn"
    | "ready"
    | "armed"
    | "ended";
  action: AdminAction;
  round?: RoundStamp;
  /** The tracked round this action belongs to; it is dropped if the round changes first. */
  roundId?: string;
  recipients?: string[];
  steamId?: string;
  faction?: string;
};
export type EventStop = { id: string; actorId: string; actorName: string; reason: string; at: string };
export type EventRecord = {
  id: string;
  serverId: string;
  serverName: string;
  connectionHash: string;
  guildId: string;
  actorId: string;
  actorName: string;
  reason: string;
  requestHash: string;
  options: EventOptions;
  originalLock: boolean;
  initialRevision: string;
  restoreRevision: string | null;
  state: EventState;
  progress: EventProgress;
  operation: EventOperation | null;
  version: number;
  message: string;
  lastActionId: string | null;
  stop: EventStop | null;
  createdAt: Date;
  endsAt: Date;
  updatedAt: Date;
};
export type EventSnapshot = Awaited<ReturnType<WardogsClient["overview"]>>;
export function observedRound(snapshot: EventSnapshot): RoundStamp | null {
  return roundStamp(snapshot.status, Date.parse(snapshot.observedAt));
}
export function isVoteEvent(event: Pick<EventRecord, "options">) {
  return event.options.source?.kind === "vote";
}
export function trackedStamp(track: RoundTrack): RoundStamp {
  return { map: track.round.map, startedAt: track.round.startedAt };
}
export function initialEventProgress(round: RoundStamp, now: number): EventProgress {
  return {
    round,
    lastObservedAt: now,
    warned: {},
    moved: [],
    readyAnnounced: false,
    roundWarningAt: null,
    pendingRespawn: null,
  };
}
/** Progress for a new event armed in the tracked round: nothing happens until the next round. */
export function trackedEventProgress(track: RoundTrack, now: number): EventProgress {
  return {
    ...initialEventProgress(trackedStamp(track), now),
    roundId: track.round.id,
    roundsStarted: 0,
    tracker: track,
  };
}
export type EventEndReason = "staff" | "rounds" | "halted" | "roster" | "population" | "lock_changed" | "expiry";
export const systemStops = {
  rounds: { actorId: "system:event-rounds", actorName: "Gramps 50v50 rounds" },
  halted: { actorId: "system:event-halt", actorName: "Gramps 50v50 safety stop" },
  roster: { actorId: "system:event-roster", actorName: "Gramps 50v50 roster check" },
  population: { actorId: "system:event-population", actorName: "Gramps 50v50 population check" },
  lock_changed: { actorId: "system:lock-changed", actorName: "Gramps team-lock check" },
  expiry: { actorId: "system:event-expiry", actorName: "Gramps event deadline" },
} as const satisfies Record<Exclude<EventEndReason, "staff">, { actorId: string; actorName: string }>;
export function endReason(stop: EventStop | null): EventEndReason | null {
  if (!stop) return null;
  const found = Object.entries(systemStops).find(([, value]) => value.actorId === stop.actorId);
  return found ? (found[0] as EventEndReason) : "staff";
}
export function eventView(event: EventRecord) {
  return {
    id: event.id,
    serverId: event.serverId,
    serverName: event.serverName,
    actorName: event.actorName,
    reason: event.reason,
    options: event.options,
    state: event.state,
    message: event.message,
    version: event.version,
    originalLock: event.originalLock,
    lockChanged: event.restoreRevision !== null || !!event.progress.lockDisabledAt,
    lastActionId: event.lastActionId,
    operation: event.operation ? { id: event.operation.id, kind: event.operation.kind } : null,
    movedThisRound: event.progress.moved.length,
    stop: event.stop,
    createdAt: event.createdAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    // Optional detail; older dashboards read only the fields above.
    ...(event.options.source ? { source: event.options.source } : {}),
    ...(event.options.rounds
      ? { rounds: { planned: event.options.rounds, started: event.progress.roundsStarted ?? 0 } }
      : {}),
    ...(event.options.closedFaction !== undefined ? { closedFaction: event.options.closedFaction } : {}),
    ...(event.stop ? { endReason: endReason(event.stop) } : {}),
  };
}
