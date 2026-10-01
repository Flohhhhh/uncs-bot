import { randomUUID } from "node:crypto";
import { assignedFaction } from "../common/faction-colors";
import { plainLabel } from "../server-community/community-state";
import type { AdminAction } from "../admin/admin.types";
import {
  initialEventProgress,
  observedRound,
  sameRound,
  type EventOperation,
  type EventProgress,
  type EventRecord,
  type EventSnapshot,
  type EventState,
} from "./server-events.types";

export type EventPlan = {
  state: EventState;
  progress: EventProgress;
  message: string;
  operation: EventOperation | null;
};
export function eventRoster(event: Pick<EventRecord, "options">, snapshot: EventSnapshot) {
  const factions = snapshot.status.factionScores;
  if (
    factions.length !== 3 ||
    new Set(factions.map((team) => team.name)).size !== 3 ||
    !event.options.teams.every((name) => factions.some((team) => team.name === name))
  )
    throw new Error("The selected teams no longer match three distinct current factions. Staff review is required.");
  if (
    (snapshot.unlinkedPlayerCount ?? 0) > 0 ||
    new Set(snapshot.players.map((player) => player.steamId)).size !== snapshot.players.length
  )
    throw new Error("The roster contains unlinked or duplicate identities. No automatic team changes can be planned.");
  if (snapshot.status.players.max > 100 || snapshot.players.length > 100)
    throw new Error("50v50 needs a configured capacity of at most 100 players.");
  const players = snapshot.players.map((player) => ({ ...player, team: assignedFaction(player.faction, factions) }));
  if (players.some((player) => player.faction && !player.team))
    throw new Error("A player's current team cannot be identified safely. Staff review is required.");
  const counts = event.options.teams.map((team) => players.filter((player) => player.team === team).length);
  return { players, counts, excluded: factions.find((team) => !event.options.teams.includes(team.name))!.name };
}

export function operation(
  event: EventRecord,
  kind: EventOperation["kind"],
  input: Record<string, unknown>,
  extra: Partial<EventOperation> = {},
): EventOperation {
  const id = randomUUID();
  return { id, kind, action: { ...input, id, reason: `50v50 event ${event.id}: ${kind}` } as AdminAction, ...extra };
}

