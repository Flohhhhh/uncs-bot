import { actionSchema } from "../admin/admin.types";
import type { RoundTrack } from "../common/round-tracker";
import {
  END_WAIT_MS,
  MOVE_GRACE_MS,
  POPULATION_WAIT_MS,
  ROSTER_GRACE_MS,
  completeEventOperation,
  planEvent,
  voteTeams,
} from "./event-planner";
import {
  clocklessSnapshotAt,
  eventFixture,
  eventNow,
  fullServerSnapshot,
  preRoundSnapshot,
  snapshotAt,
  trackOf,
  voteEventFixture,
} from "./event-fixtures";
import { startEventSchema, type EventRecord, type EventSnapshot } from "./server-events.types";

/** Plans from the event's stored tracker plus the given reads, as the shared GameRounds would. */
function plan(event: EventRecord, snapshots: EventSnapshot | EventSnapshot[], threshold = 20) {
  const reads = Array.isArray(snapshots) ? snapshots : [snapshots];
  const last = reads.at(-1)!;
  const track = trackOf(reads, threshold, event.progress.tracker ?? null);
  return planEvent(event, last, Date.parse(last.observedAt), track);
}
/**
 * The clock restarts with the scores reset 15 seconds after the fixture's read: a new round, read again
 * `after` ms later once someone has scored.
 */
