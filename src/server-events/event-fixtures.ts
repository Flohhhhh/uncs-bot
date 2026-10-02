// Isolated test fixtures: fictitious roster and endpoint; never contact a game server.
import { createHash, randomUUID } from "node:crypto";
import { roundObservation, trackRound, type RoundTrack } from "../common/round-tracker";
import { initialEventProgress, trackedStamp, type EventRecord, type EventSnapshot } from "./server-events.types";
export const eventNow = Date.parse("2026-10-01T10:00:00Z");
export const eventStaff = { id: "123456789012345678", name: "Test admin", role: "admin" as const, csrf: "test" };
const factions = (scores: [number, number, number]) => [
  { name: "Valkyra", colorHex: "#D86060", score: scores[0] },
  { name: "Lonestar", colorHex: "#5B95D8", score: scores[1] },
  { name: "Manticore", colorHex: "#7BC462", score: scores[2] },
];
/** A live round with the match clock at `seconds` (none when null), scores on the board. */
export function snapshotAt(
  now = eventNow,
  seconds: number | null = 120,
  teams: Array<string | null> = ["RED", "BLU", "GRN"],
  scores: [number, number, number] = [10, 6, 4],
): EventSnapshot {
  return {
    observedAt: new Date(now).toISOString(),
    capabilities: {
      routes: [
        "PATCH /v1/players/{id}",
        "POST /v1/players/{id}/kill",
        "POST /v1/players/{id}/message",
        "POST /v1/broadcast",
        "PUT /v1/config",
      ],
      limits: { maxRequestsPerMinutePerIp: 120 },
    },
    status: {
      serverName: "Test UNCs",
      map: "Kavkazi",
      ...(seconds === null ? {} : { matchSeconds: seconds }),
      rotation: { nowIndex: 0, nextIndex: 1 },
      players: { current: teams.length, max: 100 },
      factionScores: factions(scores),
    },
    players: teams.map((faction, index) => ({
      steamId: String(76561198123456789n + BigInt(index)),
      name: "Same name",
      faction,
    })),
  };
}
/** The same live round without a match clock, as the live build reported on 2 October 2026. */
export function clocklessSnapshotAt(
  now = eventNow,
  teams?: Array<string | null>,
  scores?: [number, number, number],
): EventSnapshot {
  return snapshotAt(now, null, teams, scores);
}
/** The exact 2 October 2026 pre-round sample: 1/100 players waiting for 20, scores 0/0/0, no clock. */
export function preRoundSnapshot(now = eventNow): EventSnapshot {
  const snapshot = clocklessSnapshotAt(now, ["RED"], [0, 0, 0]);
  snapshot.status = {
    ...snapshot.status,
    lighting: "DayClear",
    experiences: ["KOTH"],
    alternator: "ZoneAlternator.Bakurani.Farmland.Circle",
    scoreTick: { current: 24, min: 18, max: 30 },
    rotation: { nowIndex: 0, nextIndex: 1 },
    players: { current: 1, max: 100 },
  };
  return snapshot;
}
/** A full server: 100 players split 34/33/33 across Valkyra, Lonestar and Manticore, no clock. */
export function fullServerSnapshot(now = eventNow, scores: [number, number, number] = [10, 6, 4]): EventSnapshot {
  const teams = [
    ...Array<string>(34).fill("Valkyra"),
    ...Array<string>(33).fill("Lonestar"),
    ...Array<string>(33).fill("Manticore"),
  ];
  return clocklessSnapshotAt(now, teams, scores);
}
/** Folds status reads through the round tracker, as the shared GameRounds does. */
export function trackOf(snapshots: EventSnapshot[], threshold = 20, start: RoundTrack | null = null): RoundTrack {
  let track = start;
  for (const snapshot of snapshots)
    track = trackRound(track, roundObservation(snapshot.status, Date.parse(snapshot.observedAt), threshold)).track;
  return track!;
}
export function eventFixture(): EventRecord {
  const track = trackOf([snapshotAt()]);
  const progress = {
    ...initialEventProgress(trackedStamp(track), eventNow),
    roundId: track.round.id,
    roundsStarted: 1,
    tracker: track,
  };
  progress.roundWarningAt = eventNow - 60_000;
  progress.warned = Object.fromEntries(snapshotAt().players.map((p) => [p.steamId, eventNow - 60_000]));
  return {
    id: randomUUID(),
    serverId: "primary",
    serverName: "Test UNCs",
    connectionHash: createHash("sha256").update("https://game.example.test").digest("hex"),
    guildId: "234567890123456789",
    actorId: eventStaff.id,
    actorName: eventStaff.name,
    reason: "Optional community event",
    requestHash: "hash",
    options: {
      teams: ["Valkyra", "Lonestar"],
      durationMinutes: 60,
      warningSeconds: 30,
      balanceWindowSeconds: 300,
      forceRespawn: false,
    },
    originalLock: true,
    initialRevision: "r1",
    restoreRevision: "r2",
    state: "active",
    progress,
    operation: null,
    version: 1,
    message: "Watching teams",
    lastActionId: null,
    stop: null,
    createdAt: new Date(eventNow),
    updatedAt: new Date(eventNow),
    endsAt: new Date(eventNow + 3600_000),
  };
}
/** A 50v50 a ballot started: one round, ends by itself, smallest team closed, no single-player messages. */
export function voteEventFixture(): EventRecord {
  const event = eventFixture();
  const voteId = event.id;
  return {
    ...event,
    actorName: `Gramps community vote (${eventStaff.name})`,
    reason: `Community vote ${voteId}: 50v50 next round (12 of 20 votes)`,
    options: {
      ...event.options,
      durationMinutes: 75,
      rounds: 1,
      autoEnd: true,
      closedFaction: null,
      playerMessages: false,
      source: { kind: "vote", voteId, label: "Zestafona" },
    },
    restoreRevision: null,
    progress: { ...event.progress, lockDisabledAt: eventNow - 600_000 },
  };
}
