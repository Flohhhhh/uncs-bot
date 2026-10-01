import { z } from "zod";
import type { AdminAction } from "../admin/admin.types";
import type { WardogsClient } from "../admin/wardogs.client";
import { roundStamp, type RoundStamp } from "../common/game-round";
import { gameServerId } from "../common/game-server";
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
export type EventOptions = Pick<
  z.infer<typeof startEventSchema>,
  "teams" | "durationMinutes" | "warningSeconds" | "balanceWindowSeconds" | "forceRespawn"
>;
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
};
export type EventOperation = {
  id: string;
  kind: "disable_lock" | "restore_lock" | "round_warning" | "player_warning" | "move" | "respawn" | "ready" | "armed";
  action: AdminAction;
  round?: RoundStamp;
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
    lockChanged: event.restoreRevision !== null,
    lastActionId: event.lastActionId,
    operation: event.operation ? { id: event.operation.id, kind: event.operation.kind } : null,
    movedThisRound: event.progress.moved.length,
    stop: event.stop,
    createdAt: event.createdAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
  };
}
