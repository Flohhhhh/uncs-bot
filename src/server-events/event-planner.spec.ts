import { actionSchema } from "../admin/admin.types";
import { completeEventOperation, planEvent } from "./event-planner";
import { eventFixture, eventNow, snapshotAt } from "./event-fixtures";
import { initialEventProgress, startEventSchema } from "./server-events.types";

describe("optional game-roster 50v50 planning", () => {
  it("waits for the next observed round, including a restart on the same map", () => {
    const event = eventFixture();
    event.state = "waiting_round";
    expect(planEvent(event, snapshotAt(), eventNow).operation).toBeNull();
    const plan = planEvent(event, snapshotAt(eventNow, 0), eventNow);
    expect(plan.operation?.kind).toBe("round_warning");
    expect(plan.operation?.recipients).toHaveLength(3);
    expect(plan.progress.moved).toEqual([]);
    expect(plan.progress.warned).toEqual({});
  });
  it("starts the warning clock when the message actually finishes", () => {
    const event = eventFixture();
    event.state = "waiting_round";
    const plan = planEvent(event, snapshotAt(eventNow, 0), eventNow);
    event.progress = plan.progress;
    event.progress = completeEventOperation(event, plan.operation!, eventNow + 5000);
    event.state = "warming";
    expect(planEvent(event, snapshotAt(eventNow + 30_000, 30), eventNow + 30_000).operation).toBeNull();
    event.progress.lastObservedAt = eventNow + 30_000;
    expect(planEvent(event, snapshotAt(eventNow + 35_000, 35), eventNow + 35_000).operation?.kind).toBe("move");
  });
  it("moves an excluded player to the smaller team with round, current-team and capacity checks", () => {
    const plan = planEvent(eventFixture(), snapshotAt(), eventNow);
    expect(plan.operation?.action).toMatchObject({
      action: "team",
      steamId: snapshotAt().players[2].steamId,
      faction: "Valkyra",
      expectedFaction: "Manticore",
      maximumTargetPlayers: 50,
      expectedRound: eventFixture().progress.round,
    });
    expect(actionSchema.safeParse(plan.operation?.action).success).toBe(true);
  });
  it("waits for unassigned arrivals rather than repeatedly claiming moves the adapter must reject", () => {
    expect(planEvent(eventFixture(), snapshotAt(eventNow, 120, ["RED", "GRN", null]), eventNow).operation).toBeNull();
  });
  it("warns a new arrival before assigning them and uses the actual send time", () => {
    const event = eventFixture();
    event.progress.warned = {};
    const plan = planEvent(event, snapshotAt(), eventNow);
    expect(plan.operation?.kind).toBe("player_warning");
    event.progress = completeEventOperation(event, plan.operation!, eventNow + 3000);
    expect(planEvent(event, snapshotAt(eventNow + 30_000, 150), eventNow + 30_000).operation).toBeNull();
  });
  it("forgets disconnected players' warnings without allowing a second move in the same round", () => {
    const event = eventFixture(),
      removed = snapshotAt().players[2].steamId;
    event.progress.moved = [removed];
    const plan = planEvent(event, snapshotAt(eventNow, 120, ["RED", "BLU"]), eventNow);
    expect(plan.progress.warned[removed]).toBeUndefined();
    expect(plan.progress.moved).toEqual([removed]);
    expect(planEvent(event, snapshotAt(), eventNow).state).toBe("needs_review");
  });
  it("balances uneven active teams early, then stops mid-round shuffling", () => {
    const event = eventFixture();
    expect(planEvent(event, snapshotAt(eventNow, 120, ["RED", "RED", "RED"]), eventNow).operation?.kind).toBe("move");
    event.progress.round.startedAt = eventNow - 900_000;
    expect(planEvent(event, snapshotAt(eventNow, 900, ["RED", "RED", "RED"]), eventNow).operation).toBeNull();
    expect(planEvent(event, snapshotAt(eventNow, 900), eventNow).operation?.kind).toBe("move");
  });
  it("does not move already-balanced teams and announces readiness once", () => {
    const event = eventFixture(),
      snapshot = snapshotAt(eventNow, 120, ["RED", "BLU"]);
    const plan = planEvent(event, snapshot, eventNow);
    expect(plan.operation?.kind).toBe("ready");
    event.progress = completeEventOperation(event, plan.operation!, eventNow);
    expect(planEvent(event, snapshot, eventNow).operation).toBeNull();
  });
  it.each([[[]], [[null]], [["RED", "BLU", null]]] as Array<[Array<string | null>]>)(
    "does not announce assignment complete for empty/unassigned rosters (%j)",
    (teams) => {
      expect(planEvent(eventFixture(), snapshotAt(eventNow, 120, teams), eventNow).operation).toBeNull();
    },
  );
  it.each(["stale", "future", "missing", "population"])("waits on an unusable %s observation", (kind) => {
    const snapshot = snapshotAt();
    if (kind === "stale") snapshot.observedAt = new Date(eventNow - 16_000).toISOString();
    if (kind === "future") snapshot.observedAt = new Date(eventNow + 6_000).toISOString();
    if (kind === "missing") snapshot.status.matchSeconds = undefined;
    if (kind === "population") snapshot.status.players.current += 1;
    expect(planEvent(eventFixture(), snapshot, eventNow).operation).toBeNull();
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
      expect(planEvent(eventFixture(), snapshot, eventNow)).toMatchObject({ state: "needs_review", operation: null });
    },
  );
  it("re-baselines after an observation gap instead of treating downtime as a round-start signal", () => {
    const event = eventFixture();
    event.progress.lastObservedAt -= 31_000;
    const plan = planEvent(event, snapshotAt(eventNow, 0), eventNow);
    expect(plan.state).toBe("waiting_round");
    expect(plan.operation).toBeNull();
    expect(plan.progress).toEqual(initialEventProgress({ map: "Kavkazi", startedAt: eventNow }, eventNow));
  });
  it("keeps respawns opt-in and only plans one after a confirmed move", () => {
    const event = eventFixture(),
      plan = planEvent(event, snapshotAt(), eventNow);
    expect(completeEventOperation(event, plan.operation!, eventNow).pendingRespawn).toBeNull();
    event.options.forceRespawn = true;
    event.progress = completeEventOperation(event, plan.operation!, eventNow);
    const next = planEvent(event, snapshotAt(eventNow, 120, ["RED", "BLU", "RED"]), eventNow);
    expect(next.operation?.action).toMatchObject({
      action: "kill",
      expectedFaction: "Valkyra",
      expectedRound: event.progress.round,
    });
    expect(actionSchema.safeParse(next.operation?.action).success).toBe(true);
    expect(completeEventOperation(event, next.operation!, eventNow).pendingRespawn).toBeNull();
  });
  it("drops a pending respawn if the player left, changed teams, or a new round began", () => {
    const event = eventFixture();
    event.options.forceRespawn = true;
    event.progress.pendingRespawn = { steamId: snapshotAt().players[2].steamId, faction: "Valkyra" };
    expect(planEvent(event, snapshotAt(), eventNow).progress.pendingRespawn).toBeNull();
    expect(planEvent(event, snapshotAt(eventNow, 0), eventNow).operation?.kind).toBe("round_warning");
    expect(planEvent(event, snapshotAt(eventNow, 0), eventNow).progress.pendingRespawn).toBeNull();
  });
  it("keeps generated warnings within the game message limit", () => {
    const event = eventFixture();
    event.options.forceRespawn = true;
    event.options.teams = ["a".repeat(150), "b".repeat(150)];
    const snapshot = snapshotAt(eventNow, 0);
    snapshot.status.factionScores[0].name = event.options.teams[0];
    snapshot.status.factionScores[1].name = event.options.teams[1];
    const plan = planEvent(event, snapshot, eventNow);
    expect(actionSchema.safeParse(plan.operation?.action).success).toBe(true);
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
    ])
      expect(startEventSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