/** Pure roster planning: no network, mutation, Discord membership or cash-based purchase inference. */
export function planEvent(event: EventRecord, snapshot: EventSnapshot, now: number): EventPlan {
  let progress = structuredClone(event.progress);
  const stay = (message: string, state = event.state, op: EventOperation | null = null): EventPlan => ({
    state,
    progress,
    message,
    operation: op,
  });
  const round = observedRound(snapshot);
  if (!round || now - Date.parse(snapshot.observedAt) > 15_000 || Date.parse(snapshot.observedAt) > now + 5_000)
    return stay("Waiting for a fresh round clock. No team changes were planned.");
  let roster: ReturnType<typeof eventRoster>;
  try {
    roster = eventRoster(event, snapshot);
  } catch (error) {
    return stay((error as Error).message, "needs_review");
  }
  if (snapshot.status.players.current !== snapshot.players.length)
    return stay("Waiting for matching population and roster observations. No team changes were planned.");
  if (progress.lastObservedAt && now - progress.lastObservedAt > 30_000) {
    progress = initialEventProgress(round, now);
    return stay(
      "Observation was interrupted. Waiting for the next round before resuming team changes.",
      "waiting_round",
    );
  }
  progress.lastObservedAt = now;
  // Forget warning eligibility after disconnect; do not repeat a move in the same round.
  const connected = new Set(roster.players.map((player) => player.steamId));
  progress.warned = Object.fromEntries(Object.entries(progress.warned).filter(([id]) => connected.has(id)));
  if (event.state === "waiting_round" && sameRound(round, progress.round))
    return stay("50v50 is armed for the next observed round.");
  if (!sameRound(round, progress.round) || event.state === "waiting_round") {
    progress = initialEventProgress(round, now);
    const teams = event.options.teams.map((name) => plainLabel(name, 30)).join(" vs ");
    const respawn = event.options.forceRespawn
      ? "Moves include a respawn; gear may be lost."
      : "Team changes may need your next respawn.";
    return stay(
      "Sending the round's team warning.",
      "warming",
      operation(
        event,
        "round_warning",
        {
          action: "broadcast",
          message: `50v50: ${teams}. Wait before buying while teams are sorted. ${respawn}`,
        },
        { round, recipients: roster.players.map((player) => player.steamId) },
      ),
    );
  }
  if (progress.roundWarningAt === null || now - progress.roundWarningAt < event.options.warningSeconds * 1000)
    return stay("Giving players time to read the team warning.", "warming");
  if (roster.players.some((player) => player.team === null))
    return stay("Waiting for connecting players to receive a team before planning another move.");
  if (progress.pendingRespawn) {
    const pending = progress.pendingRespawn;
    const player = roster.players.find((player) => player.steamId === pending.steamId);
    if (event.options.forceRespawn && player?.team === pending.faction)
      return stay(
        "Applying the staff-selected respawn after a confirmed assignment.",
        "active",
        operation(
          event,
          "respawn",
          {
            action: "kill",
            steamId: pending.steamId,
            confirm: pending.steamId,
            expectedFaction: pending.faction,
            expectedRound: progress.round,
          },
          { ...pending, round: progress.round },
        ),
      );
    progress.pendingRespawn = null;
    return stay("Skipped a respawn because the player left or their team changed.", "active");
  }
  const [a, b] = roster.counts;
  const targetIndex = a <= b ? 0 : 1;
  const target = event.options.teams[targetIndex];
  const excluded = roster.players.filter((player) => player.team === roster.excluded);
  const early = snapshot.status.matchSeconds! <= event.options.balanceWindowSeconds;
  const imbalance = Math.abs(a - b) > 1;
  const larger = event.options.teams[targetIndex === 0 ? 1 : 0];
  const candidates = excluded.length
    ? excluded
    : early && imbalance
      ? roster.players.filter((player) => player.team === larger)
      : [];
  if (candidates.length && roster.counts[targetIndex] >= 50)
    return stay(
      "Both event teams are at capacity. Staff review is required; nobody was kicked or moved.",
      "needs_review",
    );
  const eligible = candidates
    .filter((player) => !progress.moved.includes(player.steamId))
    .sort((left, right) => left.steamId.localeCompare(right.steamId));
  if (excluded.length && !eligible.length)
    return stay(
      "A player returned to the excluded team after a move. Staff review is required; no repeated move was sent.",
      "needs_review",
    );
  if (eligible.length) {
    // Rotate the first eligible identity each round; never use score, cash or display names as move authority.
    const index = Math.abs(Math.floor(progress.round.startedAt / 1000)) % eligible.length;
    const player = eligible[index];
    if (progress.warned[player.steamId] === undefined) {
      return stay(
        "Warning a player before their team assignment.",
        "active",
        operation(
          event,
          "player_warning",
          {
            action: "message",
            steamId: player.steamId,
            message: `50v50 event: your team may change. Please wait before buying. ${event.options.forceRespawn ? "A move includes a respawn and may cost gear." : "Your next respawn may be needed after a move."}`,
          },
          { steamId: player.steamId, faction: target, round: progress.round },
        ),
      );
    }
    if (now - progress.warned[player.steamId] < event.options.warningSeconds * 1000)
      return stay("Waiting after the player's team warning.", "active");
    return stay(
      "Moving one warned player to balance the event teams.",
      "active",
      operation(
        event,
        "move",
        {
          action: "team",
          steamId: player.steamId,
          confirm: player.steamId,
          faction: target,
          expectedFaction: player.team,
          expectedRound: progress.round,
          maximumTargetPlayers: 50,
        },
        { steamId: player.steamId, faction: target, round: progress.round },
      ),
    );
  }
  if (
    !progress.readyAnnounced &&
    roster.players.length > 0 &&
    roster.players.every((player) => player.team) &&
    !excluded.length &&
    !imbalance
  ) {
    return stay(
      "Announcing that initial team assignment is complete.",
      "active",
      operation(
        event,
        "ready",
        {
          action: "broadcast",
          message:
            "50v50 teams are assigned. Check your team before buying; a normal respawn may still be needed. New arrivals should follow their team notice.",
        },
        { round: progress.round },
      ),
    );
  }
  return stay(
    early
      ? "Watching team balance and arrivals."
      : "Early-round balancing has ended. Watching arrivals on the excluded team.",
    "active",
  );
}

export function completeEventOperation(event: EventRecord, op: EventOperation, now: number) {
  const progress = structuredClone(event.progress);
  if (op.kind === "round_warning") {
    progress.round = op.round!;
    progress.roundWarningAt = now;
    progress.warned = Object.fromEntries((op.recipients ?? []).map((id) => [id, now]));
  }
  if (op.kind === "player_warning") progress.warned[op.steamId!] = now;
  if (op.kind === "move") {
    progress.moved.push(op.steamId!);
    if (event.options.forceRespawn) progress.pendingRespawn = { steamId: op.steamId!, faction: op.faction! };
  }
  if (op.kind === "respawn") progress.pendingRespawn = null;
  if (op.kind === "ready") progress.readyAnnounced = true;
  return progress;
}