function clockRestart(after = 35_000, teams?: Array<string | null>) {
  return [
    snapshotAt(eventNow + 15_000, 0, teams, [0, 0, 0]),
    snapshotAt(eventNow + 15_000 + after, after / 1000, teams, [1, 0, 0]),
  ];
}
/** Without a clock: a full score reset 15 seconds after the fixture's read, read again `after` ms later. */
function scoreReset(after = 35_000, teams: Array<string | null> = ["RED", "BLU", "GRN"]) {
  return [
    clocklessSnapshotAt(eventNow + 15_000, teams, [0, 0, 0]),
    clocklessSnapshotAt(eventNow + 15_000 + after, teams, [1, 0, 0]),
  ];
}
describe("optional game-roster 50v50 planning", () => {
  it("waits for the next round to settle, including a restart on the same map", () => {
    const event = eventFixture();
    event.state = "waiting_round";
    expect(plan(event, snapshotAt()).operation).toBeNull();
    expect(plan(event, [snapshotAt(eventNow + 15_000, 0)]).operation).toBeNull();
    const next = plan(event, clockRestart());
    expect(next.operation?.kind).toBe("round_warning");
    expect(next.operation?.recipients).toHaveLength(3);
    expect(next.operation?.roundId).not.toBe(event.progress.roundId);
    expect(next.progress.moved).toEqual([]);
    expect(next.progress.warned).toEqual({});
    expect(next.progress.roundsStarted).toBe(1);
  });
  it("starts the warning clock when the message actually finishes", () => {
    const event = eventFixture();
    event.state = "waiting_round";
    const warning = plan(event, clockRestart());
    event.progress = warning.progress;
    event.progress = completeEventOperation(event, warning.operation!, eventNow + 50_000);
    event.state = "warming";
    expect(event.progress.roundsStarted).toBe(2);
    expect(event.progress.roundId).toBe(warning.operation!.roundId);
    expect(plan(event, snapshotAt(eventNow + 75_000, 60)).operation).toBeNull();
    expect(plan(event, snapshotAt(eventNow + 80_000, 65)).operation?.kind).toBe("move");
  });
  it("moves an excluded player to the smaller team with round, current-team and capacity checks", () => {
    const event = eventFixture();
    const planned = plan(event, snapshotAt());
    expect(planned.operation?.action).toMatchObject({
      action: "team",
      steamId: snapshotAt().players[2].steamId,
      faction: "Valkyra",
      expectedFaction: "Manticore",
      maximumTargetPlayers: 50,
      expectedRound: { map: "Kavkazi", startedAt: eventNow - 120_000 },
    });
    expect(planned.operation?.roundId).toBe(event.progress.roundId);
    expect(actionSchema.safeParse(planned.operation?.action).success).toBe(true);
  });
  it("plans a clockless round normally, without an expected-round check the game could not verify", () => {
    const event = eventFixture();
    event.progress.tracker = trackOf([clocklessSnapshotAt()]);
    event.progress.roundId = event.progress.tracker.round.id;
    const planned = plan(event, clocklessSnapshotAt(eventNow + 5_000));
    expect(planned.operation?.kind).toBe("move");
    expect(planned.operation?.action).not.toHaveProperty("expectedRound");
    expect(actionSchema.safeParse(planned.operation?.action).success).toBe(true);
  });
  it("warns a clockless round after a settled score reset", () => {
    const event = eventFixture();
    event.state = "active";
    event.progress.tracker = trackOf([clocklessSnapshotAt()], 0);
    event.progress.roundId = event.progress.tracker.round.id;
    expect(plan(event, scoreReset(10_000), 0).operation).toBeNull();
    const warned = plan(event, scoreReset(), 0);
    expect(warned.operation?.kind).toBe("round_warning");
    expect(warned.operation?.round).toEqual({ map: "Kavkazi", startedAt: eventNow + 15_000 });
  });
  it("waits for the first points of a round whose clock restarted on the old final scores", () => {
    const event = eventFixture();
    const held = [snapshotAt(eventNow + 15_000, 0), snapshotAt(eventNow + 60_000, 45)];
    expect(plan(event, held).operation).toBeNull();
    const played = [...held, snapshotAt(eventNow + 65_000, 50, undefined, [0, 0, 0])];
    expect(plan(event, [...played, snapshotAt(eventNow + 90_000, 75, undefined, [1, 0, 0])]).operation).toBeNull();
    const warned = plan(event, [...played, snapshotAt(eventNow + 100_000, 85, undefined, [1, 0, 0])]);
    expect(warned.operation?.kind).toBe("round_warning");
  });
  it("does not start the next round's sorting in a round first seen already finished", () => {
    const event = eventFixture();
    // After a read gap, the next map is first seen at 100 points.
    const finished = [
      clocklessSnapshotAt(eventNow + 120_000, undefined, [100, 40, 20]),
      clocklessSnapshotAt(eventNow + 180_000, undefined, [100, 40, 20]),
    ];
    for (const read of finished) read.status.map = "Europe";
    expect(plan(event, finished).operation).toBeNull();
  });
  it.each([
    ["the pre-round wait", [preRoundSnapshot(eventNow + 5_000)]],
    ["unreadable scores", [{ ...snapshotAt(eventNow + 5_000), status: { ...snapshotAt().status, factionScores: [] } }]],
  ] as Array<[string, EventSnapshot[]]>)("plans nothing during %s", (_, reads) => {
    const event = eventFixture();
    expect(plan(event, reads)).toMatchObject({ operation: null, state: "active" });
  });
  it("waits for unassigned arrivals rather than repeatedly claiming moves the adapter must reject", () => {
    expect(plan(eventFixture(), snapshotAt(eventNow, 120, ["RED", "GRN", null])).operation).toBeNull();
  });
  it("warns a new arrival before assigning them and uses the actual send time", () => {
    const event = eventFixture();
    event.progress.warned = {};
    const planned = plan(event, snapshotAt());
    expect(planned.operation?.kind).toBe("player_warning");
    event.progress = completeEventOperation(event, planned.operation!, eventNow + 3000);
    expect(plan(event, snapshotAt(eventNow + 30_000, 150)).operation).toBeNull();
  });
  it("counts a late arrival as warned on first sight when the game cannot message one player", () => {
    const event = voteEventFixture();
    event.progress.teams = ["Valkyra", "Lonestar"];
    event.progress.warned = {};
    const first = plan(event, snapshotAt());
    expect(first.operation).toBeNull();
    expect(Object.values(first.progress.warned)).toEqual([eventNow, eventNow, eventNow]);
    event.progress = first.progress;
    expect(plan(event, snapshotAt(eventNow + 30_000, 150)).operation?.kind).toBe("move");
  });
  it("forgets disconnected players' warnings without allowing a second move in the same round", () => {
    const event = eventFixture(),
      removed = snapshotAt().players[2].steamId;
    event.progress.moved = [removed];
    const planned = plan(event, snapshotAt(eventNow, 120, ["RED", "BLU"]));
    expect(planned.progress.warned[removed]).toBeUndefined();
    expect(planned.progress.moved).toEqual([removed]);
    expect(plan(event, snapshotAt()).state).toBe("needs_review");
  });
  it("balances uneven active teams early in an exactly known round, then stops mid-round shuffling", () => {
    const event = eventFixture();
    expect(plan(event, snapshotAt(eventNow, 120, ["RED", "RED", "RED"])).operation?.kind).toBe("move");
    const late = eventFixture();
    late.progress.tracker = trackOf([snapshotAt(eventNow, 900)]);
    late.progress.roundId = late.progress.tracker.round.id;
    expect(plan(late, snapshotAt(eventNow, 900, ["RED", "RED", "RED"])).operation).toBeNull();
    expect(plan(late, snapshotAt(eventNow, 900)).operation?.kind).toBe("move");
  });
  it("moves only closed-team players in a round whose start was not observed", () => {
    const event = eventFixture();
    // A first read without a clock: the round was already running when Gramps saw it.
    event.progress.tracker = trackOf([clocklessSnapshotAt()]);
    event.progress.roundId = event.progress.tracker.round.id;
    expect(event.progress.tracker.round.exact).toBe(false);
    expect(plan(event, clocklessSnapshotAt(eventNow + 5_000, ["RED", "RED", "RED"])).operation).toBeNull();
    expect(plan(event, clocklessSnapshotAt(eventNow + 5_000)).operation?.kind).toBe("move");
  });
  it("does not move already-balanced teams and announces readiness once", () => {
    const event = eventFixture(),
      snapshot = snapshotAt(eventNow, 120, ["RED", "BLU"]);
    const planned = plan(event, snapshot);
    expect(planned.operation?.kind).toBe("ready");
    event.progress = completeEventOperation(event, planned.operation!, eventNow);
    expect(plan(event, snapshot).operation).toBeNull();
  });
  it.each([[[]], [[null]], [["RED", "BLU", null]]] as Array<[Array<string | null>]>)(
    "does not announce assignment complete for empty/unassigned rosters (%j)",
    (teams) => {
      expect(plan(eventFixture(), snapshotAt(eventNow, 120, teams)).operation).toBeNull();
    },
  );
  it.each(["stale", "future", "population", "untracked"])("waits on an unusable %s observation", (kind) => {
    const snapshot = snapshotAt();
    if (kind === "stale") snapshot.observedAt = new Date(eventNow - 16_000).toISOString();
    if (kind === "future") snapshot.observedAt = new Date(eventNow + 6_000).toISOString();
    if (kind === "population") snapshot.status.players.current += 1;
    const track = kind === "untracked" ? null : trackOf([snapshotAt()]);
    expect(planEvent(eventFixture(), snapshot, eventNow, track).operation).toBeNull();
  });
  it.each(["unlinked", "duplicate", "unknown", "factions", "capacity"])(
    "requires staff review for %s roster risk",
    (kind) => {
      const snapshot = snapshotAt();
      if (kind === "unlinked") snapshot.unlinkedPlayerCount = 1;
      if (kind === "duplicate") snapshot.players[1].steamId = snapshot.players[0].steamId;
      if (kind === "unknown") snapshot.players[1].faction = "Blue-ish";
      if (kind === "factions") snapshot.status.factionScores.pop();
      if (kind === "capacity") snapshot.status.players.max = 101;
      expect(plan(eventFixture(), snapshot)).toMatchObject({ state: "needs_review", operation: null });
    },
  );
  it("adopts the running round for an event recorded before round tracking", () => {
    const event = eventFixture();
    delete event.progress.roundId;
    delete event.progress.tracker;
    event.state = "waiting_round";
    const planned = plan(event, snapshotAt());
    expect(planned.operation).toBeNull();
    expect(planned.progress.roundId).toBe(trackOf([snapshotAt()]).round.id);
  });
  it("keeps respawns opt-in and only plans one after a confirmed move", () => {
    const event = eventFixture(),
      planned = plan(event, snapshotAt());
    expect(completeEventOperation(event, planned.operation!, eventNow).pendingRespawn).toBeNull();
    event.options.forceRespawn = true;
    event.progress = completeEventOperation(event, planned.operation!, eventNow);
    const next = plan(event, snapshotAt(eventNow, 120, ["RED", "BLU", "RED"]));
    expect(next.operation?.action).toMatchObject({
      action: "kill",
      expectedFaction: "Valkyra",
      expectedRound: event.progress.round,
    });
    expect(actionSchema.safeParse(next.operation?.action).success).toBe(true);
    expect(completeEventOperation(event, next.operation!, eventNow).pendingRespawn).toBeNull();
    // An unconfirmed ("pending") move never schedules a forced respawn.
    const pending = { ...event, progress: { ...event.progress, pendingRespawn: null } };
    expect(completeEventOperation(pending, planned.operation!, eventNow, false).pendingRespawn).toBeNull();
  });
  it("drops a pending respawn if the player left, changed teams, or a new round began", () => {
    const event = eventFixture();
    event.options.forceRespawn = true;
    event.progress.pendingRespawn = { steamId: snapshotAt().players[2].steamId, faction: "Valkyra" };
    expect(plan(event, snapshotAt()).progress.pendingRespawn).toBeNull();
    const next = plan(event, clockRestart());
    expect(next.operation?.kind).toBe("round_warning");
    expect(next.progress.pendingRespawn).toBeNull();
  });
  it("keeps generated warnings within the game message limit", () => {
    const event = eventFixture();
    event.options.forceRespawn = true;
    event.options.teams = ["a".repeat(150), "b".repeat(150)];
    const reads = clockRestart();
    for (const read of [...reads, snapshotAt()]) {
      read.status.factionScores[0].name = event.options.teams[0];
      read.status.factionScores[1].name = event.options.teams[1];
    }
    event.progress.tracker = trackOf([snapshotAt()]);
    const planned = plan(event, reads);
    expect(planned.operation?.kind).toBe("round_warning");
    expect(actionSchema.safeParse(planned.operation?.action).success).toBe(true);
  });
  it("requires an explicit start confirmation and distinct teams", () => {
    const event = eventFixture(),
      input = {
        id: event.id,
        serverId: "primary",
        revision: "r1",
        reason: event.reason,
        ...event.options,
        confirm: "START 50V50",
      };
    expect(startEventSchema.safeParse(input).success).toBe(true);
    for (const change of [
      { confirm: "yes" },
      { teams: ["Valkyra", "Valkyra"] },
      { durationMinutes: 0 },
      { warningSeconds: 1 },
      { forceRespawn: "false" },
      { serverId: "../other" },
      { rounds: 1 },
    ])
      expect(startEventSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});

describe("a 50v50 started by a community vote", () => {
  /** A vote event armed in the fixture round and now waiting for the next one. */
  function armed() {
    const event = voteEventFixture();
    event.state = "waiting_round";
    event.progress.roundsStarted = 0;
    return event;
  }
  it("warns at the next settled round, naming the smallest team, without a clock", () => {
    const event = armed();
    event.progress.tracker = trackOf([clocklessSnapshotAt()], 0);
    event.progress.roundId = event.progress.tracker.round.id;
    const planned = plan(event, scoreReset(), 0);
    expect(planned.operation?.kind).toBe("round_warning");
    expect(planned.operation?.action).toMatchObject({
      message:
        "50v50 round: wait before buying while teams are sorted. The smallest team's players will be moved. Team changes may need your next respawn.",
    });
    expect(actionSchema.safeParse(planned.operation?.action).success).toBe(true);
  });
  it("does not lose a round boundary that happened while it was being prepared", () => {
    // Armed in the fixture round; the tracker already shows the next round when it reaches waiting_round.
    const event = armed();
    const next = trackOf(clockRestart(), 20, event.progress.tracker!);
    const planned = planEvent(event, snapshotAt(eventNow + 50_000, 35), eventNow + 50_000, next);
    expect(planned.operation?.kind).toBe("round_warning");
  });
  it("closes the smallest team when sorting starts, and a missing named team stops the event", () => {
    expect(voteTeams(null, ["Valkyra", "Lonestar", "Manticore"], [{ team: "Valkyra" }, { team: "Lonestar" }])).toEqual([
      "Valkyra",
      "Lonestar",
    ]);
    // Equal teams: the first by name closes.
    expect(voteTeams(null, ["Valkyra", "Lonestar", "Manticore"], [])).toEqual(["Valkyra", "Manticore"]);
    expect(voteTeams("Lonestar", ["Valkyra", "Lonestar", "Manticore"], [])).toEqual(["Valkyra", "Manticore"]);
    expect(voteTeams("Raiders", ["Valkyra", "Lonestar", "Manticore"], [])).toBeNull();
    const event = voteEventFixture();
    event.options.closedFaction = "Raiders";
    expect(plan(event, snapshotAt())).toMatchObject({ stop: "roster", operation: null });
    const smallest = voteEventFixture();
    const planned = plan(smallest, snapshotAt(eventNow, 120, ["RED", "RED", "BLU"]));
    expect(planned.progress.teams).toEqual(["Valkyra", "Lonestar"]);
    // Manticore has nobody, so nobody needs moving; the kept teams are balanced early.
    expect(planned.operation?.kind).toBe("ready");
  });
  it("ends after its last round: at 100 points, at the next boundary, or after a minute of waiting", () => {
    const atCap = voteEventFixture();
    expect(plan(atCap, snapshotAt(eventNow + 5_000, 125, undefined, [100, 40, 20]))).toMatchObject({ stop: "rounds" });
    const boundary = voteEventFixture();
    expect(plan(boundary, clockRestart(10_000))).toMatchObject({ stop: "rounds" });
    // The round had just begun (no points) when the server emptied: a minute of waiting ends it.
    const waiting = voteEventFixture();
    const crowd = Array<string>(25).fill("RED");
    waiting.progress.tracker = trackOf([clocklessSnapshotAt(eventNow, crowd, [0, 0, 0])]);
    waiting.progress.roundId = waiting.progress.tracker.round.id;
    const first = plan(waiting, preRoundSnapshot(eventNow + 5_000));
    expect(first).toMatchObject({ operation: null });
    expect(first.stop).toBeUndefined();
    waiting.progress = first.progress;
    expect(plan(waiting, preRoundSnapshot(eventNow + 5_000 + END_WAIT_MS))).toMatchObject({ stop: "rounds" });
    // A score reset into the pre-round wait is itself the boundary.
    expect(plan(voteEventFixture(), preRoundSnapshot(eventNow + 5_000))).toMatchObject({ stop: "rounds" });
    // More rounds were voted: the next boundary starts the second 50v50 round instead.
    const twice = voteEventFixture();
    twice.options.rounds = 2;
    const second = plan(twice, clockRestart());
    expect(second.operation?.kind).toBe("round_warning");
    twice.progress = completeEventOperation(twice, second.operation!, eventNow + 50_000);
    expect(twice.progress.roundsStarted).toBe(2);
    // Staff-started events and events that do not end by themselves never stop this way.
    const manual = eventFixture();
    expect(plan(manual, clockRestart()).operation?.kind).toBe("round_warning");
    const manualEnd = voteEventFixture();
    manualEnd.options.autoEnd = false;
    expect(plan(manualEnd, clockRestart()).operation?.kind).toBe("round_warning");
  });
  it("stops after five minutes of waiting for players, before or during its round", () => {
    const event = armed();
    const first = plan(event, preRoundSnapshot(eventNow + 5_000));
    expect(first.stop).toBeUndefined();
    event.progress = first.progress;
    // Five seconds short of the documented five minutes.
    const before = plan(event, preRoundSnapshot(eventNow + 5_000 + 295_000));
    expect(before).toMatchObject({ operation: null, state: "waiting_round" });
    expect(before.stop).toBeUndefined();
    expect(before.halt).toBeUndefined();
    expect(plan(event, preRoundSnapshot(eventNow + 5_000 + POPULATION_WAIT_MS))).toMatchObject({ stop: "population" });
  });
  it("gives a pending move two minutes to show, then stops instead of waiting for staff", () => {
    const event = voteEventFixture();
    event.progress.teams = ["Valkyra", "Lonestar"];
    const move = plan(event, snapshotAt()).operation!;
    expect(move.kind).toBe("move");
    event.progress = completeEventOperation(event, move, eventNow, false);
    expect(event.progress.movedAt).toEqual({ [move.steamId!]: eventNow });
    // Five seconds short of the documented two minutes.
    const before = plan(event, snapshotAt(eventNow + 115_000, 235));
    expect(before).toMatchObject({ operation: null, state: "active" });
    expect(before.halt).toBeUndefined();
    expect(before.stop).toBeUndefined();
    expect(plan(event, snapshotAt(eventNow + MOVE_GRACE_MS, 240)).halt).toContain("still on the closed team");
  });
  it("stops after two minutes of an unsafe roster instead of waiting for staff with the lock off", () => {
    const event = voteEventFixture();
    const unlinked = snapshotAt();
    unlinked.unlinkedPlayerCount = 1;
    const first = plan(event, unlinked);
    expect(first).toMatchObject({ operation: null, state: "active" });
    expect(first.halt).toBeUndefined();
    event.progress = first.progress;
    // Five seconds short of the documented two minutes.
    const before = snapshotAt(eventNow + 115_000, 235);
    before.unlinkedPlayerCount = 1;
    const waited = plan(event, before);
    expect(waited).toMatchObject({ operation: null, state: "active" });
    expect(waited.halt).toBeUndefined();
    expect(waited.stop).toBeUndefined();
    const later = snapshotAt(eventNow + ROSTER_GRACE_MS, 240);
    later.unlinkedPlayerCount = 1;
    expect(plan(event, later).halt).toContain("unlinked or duplicate");
    // A recovered roster clears the timer.
    expect(plan(event, snapshotAt(eventNow + 5_000, 125)).progress.rosterIssueSince).toBeUndefined();
  });
  it("moves the last closed-team player into a 49-player team", () => {
    const event = voteEventFixture();
    event.progress.teams = ["Valkyra", "Lonestar"];
    const packed = snapshotAt(eventNow, 120, [
      ...Array<string>(50).fill("Valkyra"),
      ...Array<string>(49).fill("Lonestar"),
      "Manticore",
    ]);
    event.progress.warned = Object.fromEntries(packed.players.map((player) => [player.steamId, eventNow - 60_000]));
    expect(plan(event, packed).operation?.action).toMatchObject({ faction: "Lonestar", expectedFaction: "Manticore" });
  });
  /** A full-server read on a rotation entry; `players` below 100 simulates players loading the next map. */
  function fullRead(at: number, scores: [number, number, number], map = "Kavkazi", index = 0, players = 100) {
    const snapshot = fullServerSnapshot(at, scores);
    snapshot.status = {
      ...snapshot.status,
      map,
      rotation: { nowIndex: index, nextIndex: index + 1 },
      players: { ...snapshot.status.players, current: players },
    };
    snapshot.players = snapshot.players.slice(0, players);
    return snapshot;
  }
  /**
   * Plans every five seconds over a timeline, completing each operation at once and applying moves to
   * the roster, as the service and game would. Returns the round warnings and stops, with their map.
   */
  function simulate(event: EventRecord, timeline: (elapsed: number) => EventSnapshot, seconds: number) {
    let track = event.progress.tracker!;
    const teams = new Map<string, string>();
    const log: string[] = [];
    for (let elapsed = 5_000; elapsed <= seconds * 1000; elapsed += 5_000) {
      const at = eventNow + elapsed;
      const snapshot = timeline(elapsed);
      snapshot.players = snapshot.players.map((player) => ({
        ...player,
        faction: teams.get(player.steamId) ?? player.faction,
      }));
      track = trackOf([snapshot], 20, track);
      const planned = planEvent(event, snapshot, at, track);
      event.progress = planned.progress;
      const where = `${elapsed / 1000}s on ${snapshot.status.map}`;
      if (planned.stop || planned.halt) {
        log.push(`stop ${planned.stop ?? planned.halt} ${where}`);
        break;
      }
      const op = planned.operation;
      if (!op) {
        event.state = planned.state;
        continue;
      }
      if (op.kind === "round_warning") log.push(`round_warning ${where}`);
      if (op.kind === "move") teams.set(op.steamId!, op.faction!);
      event.progress = completeEventOperation(event, op, at);
      event.state = op.kind === "round_warning" ? "warming" : "active";
    }
    return log;
  }
  /** Armed during round N on Kavkazi, at 90 points on a full server. */
  function armedFull() {
    const event = armed();
    event.progress.tracker = trackOf([fullRead(eventNow, [90, 40, 20])]);
    event.progress.roundId = event.progress.tracker.round.id;
    return event;
  }
  /** Points for the new round from `start` on: one every 20 seconds. */
  const points = (elapsed: number, start: number): [number, number, number] => [
    1 + Math.floor((elapsed - start) / 20_000),
    0,
    0,
  ];
  it.each([
    ["map travel", "Zestafona", 1],
    ["a rotation index change", "Kavkazi", 1],
  ] as const)("does not start the 50v50 on the old final scoreboard after %s", (_, map, index) => {
    const event = armedFull();
    const log = simulate(
      event,
      (elapsed) => {
        if (elapsed < 10_000) return fullRead(eventNow + elapsed, [100, 40, 20]);
        // The next entry is reported while the final scores stay on screen for 45 seconds.
        if (elapsed < 55_000) return fullRead(eventNow + elapsed, [100, 40, 20], map, index);
        if (elapsed < 85_000) return fullRead(eventNow + elapsed, [0, 0, 0], map, index);
        return fullRead(eventNow + elapsed, points(elapsed, 85_000), map, index);
      },
      600,
    );
    expect(log).toEqual([`round_warning 85s on ${map}`]);
    expect(event.progress).toMatchObject({ roundsStarted: 1, readyAnnounced: true });
  });
  it("waits for the new map's first points when map travel follows the score reset by over three minutes", () => {
    const event = armedFull();
    const log = simulate(
      event,
      (elapsed) => {
        if (elapsed < 20_000) return fullRead(eventNow + elapsed, [100, 40, 20]);
        if (elapsed < 220_000) return fullRead(eventNow + elapsed, [0, 0, 0]);
        if (elapsed < 250_000) return fullRead(eventNow + elapsed, [0, 0, 0], "Zestafona", 1);
        return fullRead(eventNow + elapsed, points(elapsed, 250_000), "Zestafona", 1);
      },
      700,
    );
    expect(log).toEqual(["round_warning 250s on Zestafona"]);
    expect(event.progress).toMatchObject({ roundsStarted: 1, readyAnnounced: true });
  });
  it("waits through a map load below the start threshold after the reset, then starts on the new map", () => {
    const event = armedFull();
    const log = simulate(
      event,
      (elapsed) => {
        if (elapsed < 20_000) return fullRead(eventNow + elapsed, [100, 40, 20]);
        if (elapsed < 65_000) return fullRead(eventNow + elapsed, [0, 0, 0]);
        // Players load Zestafona for 70 seconds, below the 20 needed to start.
        if (elapsed < 135_000) return fullRead(eventNow + elapsed, [0, 0, 0], "Zestafona", 1, 12);
        if (elapsed < 150_000) return fullRead(eventNow + elapsed, [0, 0, 0], "Zestafona", 1);
        return fullRead(eventNow + elapsed, points(elapsed, 150_000), "Zestafona", 1);
      },
      600,
    );
    expect(log).toEqual(["round_warning 150s on Zestafona"]);
    expect(event.progress).toMatchObject({ roundsStarted: 1, readyAnnounced: true });
  });
  it("ends after the voted round's own final score, not at the transition before it", () => {
    const event = armedFull();
    const log = simulate(
      event,
      (elapsed) => {
        if (elapsed < 20_000) return fullRead(eventNow + elapsed, [100, 40, 20]);
        if (elapsed < 50_000) return fullRead(eventNow + elapsed, [0, 0, 0], "Zestafona", 1);
        if (elapsed < 600_000) return fullRead(eventNow + elapsed, points(elapsed, 50_000), "Zestafona", 1);
        return fullRead(eventNow + elapsed, [100, 50, 30], "Zestafona", 1);
      },
      700,
    );
    expect(log).toEqual(["round_warning 50s on Zestafona", "stop rounds 600s on Zestafona"]);
  });
  it("sorts a full server to 50 against 50 in 33 moves without a capacity problem", () => {
    const event = armed();
    let roster = fullServerSnapshot(eventNow).players.map((player) => ({ ...player }));
    const read = (now: number) => {
      const snapshot = fullServerSnapshot(
        now,
        now < eventNow + 15_000 ? [10, 6, 4] : now < eventNow + 20_000 ? [0, 0, 0] : [1, 0, 0],
      );
      snapshot.players = roster.map((player) => ({ ...player }));
      return snapshot;
    };
    event.progress.tracker = trackOf([read(eventNow)], 0);
    event.progress.roundId = event.progress.tracker.round.id;
    let now = eventNow + 5_000;
    const moves: string[] = [];
    let track: RoundTrack = event.progress.tracker;
    for (let pass = 0; pass < 120 && event.state !== "needs_review"; pass++) {
      const snapshot = read(now);
      track = trackOf([snapshot], 0, track);
      const planned = planEvent(event, snapshot, now, track);
      expect(planned.halt).toBeUndefined();
      expect(planned.stop).toBeUndefined();
      expect(planned.state).not.toBe("needs_review");
      event.progress = planned.progress;
      const op = planned.operation;
      if (op) {
        event.progress = completeEventOperation(event, op, now);
        if (op.kind === "round_warning") event.state = "warming";
        else event.state = "active";
        if (op.kind === "move") {
          moves.push(op.steamId!);
          roster = roster.map((player) =>
            player.steamId === op.steamId ? { ...player, faction: op.faction! } : player,
          );
        }
      }
      now += 5_000;
    }
    const counts = ["Valkyra", "Lonestar", "Manticore"].map(
      (team) => roster.filter((player) => player.faction === team).length,
    );
    expect(event.progress.teams).toEqual(["Valkyra", "Manticore"]);
    expect(counts).toEqual([50, 0, 50]);
    expect(moves).toHaveLength(33);
    expect(new Set(moves).size).toBe(33);
    expect(event.progress.readyAnnounced).toBe(true);
  });
});
