import { randomUUID } from "node:crypto";
import { assignedFaction } from "../common/faction-colors";
import { roundElapsed, roundSettled, type RoundTrack } from "../common/round-tracker";
import { plainLabel } from "../server-community/community-state";
import type { AdminAction } from "../admin/admin.types";
import {
  initialEventProgress,
  isVoteEvent,
  trackedStamp,
  type EventOperation,
  type EventProgress,
  type EventRecord,
  type EventSnapshot,
  type EventState,
} from "./server-events.types";

/** A moved player still on the closed team this long after the move stops a vote-started event. */
export const MOVE_GRACE_MS = 120_000;
/** An unsafe roster this long stops a vote-started event (it never waits with the lock off). */
export const ROSTER_GRACE_MS = 120_000;
/** Pre-round waiting this long after the last round counts as that round having ended. */
export const END_WAIT_MS = 60_000;
/** Pre-round waiting this long stops a vote-started event. */
export const POPULATION_WAIT_MS = 300_000;
/** Consecutive unconfirmed retried results before a vote-started event stops. */
export const RETRY_LIMIT = 3;
const FRESH_MS = 15_000;

export type EventStopReason = "rounds" | "roster" | "population";
export type EventPlan = {
  state: EventState;
  progress: EventProgress;
  message: string;
  operation: EventOperation | null;
  /** Vote-started events end by themselves; the restore path then runs. */
  stop?: EventStopReason;
  /** Vote-started events stop instead of waiting for staff review with the team lock off. */
  halt?: string;
};
type EventTeams = Pick<EventRecord, "options"> & { progress?: Pick<EventProgress, "teams"> };

/** This round's two kept teams. Vote-started events resolve theirs when sorting starts. */
export function eventTeams(event: EventTeams): [string, string] | null {
  return event.progress?.teams ?? (isVoteEvent(event) ? null : event.options.teams);
}
export function eventRoster(event: EventTeams, snapshot: EventSnapshot) {
  const factions = snapshot.status.factionScores;
  const teams = eventTeams(event);
  if (
    factions.length !== 3 ||
    new Set(factions.map((team) => team.name)).size !== 3 ||
    (teams && !teams.every((name) => factions.some((team) => team.name === name)))
  )
    throw new Error("The selected teams no longer match three distinct current factions.");
  if (
    (snapshot.unlinkedPlayerCount ?? 0) > 0 ||
    new Set(snapshot.players.map((player) => player.steamId)).size !== snapshot.players.length
  )
    throw new Error("The roster contains unlinked or duplicate identities.");
  if (snapshot.status.players.max > 100 || snapshot.players.length > 100)
    throw new Error("50v50 needs a configured capacity of at most 100 players.");
  const players = snapshot.players.map((player) => ({ ...player, team: assignedFaction(player.faction, factions) }));
  if (players.some((player) => player.faction && !player.team))
    throw new Error("A player's current team cannot be identified safely.");
  return {
    players,
    factions: factions.map((team) => team.name),
    teams,
    counts: teams ? teams.map((team) => players.filter((player) => player.team === team).length) : null,
    excluded: teams ? factions.find((team) => !teams.includes(team.name))!.name : null,
  };
}
/**
 * The two teams kept in a vote-started round: the rivals of the named closed faction, or of the faction
 * with the fewest assigned players (the fewest moves; ties by name). Null when the named faction is absent.
 */
export function voteTeams(
  closedFaction: string | null | undefined,
  factions: string[],
  players: { team: string | null }[],
): [string, string] | null {
  const count = (name: string) => players.filter((player) => player.team === name).length;
  const closed = closedFaction
    ? factions.includes(closedFaction)
      ? closedFaction
      : null
    : [...factions].sort((a, b) => count(a) - count(b) || (a < b ? -1 : a > b ? 1 : 0))[0];
  if (!closed) return null;
  const kept = factions.filter((name) => name !== closed);
  return [kept[0], kept[1]];
}

export function operation(
  event: EventRecord,
  kind: EventOperation["kind"],
  input: Record<string, unknown>,
  extra: Partial<EventOperation> = {},
): EventOperation {
  const id = randomUUID();
  return {
    id,
    kind,
    action: { ...input, id, serverId: event.serverId, reason: `50v50 event ${event.id}: ${kind}` } as AdminAction,
    ...extra,
  };
}
/** Per-round state starts over; round identity, counts and lock bookkeeping carry over. */
export function nextRoundProgress(progress: EventProgress, track: RoundTrack, now: number): EventProgress {
  const carried = {
    roundId: progress.roundId,
    roundsStarted: progress.roundsStarted,
    tracker: track,
    lockDisabledAt: progress.lockDisabledAt,
    disableAttempts: progress.disableAttempts,
    failures: progress.failures,
  };
  return {
    ...initialEventProgress(trackedStamp(track), now),
    ...Object.fromEntries(Object.entries(carried).filter(([, value]) => value !== undefined)),
  };
}
function hasClock(snapshot: EventSnapshot) {
  const seconds = snapshot.status.matchSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
}

/**
 * Pure roster planning: no network, mutation, Discord membership or cash-based purchase inference.
 * Rounds come from the shared tracker, which uses the match clock when the game reports it and
 * observable signals (map, rotation entry, score resets) when it does not.
 */
export function planEvent(event: EventRecord, snapshot: EventSnapshot, now: number, track: RoundTrack | null) {
  let progress: EventProgress = structuredClone(event.progress);
  const vote = isVoteEvent(event);
  const options = event.options;
  const stay = (
    message: string,
    state = event.state,
    op: EventOperation | null = null,
    extra: Pick<EventPlan, "stop" | "halt"> = {},
  ): EventPlan => ({ state, progress, message, operation: op, ...extra });
  const observedAt = Date.parse(snapshot.observedAt);
  if (!track || !Number.isFinite(observedAt) || now - observedAt > FRESH_MS || observedAt > now + 5_000)
    return stay("Waiting for a fresh round observation. No team changes were planned.");
  progress.tracker = track;
  // Events recorded before round tracking adopt the running round as their current one.
  progress.roundId ??= track.round.id;
  const finished =
    vote &&
    options.autoEnd !== false &&
    (progress.roundsStarted ?? 0) >= (options.rounds ?? 1) &&
    event.state !== "waiting_round";
  const current = track.round.id === progress.roundId;
  if (track.phase === "waiting") {
    progress.waitingSince ??= now;
    if (finished && (!current || now - progress.waitingSince >= END_WAIT_MS))
      return stay("The last 50v50 round ended.", event.state, null, { stop: "rounds" });
    if (vote && now - progress.waitingSince >= POPULATION_WAIT_MS)
      return stay("The server waited for players for five minutes.", event.state, null, { stop: "population" });
    return stay("Waiting for players before the round starts. No team changes were planned.");
  }
  delete progress.waitingSince;
  if (track.phase !== "live") return stay("Waiting for valid match scores. No team changes were planned.");
  if (finished && (!current || track.ended))
    return stay("The last 50v50 round ended.", event.state, null, { stop: "rounds" });
  let roster: ReturnType<typeof eventRoster>;
  try {
    roster = eventRoster({ options, progress }, snapshot);
  } catch (error) {
    const message = (error as Error).message;
    if (!vote)
      return stay(`${message} No automatic team changes can be planned; staff review is required.`, "needs_review");
    progress.rosterIssueSince ??= now;
    if (now - progress.rosterIssueSince >= ROSTER_GRACE_MS)
      return stay(message, event.state, null, {
        halt: `${message} The 50v50 stopped and normal teams are being restored.`,
      });
    return stay(`${message} Rechecking before the 50v50 stops.`);
  }
  delete progress.rosterIssueSince;
  if (snapshot.status.players.current !== snapshot.players.length)
    return stay("Waiting for matching population and roster observations. No team changes were planned.");
  progress.lastObservedAt = now;
  // Forget warning eligibility after disconnect; do not repeat a move in the same round.
  const connected = new Set(roster.players.map((player) => player.steamId));
  progress.warned = Object.fromEntries(Object.entries(progress.warned).filter(([id]) => connected.has(id)));
  if (!current) {
    if (!roundSettled(track, now))
      return stay("A new round started. Waiting for it to settle before the team warning.");
    progress = nextRoundProgress(progress, track, now);
    const respawn = options.forceRespawn
      ? "Moves include a respawn; gear may be lost."
      : "Team changes may need your next respawn.";
    const message = vote
      ? `50v50 round: wait before buying while teams are sorted. ${
          options.closedFaction ? `${plainLabel(options.closedFaction, 30)} players` : "The smallest team's players"
        } will be moved. ${respawn}`
      : `50v50: ${options.teams.map((name) => plainLabel(name, 30)).join(" vs ")}. Wait before buying while teams are sorted. ${respawn}`;
    return stay(
      "Sending the round's team warning.",
      "warming",
      operation(
        event,
        "round_warning",
        { action: "broadcast", message },
        {
          round: trackedStamp(track),
          roundId: track.round.id,
          recipients: roster.players.map((player) => player.steamId),
        },
      ),
    );
  }
  if (event.state === "waiting_round") return stay("50v50 is armed for the next observed round.");
  // Without single-player messages, the round warning covers everyone: arrivals count from first sight.
  if (options.playerMessages === false) for (const player of roster.players) progress.warned[player.steamId] ??= now;
  if (progress.roundWarningAt === null || now - progress.roundWarningAt < options.warningSeconds * 1000)
    return stay("Giving players time to read the team warning.", "warming");
  if (roster.players.some((player) => player.team === null))
    return stay("Waiting for connecting players to receive a team before planning another move.");
  if (!roster.teams) {
    const teams = voteTeams(options.closedFaction, roster.factions, roster.players);
    if (!teams)
      return stay(
        `${plainLabel(options.closedFaction ?? "The closed team", 30)} is not playing this round.`,
        event.state,
        null,
        { stop: "roster" },
      );
    progress.teams = teams;
    roster = eventRoster({ options, progress }, snapshot);
  }
  const teams = roster.teams!;
  const counts = roster.counts!;
  const roundRef = { round: { ...progress.round }, roundId: progress.roundId };
  // The adapter compares an expected round only with a reported clock; observed rounds rely on the
  // same-round check made just before each action.
  const expectedRound = track.round.source === "clock" && hasClock(snapshot) ? trackedStamp(track) : undefined;
  if (progress.pendingRespawn) {
    const pending = progress.pendingRespawn;
    const player = roster.players.find((player) => player.steamId === pending.steamId);
    if (options.forceRespawn && player?.team === pending.faction)
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
            ...(expectedRound ? { expectedRound } : {}),
          },
          { ...pending, ...roundRef },
        ),
      );
    progress.pendingRespawn = null;
    return stay("Skipped a respawn because the player left or their team changed.", "active");
  }
  const [a, b] = counts;
  const targetIndex = a <= b ? 0 : 1;
  const target = teams[targetIndex];
  const excluded = roster.players.filter((player) => player.team === roster.excluded);
  const elapsed = roundElapsed(track, now);
  // Balance the kept teams only early in a round whose start is known exactly.
  const early = elapsed !== null && elapsed <= options.balanceWindowSeconds;
  const imbalance = Math.abs(a - b) > 1;
  const larger = teams[targetIndex === 0 ? 1 : 0];
  if (vote) {
    const stuck = excluded.find(
      (player) =>
        progress.movedAt?.[player.steamId] !== undefined && now - progress.movedAt[player.steamId] >= MOVE_GRACE_MS,
    );
    if (stuck)
      return stay("A moved player is still on the closed team.", event.state, null, {
        halt: "A moved player was still on the closed team two minutes later. The 50v50 stopped and normal teams are being restored.",
      });
  }
  const candidates = excluded.length
    ? excluded
    : early && imbalance
      ? roster.players.filter((player) => player.team === larger)
      : [];
  if (candidates.length && counts[targetIndex] >= 50)
    return vote
      ? stay("Both 50v50 teams are full.", event.state, null, {
          halt: "Both 50v50 teams are full, so nobody else could be moved. The 50v50 stopped and normal teams are being restored.",
        })
      : stay("Both event teams are at capacity. Staff review is required; nobody was kicked or moved.", "needs_review");
  const eligible = candidates
    .filter((player) => !progress.moved.includes(player.steamId))
    .sort((left, right) => left.steamId.localeCompare(right.steamId));
  if (excluded.length && !eligible.length)
    return vote
      ? stay("Waiting for moved players to appear on their new team.", "active")
      : stay(
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
            message: `50v50 event: your team may change. Please wait before buying. ${options.forceRespawn ? "A move includes a respawn and may cost gear." : "Your next respawn may be needed after a move."}`,
          },
          { steamId: player.steamId, faction: target, ...roundRef },
        ),
      );
    }
    if (now - progress.warned[player.steamId] < options.warningSeconds * 1000)
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
          ...(expectedRound ? { expectedRound } : {}),
          maximumTargetPlayers: 50,
        },
        { steamId: player.steamId, faction: target, ...roundRef },
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
        roundRef,
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

/** Progress after a confirmed operation. A vote-started event's unconfirmed ("pending") move counts as moved. */
export function completeEventOperation(event: EventRecord, op: EventOperation, now: number, confirmed = true) {
  const progress = structuredClone(event.progress);
  if (op.kind === "round_warning") {
    progress.round = op.round!;
    if (op.roundId) progress.roundId = op.roundId;
    progress.roundsStarted = (progress.roundsStarted ?? 0) + 1;
    progress.roundWarningAt = now;
    progress.warned = Object.fromEntries((op.recipients ?? []).map((id) => [id, now]));
  }
  if (op.kind === "player_warning") progress.warned[op.steamId!] = now;
  if (op.kind === "move") {
    progress.moved.push(op.steamId!);
    if (isVoteEvent(event)) progress.movedAt = { ...progress.movedAt, [op.steamId!]: now };
    if (event.options.forceRespawn && confirmed)
      progress.pendingRespawn = { steamId: op.steamId!, faction: op.faction! };
  }
  if (op.kind === "respawn") progress.pendingRespawn = null;
  if (op.kind === "ready") progress.readyAnnounced = true;
  if (op.kind === "disable_lock") progress.lockDisabledAt = now;
  if (op.kind === "ended") progress.endedAt = now;
  delete progress.failures;
  return progress;
}
