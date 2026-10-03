import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { ServerEventsService } from "./server-events.service";
import { ServerEventsStore } from "./server-events.store";
import { fixtureServers } from "../admin/game-server-fixture";
import type { Staff } from "../admin/admin.types";
import { AdminService } from "../admin/admin.service";
import { AdminAuth } from "../admin/admin.auth";
import { GameRounds } from "../admin/game-rounds";
import { EnvService } from "../env/env.service";
import { StaffAlerts } from "../staff-alerts/staff-alerts.service";
import { defaultVotingSettings, type FiftyFiftySettings } from "../common/voting-policy";
import {
  clocklessSnapshotAt,
  eventFixture,
  eventNow,
  eventStaff,
  fullServerSnapshot,
  preRoundSnapshot,
  snapshotAt,
  voteEventFixture,
} from "./event-fixtures";
import { operation } from "./event-planner";
import { eventView, systemStops, type EventRecord, type EventSnapshot } from "./server-events.types";

type Field = { id: string; value: boolean | number | null; editable: boolean };
const lockField = (value: boolean | null, editable = true): Field => ({ id: "lockOverpopulated", value, editable });
function fixture(serverId = "primary", make: () => EventRecord = eventFixture) {
  const record = make();
  record.serverId = serverId;
  let current: EventRecord | null = record;
  const store = {
    get: jest.fn(async (_id?: string) => current),
    current: jest.fn(async (_serverId?: string) => (current && current.state !== "complete" ? current : null)),
    history: jest.fn(async (_serverId?: string) => (current ? [current] : [])),
    operations: jest.fn(async () => []),
    create: jest.fn(async (values) => {
      current = {
        ...record,
        ...values,
        state: "preparing",
        restoreRevision: null,
        stop: null,
        operation: null,
        version: 1,
      };
      return { created: true, event: current };
    }),
    claim: jest.fn(async (_id, _version, op, _actor, progress): Promise<EventRecord | null> => {
      current = {
        ...current!,
        operation: op,
        progress,
        state: op.kind === "restore_lock" || current!.stop ? "stopping" : current!.state,
      };
      return current;
    }),
    observe: jest.fn(async (_id, _version, update) => {
      current = { ...current!, ...update };
      return true;
    }),
    settle: jest.fn(async (_id, _op, _result, update) => {
      const state = current!.stop && !["complete", "needs_review"].includes(update.state) ? "stopping" : update.state;
      current = { ...current!, ...update, state, operation: null };
      return current;
    }),
    stop: jest.fn(async (_id, stop) => {
      if (current!.stop || current!.state === "complete") return current!;
      current = { ...current!, stop, state: current!.state === "needs_review" ? "needs_review" : "stopping" };
      return current;
    }),
    completeUnchanged: jest.fn(async () => {
      current = { ...current!, state: "complete" };
      return current;
    }),
    completeRestored: jest.fn(async (_id: string, _version: number, message: string) => {
      current = { ...current!, state: "complete", message };
      return current;
    }),
    recover: jest.fn(),
    halt: jest.fn(async (_id: string, reason: string, opId?: string) => {
      if (!current || ["complete", "needs_review"].includes(current.state)) return null;
      if (opId ? current.operation?.id !== opId : current.operation) return null;
      current = {
        ...current,
        stop: current.stop ?? {
          id: randomUUID(),
          actorId: "system:event-halt",
          actorName: "Gramps 50v50 safety stop",
          reason,
          at: new Date().toISOString(),
        },
        state: "stopping",
        operation: null,
        message: reason,
      };
      return current;
    }),
  };
  const game = {
    configuration: jest.fn(
      async (): Promise<{ revision: string; fields: Field[] }> => ({
        revision: "r2",
        fields: [lockField(false)],
      }),
    ),
    overview: jest.fn(async (): Promise<EventSnapshot> => snapshotAt(Date.now(), 120 + (Date.now() - eventNow) / 1000)),
    capabilities: jest.fn(async () => snapshotAt().capabilities),
  };
  const admin = {
    act: jest.fn(async (_staff: unknown, _action: unknown) => ({
      state: "applied",
      changed: true,
      message: "Confirmed",
      revision: "r2",
    })),
  };
  const role = jest.fn(async () => "admin");
  const auth = {
    role,
    serverStaff: jest.fn(async (actor: Staff, serverId: string) => ({
      ...actor,
      serverId,
      serverVersion: "0".repeat(64),
      role: await role(),
    })),
  };
  const environment: Record<string, unknown> = {
    SERVER_EVENTS_ENABLED: true,
    // The owner has reviewed voted 50v50, so vote-started events here were recorded and keep running.
    MAP_VOTES_FIFTY_ENABLED: true,
    WARDOGS_RCON_URL: "https://game.example.test",
    ADMIN_GUILD_ID: record.guildId,
  };
  const servers = fixtureServers(game, () => environment.WARDOGS_RCON_URL as string, serverId);
  const alerts = { send: jest.fn(async (_server: string, _key: string, _message: string) => true) };
  /** A new process: fresh in-memory round state over the same storage and game. */
  const make2 = () =>
    new ServerEventsService(
      store as unknown as ServerEventsStore,
      servers,
      admin as unknown as AdminService,
      auth as unknown as AdminAuth,
      { get: (key: string) => environment[key] } as EnvService,
      new GameRounds(servers),
      alerts as unknown as StaffAlerts,
    );
  const service = make2();
  const input = {
    id: record.id,
    serverId,
    revision: "r2",
    reason: record.reason,
    ...record.options,
    confirm: "START 50V50",
  };
  return {
    service,
    make: make2,
    store,
    game,
    admin,
    auth,
    alerts,
    environment,
    record,
    input,
    current: () => current,
    set: (value: EventRecord | null) => {
      current = value;
    },
  };
}
const actions = (f: ReturnType<typeof fixture>) =>
  f.admin.act.mock.calls.map(([, action]) => action as { action: string; message?: string; changes?: object });

describe("durable optional event service", () => {
  it("binds a non-primary event worker and its system action to the original server", async () => {
    const f = fixture("event");
    await f.service.tick("event");
    expect(f.store.current).toHaveBeenCalledWith("event");
    expect(f.auth.serverStaff).toHaveBeenCalledWith(expect.objectContaining({ serverId: "event" }), "event", true);
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "event", serverVersion: "0".repeat(64) }),
      expect.objectContaining({ serverId: "event" }),
    );
  });
  it("does not expose or stop an event through another server's routes", async () => {
    const f = fixture();
    f.set({ ...f.record, serverId: "event" });
    await expect(f.service.history(eventStaff, f.record.id)).rejects.toThrow("selected server");
    await expect(f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Stop event" })).rejects.toThrow(
      "selected server",
    );
    expect(f.store.operations).not.toHaveBeenCalled();
    expect(f.store.stop).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(eventNow);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it("leaves storage and the game untouched while disabled", async () => {
    const f = fixture();
    f.environment.SERVER_EVENTS_ENABLED = false;
    expect(await f.service.list(eventStaff)).toEqual({ enabled: false, serverId: "primary", events: [] });
    f.service.onApplicationBootstrap();
    await f.service.tick();
    await expect(f.service.start(eventStaff, f.input)).rejects.toThrow("owner setup");
    expect(f.store.current).not.toHaveBeenCalled();
    expect(f.game.configuration).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(["moderator", "viewer"] as const)("denies %s access without reads or effects", async (role) => {
    const f = fixture(),
      staff = { ...eventStaff, role };
    await expect(f.service.list(staff)).rejects.toThrow("Only administrators");
    await expect(f.service.start(staff, f.input)).rejects.toThrow("Only administrators");
    await expect(f.service.stop(staff, f.record.id, { id: randomUUID(), reason: "Stop event" })).rejects.toThrow(
      "Only administrators",
    );
    await expect(f.service.restore(staff, f.record.id, {})).rejects.toThrow("Only administrators");
    expect(f.store.get).not.toHaveBeenCalled();
    expect(f.game.configuration).not.toHaveBeenCalled();
  });
  it("records the reviewed intent before any action, and replays the same request without touching the game", async () => {
    const f = fixture();
    f.set(null);
    const started = await f.service.start(eventStaff, f.input);
    expect(started.state).toBe("preparing");
    expect(f.admin.act).not.toHaveBeenCalled();
    const reads = f.game.configuration.mock.calls.length;
    expect(await f.service.start(eventStaff, f.input)).toEqual(started);
    expect(f.game.configuration).toHaveBeenCalledTimes(reads);
    await expect(f.service.start(eventStaff, { ...f.input, durationMinutes: 90 })).rejects.toThrow("different request");
  });
  it("starts a staff event without a match clock once the round is live", async () => {
    const f = fixture();
    f.set(null);
    f.game.overview.mockResolvedValue(clocklessSnapshotAt());
    expect((await f.service.start(eventStaff, f.input)).state).toBe("preparing");
    const created = f.store.create.mock.calls[0][0];
    expect(created.progress).toMatchObject({ roundsStarted: 0, round: { map: "Kavkazi", startedAt: eventNow } });
    expect(created.progress.roundId).toBe(created.progress.tracker.round.id);
    expect(created.progress.tracker.round).toMatchObject({ source: "baseline", exact: false });
  });
  it.each(["revision", "pre-round", "roster", "capability", "allowance", "lock"])(
    "rejects unsafe %s start conditions",
    async (kind) => {
      const f = fixture();
      f.set(null);
      if (kind === "revision") f.input.revision = "old";
      if (kind === "lock") f.game.configuration.mockResolvedValue({ revision: "r2", fields: [lockField(true, false)] });
      const snapshot = kind === "pre-round" ? preRoundSnapshot() : snapshotAt();
      if (kind === "roster") snapshot.status.players.current = 20;
      if (kind === "capability") snapshot.capabilities.routes = [];
      if (kind === "allowance") snapshot.capabilities.limits!.maxRequestsPerMinutePerIp = 10;
      f.game.overview.mockResolvedValue(snapshot);
      await expect(f.service.start(eventStaff, f.input)).rejects.toThrow(ConflictException);
      expect(f.store.create).not.toHaveBeenCalled();
      expect(f.admin.act).not.toHaveBeenCalled();
    },
  );
  it("disables only the native team lock at the fresh revision, even after an unrelated edit", async () => {
    const f = fixture();
    f.record.state = "preparing";
    f.record.restoreRevision = null;
    f.record.initialRevision = "r1";
    f.game.configuration.mockResolvedValue({ revision: "r9", fields: [lockField(true)] });
    f.admin.act.mockResolvedValue({ state: "pending", changed: true, message: "Saved", revision: "r10" });
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: `system:50v50:${f.record.id}` }),
      expect.objectContaining({ action: "settings-save", revision: "r9", changes: { lockOverpopulated: false } }),
    );
    expect(f.current()).toMatchObject({ state: "preparing", restoreRevision: "r10" });
    expect(f.current()?.progress.lockDisabledAt).toBe(eventNow);
  });
  it("continues when the lock save has no exact revision, and records that it changed the lock", async () => {
    const f = fixture();
    f.record.state = "preparing";
    f.record.restoreRevision = null;
    f.game.configuration.mockResolvedValue({ revision: "r2", fields: [lockField(true)] });
    f.admin.act.mockResolvedValue({ state: "pending", changed: true, message: "Saved", revision: undefined! });
    await f.service.tick();
    expect(f.current()).toMatchObject({ state: "preparing", restoreRevision: null });
    f.game.configuration.mockResolvedValue({ revision: "r3", fields: [lockField(false)] });
    f.admin.act.mockResolvedValue({ state: "applied", changed: true, message: "Sent", revision: undefined! });
    await f.service.tick();
    expect(actions(f)[1]).toMatchObject({ action: "broadcast" });
    expect(f.current()?.state).toBe("waiting_round");
    expect(eventView(f.current()!).lockChanged).toBe(true);
  });
  it("arms an event without moving anyone in its current round", async () => {
    const f = fixture();
    f.record.state = "preparing";
    await f.service.tick();
    expect(actions(f)[0]).toMatchObject({ action: "broadcast" });
    expect(f.current()?.state).toBe("waiting_round");
    jest.setSystemTime(eventNow + 5_000);
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
  });
  it("holds its announcement while the server waits for players", async () => {
    const f = fixture();
    f.record.state = "preparing";
    f.game.overview.mockResolvedValue(preRoundSnapshot());
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ state: "preparing" });
    expect(f.current()?.message).toContain("waits until players are back");
  });
  it("does not respawn a player for an already-correct or refused move", async () => {
    const f = fixture();
    f.record.options.forceRespawn = true;
    f.admin.act.mockResolvedValue({
      state: "applied",
      changed: false,
      message: "Already correct",
      revision: undefined!,
    });
    await f.service.tick();
    expect(f.current()?.progress.pendingRespawn).toBeNull();
    expect(f.current()?.progress.moved).toEqual([]);
  });
  it.each(["pending", "unknown", "accepted"])("does not respawn or replay a %s move", async (state) => {
    const f = fixture();
    f.record.options.forceRespawn = true;
    f.admin.act.mockResolvedValue({ state, changed: true, message: "Unconfirmed", revision: undefined! });
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
    expect(f.current()?.progress.pendingRespawn).toBeNull();
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
  });
  it("stops an old round's operation before calling the game action service", async () => {
    const f = fixture();
    f.game.overview.mockResolvedValueOnce(snapshotAt()).mockResolvedValueOnce(snapshotAt(eventNow + 1_000, 0));
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.settle).toHaveBeenCalledWith(
      f.record.id,
      expect.any(String),
      expect.objectContaining({ state: "failed" }),
      expect.any(Object),
    );
  });
  it("checks staff access again after claiming an operation", async () => {
    const f = fixture();
    f.auth.role.mockResolvedValueOnce("admin").mockResolvedValueOnce("viewer");
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()?.state).toBe("needs_review");
  });
  it("records stop without contacting the game and skips a claimed move when stop arrives during review", async () => {
    const f = fixture();
    f.auth.role
      .mockImplementationOnce(async () => "admin")
      .mockImplementationOnce(async () => {
        await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Stop during review" });
        return "admin";
      });
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()?.stop?.reason).toBe("Stop during review");
  });
  it("does not claim twice when another instance already owns the operation", async () => {
    const f = fixture();
    f.store.claim.mockResolvedValue(null);
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("never replays an interrupted operation and still records its duration limit", async () => {
    const f = fixture();
    f.record.operation = operation(f.record, "move", { action: "team" });
    f.record.endsAt = new Date(eventNow - 1);
    await f.service.tick();
    expect(f.store.stop).toHaveBeenCalled();
    expect(f.store.recover).toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.game.configuration).not.toHaveBeenCalled();
  });
  it("restores only the team lock at the fresh revision after an unrelated edit, such as a queued map", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.game.configuration.mockResolvedValue({ revision: "changed", fields: [lockField(false)] });
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
    expect(actions(f)[0]).toEqual(
      expect.objectContaining({ action: "settings-save", revision: "changed", changes: { lockOverpopulated: true } }),
    );
    expect(f.current()?.state).toBe("complete");
  });
  it("lets staff restore an event in review", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.set({ ...f.current()!, state: "needs_review" });
    await f.service.restore(eventStaff, f.record.id, {
      id: randomUUID(),
      reason: "Reviewed newer settings",
      revision: "changed",
      confirm: "RESTORE TEAM LOCK",
    });
    expect(actions(f)[0]).toMatchObject({
      action: "settings-save",
      revision: "changed",
      changes: { lockOverpopulated: true },
    });
    expect(f.current()?.state).toBe("complete");
  });
  it("automatically restores the original lock after a clean stop", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    await f.service.tick();
    expect(f.current()?.state).toBe("complete");
    expect(actions(f)[0]).toMatchObject({ action: "settings-save", changes: { lockOverpopulated: true } });
  });
  it("completes without a write when the team lock already has its original value", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.game.configuration.mockResolvedValue({ revision: "r5", fields: [lockField(true)] });
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()?.state).toBe("complete");
  });
  it("rechecks an unconfirmed restore and retries at most five times, a minute apart, then alerts staff", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.admin.act.mockResolvedValue({ state: "unknown", changed: true, message: "Unconfirmed", revision: undefined! });
    await f.service.tick();
    expect(f.current()?.state).toBe("stopping");
    jest.setSystemTime(eventNow + 10_000);
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= 5; attempt++) {
      jest.setSystemTime(Date.now() + 60_000);
      await f.service.tick();
      expect(f.admin.act).toHaveBeenCalledTimes(attempt);
    }
    expect(new Set(actions(f).map((action) => (action as { id?: string }).id)).size).toBe(5);
    jest.setSystemTime(Date.now() + 60_000);
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(5);
    expect(f.current()?.state).toBe("needs_review");
    expect(f.alerts.send).toHaveBeenCalledWith(
      "primary",
      `event-lock-restore:${f.record.id}`,
      expect.stringContaining("Team lock may still be OFF on Test UNCs"),
    );
    // A recheck that finds the lock back on completes without another write.
    const g = fixture();
    await g.service.stop(eventStaff, g.record.id, { id: randomUUID(), reason: "Finished event" });
    g.admin.act.mockResolvedValue({ state: "unknown", changed: true, message: "Unconfirmed", revision: undefined! });
    await g.service.tick();
    g.game.configuration.mockResolvedValue({ revision: "r3", fields: [lockField(true)] });
    await g.service.tick();
    expect(g.admin.act).toHaveBeenCalledTimes(1);
    expect(g.current()?.state).toBe("complete");
  });
  it("waits, then alerts, when the team lock cannot be read while restoring", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.game.configuration.mockResolvedValue({ revision: "r2", fields: [lockField(null)] });
    await f.service.tick();
    expect(f.current()?.state).toBe("stopping");
    expect(f.alerts.send).not.toHaveBeenCalled();
    jest.setSystemTime(eventNow + 5 * 60_000);
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledWith("primary", `event-lock-unreadable:${f.record.id}`, expect.any(String));
    jest.setSystemTime(eventNow + 30 * 60_000);
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.alerts.send).toHaveBeenLastCalledWith(
      "primary",
      `event-lock-restore:${f.record.id}`,
      expect.stringContaining("for 30 minutes"),
    );
  });
  it.each([
    ["a voted 50v50 is running", false],
    ["a voted 50v50 is restoring the lock", true],
  ])("alerts, then asks staff, when the game settings cannot be read while %s", async (_, stopping) => {
    const f = fixture("primary", voteEventFixture);
    if (stopping) await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.game.configuration.mockRejectedValue(new Error("Unavailable"));
    await f.service.tick();
    expect(f.current()).toMatchObject({ state: stopping ? "stopping" : "active" });
    expect(f.current()?.progress.lockIssueSince).toBe(eventNow);
    expect(f.alerts.send).not.toHaveBeenCalled();
    jest.setSystemTime(eventNow + 5 * 60_000);
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledWith(
      "primary",
      `event-lock-unreadable:${f.record.id}`,
      expect.stringContaining("Team lock may still be OFF"),
    );
    jest.setSystemTime(eventNow + 30 * 60_000);
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
    expect(f.alerts.send).toHaveBeenLastCalledWith(
      "primary",
      `event-lock-restore:${f.record.id}`,
      expect.stringContaining("for 30 minutes"),
    );
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("only retries a failed settings read while the team lock was never changed", async () => {
    const f = fixture("primary", voteEventFixture);
    f.set({ ...f.record, state: "preparing", progress: { ...f.record.progress, lockDisabledAt: undefined } });
    f.game.configuration.mockRejectedValue(new Error("Unavailable"));
    jest.setSystemTime(eventNow + 60_000);
    await f.service.tick();
    jest.setSystemTime(eventNow + 40 * 60_000);
    await f.service.tick();
    expect(f.current()?.state).toBe("preparing");
    expect(f.alerts.send).not.toHaveBeenCalled();
  });
  it("restores the team lock even when the status read fails", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.game.overview.mockRejectedValue(new Error("Unavailable"));
    await f.service.tick();
    expect(actions(f)[0]).toMatchObject({ changes: { lockOverpopulated: true } });
    expect(f.current()?.state).toBe("complete");
  });
  it("rechecks an interrupted restore from the saved setting after a restart instead of asking staff", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    const restore = operation(f.record, "restore_lock", {
      action: "settings-save",
      revision: "r2",
      changes: { lockOverpopulated: true },
    });
    f.set({ ...f.current()!, operation: restore, state: "stopping", updatedAt: new Date(eventNow) });
    const restarted = f.make();
    await restarted.tick();
    expect(f.store.halt).not.toHaveBeenCalled();
    jest.setSystemTime(eventNow + 121_000);
    await restarted.tick();
    expect(f.store.halt).toHaveBeenCalledWith(f.record.id, expect.any(String), restore.id);
    await restarted.tick();
    expect(actions(f)).toEqual([expect.objectContaining({ changes: { lockOverpopulated: true } })]);
    expect(f.current()?.state).toBe("complete");
  });
  it("does not change a lock that was already off before the event", async () => {
    const f = fixture();
    f.record.originalLock = false;
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    await f.service.tick();
    expect(f.current()?.state).toBe("complete");
    expect(f.game.configuration).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("refuses effects if the endpoint or community changed", async () => {
    const f = fixture();
    f.environment.WARDOGS_RCON_URL = "https://different.example.test";
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
    expect(f.game.configuration).not.toHaveBeenCalled();
  });
  it("stops scheduling on shutdown and isolates transient read failures", async () => {
    const f = fixture();
    f.game.configuration.mockRejectedValue(new Error("Unavailable"));
    expect(await f.service.tick()).toBe(30_000);
    expect(f.admin.act).not.toHaveBeenCalled();
    f.service.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);
    f.service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    f.game.configuration.mockClear();
    await f.service.tick();
    expect(f.game.configuration).not.toHaveBeenCalled();
  });
  it("alerts once when the team lock stays off after a finished event", async () => {
    const f = fixture();
    f.set({ ...f.record, state: "complete", updatedAt: new Date(eventNow - 60_000) });
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledWith(
      "primary",
      `event-lock-off:${f.record.id}`,
      expect.stringContaining("Team lock is OFF"),
    );
    jest.setSystemTime(eventNow + 10 * 60_000);
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    const on = fixture();
    on.set({ ...on.record, state: "complete" });
    on.game.configuration.mockResolvedValue({ revision: "r2", fields: [lockField(true)] });
    await on.service.tick();
    const old = fixture();
    old.set({ ...old.record, state: "complete", updatedAt: new Date(eventNow - 25 * 3600_000) });
    await old.service.tick();
    expect(on.alerts.send).not.toHaveBeenCalled();
    expect(old.alerts.send).not.toHaveBeenCalled();
    // A lock that was already off before the event is not Gramps' to report.
    const wasOff = fixture();
    wasOff.set({ ...wasOff.record, state: "complete", originalLock: false, updatedAt: new Date(eventNow - 60_000) });
    await wasOff.service.tick();
    expect(wasOff.game.configuration).not.toHaveBeenCalled();
    expect(wasOff.alerts.send).not.toHaveBeenCalled();
  });
  it("drops a claimed move without sending it when the server is waiting for players before it is sent", async () => {
    const f = fixture();
    // A live round still at 0 points with 25 players; the excluded player is warned and due a move.
    const crowd = [...Array<string>(24).fill("RED"), "GRN"];
    const live = clocklessSnapshotAt(eventNow, crowd, [0, 0, 0]);
    f.set({
      ...f.record,
      progress: {
        ...f.record.progress,
        tracker: undefined,
        roundId: undefined,
        warned: Object.fromEntries(live.players.map((player) => [player.steamId, eventNow - 60_000])),
      },
    });
    // Players leave before the move's own check: the same round, now waiting for players.
    const waiting = clocklessSnapshotAt(eventNow + 1_000, ["RED"], [0, 0, 0]);
    f.game.overview.mockResolvedValueOnce(live).mockResolvedValueOnce(waiting);
    await f.service.tick();
    expect(f.store.claim).toHaveBeenCalledWith(
      f.record.id,
      expect.any(Number),
      expect.objectContaining({ kind: "move" }),
      expect.anything(),
      expect.anything(),
    );
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.settle).toHaveBeenCalledWith(
      f.record.id,
      expect.any(String),
      expect.objectContaining({ state: "failed", message: expect.stringContaining("No event action was sent") }),
      expect.anything(),
    );
  });
});

describe("a 50v50 started by a community vote", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(eventNow);
  });
  afterEach(() => jest.useRealTimers());
  const fifty: FiftyFiftySettings = { ...defaultVotingSettings.fiftyFifty, offered: true, minPlayers: 80 };
  const voteActor = { ...eventStaff, serverId: "primary" };
  function voting() {
    const f = fixture("primary", voteEventFixture);
    f.set(null);
    f.game.overview.mockImplementation(async () => fullServerSnapshot(Date.now()));
    f.game.configuration.mockResolvedValue({ revision: "r7", fields: [lockField(true)] });
    const voteId = randomUUID();
    const start = (patch: Partial<FiftyFiftySettings> = {}) =>
      f.service.startFromVote({
        voteId,
        serverId: "primary",
        actor: voteActor,
        fifty: { ...fifty, ...patch },
        votes: 12,
        total: 20,
        label: "Zestafona",
      });
    return { ...f, voteId, start };
  }
  it("records the event under the ballot's ID with the vote's settings, without a clock or reviewed revision", async () => {
    const f = voting();
    const started = await f.start();
    expect(started.created).toBe(true);
    const created = f.store.create.mock.calls[0][0];
    expect(created).toMatchObject({
      id: f.voteId,
      actorId: eventStaff.id,
      actorName: "Gramps community vote (Test admin)",
      reason: `Community vote ${f.voteId}: 50v50 next round (12 of 20 votes)`,
      originalLock: true,
      initialRevision: "r7",
      options: {
        durationMinutes: 75,
        warningSeconds: 30,
        balanceWindowSeconds: 300,
        forceRespawn: false,
        rounds: 1,
        autoEnd: true,
        closedFaction: null,
        playerMessages: true,
        source: { kind: "vote", voteId: f.voteId, label: "Zestafona" },
        // Provisional: the two larger teams now; each round resolves its own.
        teams: ["Valkyra", "Manticore"],
      },
    });
    expect(created.endsAt).toEqual(new Date(eventNow + 75 * 60_000));
    expect(created.progress.roundId).toBe(created.progress.tracker.round.id);
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(await f.service.voteEvent(f.voteId)).toMatchObject({ state: "preparing" });
    expect(await f.service.voteEvent(randomUUID())).toBeNull();
    // A repeat returns the same event without another write.
    const again = await f.start();
    expect(again.created).toBe(false);
    expect(f.store.create).toHaveBeenCalledTimes(1);
  });
  it("works without single-player messages and records that arrivals are warned on first sight", async () => {
    const f = voting();
    f.game.overview.mockImplementation(async () => {
      const snapshot = fullServerSnapshot(Date.now());
      snapshot.capabilities.routes = snapshot.capabilities.routes.filter((route) => !route.includes("message"));
      return snapshot;
    });
    await f.start();
    expect(f.store.create.mock.calls[0][0].options.playerMessages).toBe(false);
  });
  it.each([
    [
      "events are off",
      (f: ReturnType<typeof voting>) => (f.environment.SERVER_EVENTS_ENABLED = false),
      ServiceUnavailableException,
    ],
    [
      "an event exists",
      (f: ReturnType<typeof voting>) => f.set({ ...voteEventFixture(), state: "needs_review" }),
      ConflictException,
    ],
    [
      "too few players are online",
      (f: ReturnType<typeof voting>) =>
        f.game.overview.mockImplementation(async () => {
          const snapshot = fullServerSnapshot(Date.now());
          snapshot.players = snapshot.players.slice(0, 64);
          snapshot.status.players.current = 64;
          return snapshot;
        }),
      ConflictException,
    ],
    [
      "team moves are not advertised",
      (f: ReturnType<typeof voting>) =>
        f.game.overview.mockImplementation(async () => {
          const snapshot = fullServerSnapshot(Date.now());
          snapshot.capabilities.routes = ["POST /v1/broadcast", "PUT /v1/config"];
          return snapshot;
        }),
      ConflictException,
    ],
    [
      "the server waits for players",
      (f: ReturnType<typeof voting>) => f.game.overview.mockImplementation(async () => preRoundSnapshot(Date.now())),
      ConflictException,
    ],
    [
      "voted 50v50 is held for the owner's review",
      (f: ReturnType<typeof voting>) => (f.environment.MAP_VOTES_FIFTY_ENABLED = false),
      ServiceUnavailableException,
    ],
  ] as const)("refuses cleanly when %s", async (_, change, type) => {
    const f = voting();
    const existing = f.current();
    change(f);
    if (f.current() !== existing) f.store.get.mockResolvedValue(null);
    await expect(f.start()).rejects.toThrow(type);
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  /** A full-server read after `leavers` players left at the end of the voted round. */
  const afterLeavers = (leavers: number, rosterLag = 0) => {
    const snapshot = fullServerSnapshot(Date.now());
    snapshot.players = snapshot.players.slice(leavers);
    snapshot.status.players.current = snapshot.players.length + rosterLag;
    return snapshot;
  };
  it("starts at the ballot's close-time player floor, below the offer minimum", async () => {
    const f = voting();
    f.game.overview.mockImplementation(async () => afterLeavers(25));
    // 75 players: under the offer minimum of 80, at or above the close-time floor of 70.
    const started = await f.service.startFromVote({
      voteId: f.voteId,
      serverId: "primary",
      actor: voteActor,
      fifty,
      minPlayers: 70,
      votes: 12,
      total: 20,
      label: "Zestafona",
    });
    expect(started.created).toBe(true);
    const below = voting();
    below.game.overview.mockImplementation(async () => afterLeavers(31));
    await expect(
      below.service.startFromVote({
        voteId: below.voteId,
        serverId: "primary",
        actor: voteActor,
        fifty,
        minPlayers: 70,
        votes: 12,
        total: 20,
        label: "Zestafona",
      }),
    ).rejects.toThrow("69 of 70 players online.");
  });
  it("leaves a roster still settling at the close to the planner instead of refusing a winning 50v50", async () => {
    const f = voting();
    // GET /v1/status and GET /v1/players differ by one joiner, and one player is not linked yet.
    f.game.overview.mockImplementation(async () => ({ ...afterLeavers(2, 1), unlinkedPlayerCount: 1 }));
    const started = await f.start();
    expect(started.created).toBe(true);
    // Provisional teams come from the current factions; each 50v50 round resolves its own.
    expect(f.store.create.mock.calls[0][0].options.teams).toHaveLength(2);
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("explains readiness, including the cooldown after the last voted 50v50", async () => {
    const f = voting();
    const overview = fullServerSnapshot();
    const config = { revision: "r1", fields: [lockField(true) as never] };
    const rounds = new GameRounds(fixtureServers(f.game));
    const track = rounds.observe("primary", overview).track;
    expect(await f.service.voteEventReadiness("primary", fifty, config, overview, track)).toEqual({ ok: true });
    // Staff-run events being on never readies a voted 50v50 the owner has not reviewed.
    f.environment.MAP_VOTES_FIFTY_ENABLED = false;
    expect(await f.service.voteEventReadiness("primary", fifty, config, overview, track)).toEqual({
      ok: false,
      reason: "voted 50v50 is held for the owner's in-person review",
    });
    f.environment.MAP_VOTES_FIFTY_ENABLED = true;
    const waiting = new GameRounds(fixtureServers(f.game)).observe("primary", preRoundSnapshot()).track;
    expect(await f.service.voteEventReadiness("primary", fifty, config, overview, waiting)).toEqual({
      ok: false,
      reason: "the server is waiting for players",
    });
    const unsaved = {
      ...overview,
      capabilities: {
        ...overview.capabilities,
        routes: overview.capabilities.routes.filter((route) => route !== "PUT /v1/config"),
      },
    };
    expect(await f.service.voteEventReadiness("primary", fifty, config, unsaved, track)).toEqual({
      ok: false,
      reason: "the game build does not advertise settings saves",
    });
    // With the lock already off, nothing needs saving.
    const off = { revision: "r1", fields: [lockField(false) as never] };
    expect(await f.service.voteEventReadiness("primary", fifty, off, unsaved, track)).toEqual({ ok: true });
    const fewer = fullServerSnapshot();
    fewer.players = fewer.players.slice(0, 64);
    fewer.status.players.current = 64;
    expect(await f.service.voteEventReadiness("primary", fifty, config, fewer, track)).toEqual({
      ok: false,
      reason: "64 of 80 players online",
    });
    expect(
      await f.service.voteEventReadiness("primary", { ...fifty, closedFaction: "Raiders" }, config, overview, track),
    ).toEqual({ ok: false, reason: "Raiders is not playing" });
    expect(
      await f.service.voteEventReadiness(
        "primary",
        { ...fifty, forceRespawn: true },
        config,
        {
          ...overview,
          capabilities: {
            ...overview.capabilities,
            routes: overview.capabilities.routes.filter((r) => !r.includes("kill")),
          },
        },
        track,
      ),
    ).toEqual({ ok: false, reason: "the game build does not advertise forced respawns" });
    // One normal round must have had a ballot since the last voted 50v50 finished.
    f.set({ ...voteEventFixture(), state: "complete", updatedAt: new Date(eventNow - 60_000) });
    const before = { roundId: "observed:1", createdAt: new Date(eventNow - 120_000) };
    expect(await f.service.voteEventReadiness("primary", fifty, config, overview, track, [before])).toEqual({
      ok: false,
      reason: "1 more normal round before 50v50 can return",
    });
    const after = { roundId: "observed:2", createdAt: new Date(eventNow - 30_000) };
    expect(await f.service.voteEventReadiness("primary", fifty, config, overview, track, [after, before])).toEqual({
      ok: true,
    });
  });
  it("runs a voted round from lock change to restore without staff, then ends by itself", async () => {
    const f = voting();
    await f.start();
    // Preparing (the ballot closed at 95 points in round N): switch the lock off, then announce.
    await f.service.tick();
    expect(actions(f)[0]).toMatchObject({
      action: "settings-save",
      revision: "r7",
      changes: { lockOverpopulated: false },
    });
    f.game.configuration.mockResolvedValue({ revision: "r8", fields: [lockField(false)] });
    jest.setSystemTime(eventNow + 5_000);
    await f.service.tick();
    expect(actions(f)[1]).toMatchObject({
      action: "broadcast",
      message:
        "Vote result: 50v50 next round on Zestafona. One team will be closed and its players moved at round start; wait for the team notice before buying.",
    });
    expect(f.current()?.state).toBe("waiting_round");
    // Round N+1 starts: scores reset, then the round settles.
    let scores: [number, number, number] = [0, 0, 0];
    f.game.overview.mockImplementation(async () => fullServerSnapshot(Date.now(), scores));
    jest.setSystemTime(eventNow + 10_000);
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(2);
    scores = [1, 0, 0];
    jest.setSystemTime(eventNow + 45_000);
    await f.service.tick();
    expect(actions(f)[2]).toMatchObject({ action: "broadcast", message: expect.stringContaining("50v50 round:") });
    expect(f.current()?.progress.roundsStarted).toBe(1);
    // The round reaches 100: the event stops, says so, restores the lock and completes.
    scores = [100, 60, 40];
    jest.setSystemTime(eventNow + 50_000);
    await f.service.tick();
    expect(f.current()?.stop).toMatchObject({
      actorId: "system:event-rounds",
      reason: "The voted 50v50 round(s) finished.",
    });
    jest.setSystemTime(eventNow + 55_000);
    await f.service.tick();
    expect(actions(f)[3]).toMatchObject({
      action: "broadcast",
      message: "50v50 is over: three teams again. Pick any team at your next respawn.",
    });
    jest.setSystemTime(eventNow + 60_000);
    await f.service.tick();
    expect(actions(f)[4]).toMatchObject({
      action: "settings-save",
      revision: "r8",
      changes: { lockOverpopulated: true },
    });
    expect(f.current()?.state).toBe("complete");
    expect(eventView(f.current()!)).toMatchObject({
      source: { kind: "vote", voteId: f.voteId },
      rounds: { planned: 1, started: 1 },
      closedFaction: null,
      endReason: "rounds",
    });
    expect(f.alerts.send).not.toHaveBeenCalled();
  });
  it("stops a voted 50v50 recorded before the owner's hold, before it switches the lock off", async () => {
    const f = fixture("primary", voteEventFixture);
    // Recorded at a ballot close while the flag was on; Gramps restarted with it off before preparing.
    f.environment.MAP_VOTES_FIFTY_ENABLED = false;
    f.set({ ...f.record, state: "preparing", progress: { ...f.record.progress, lockDisabledAt: undefined } });
    f.game.configuration.mockResolvedValue({ revision: "r4", fields: [lockField(true)] });
    await f.service.tick();
    expect(f.store.stop).toHaveBeenCalledWith(f.record.id, {
      id: expect.any(String),
      ...systemStops.halted,
      reason: "Voted 50v50 is held for the owner's in-person review.",
      at: new Date(eventNow).toISOString(),
    });
    // The lock still has its value from before the event: nothing to restore.
    expect(f.current()?.state).toBe("complete");
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.alerts.send).not.toHaveBeenCalled();
  });
  it("stops a running multi-round voted 50v50 under the owner's hold and only restores the lock", async () => {
    const f = fixture("primary", voteEventFixture);
    f.environment.MAP_VOTES_FIFTY_ENABLED = false;
    f.set({ ...f.record, options: { ...f.record.options, rounds: 3 } });
    await f.service.tick();
    expect(f.current()?.stop).toMatchObject({
      actorId: systemStops.halted.actorId,
      reason: "Voted 50v50 is held for the owner's in-person review.",
    });
    // The same pass puts the lock back; no team is sorted or player moved.
    expect(actions(f)).toEqual([
      expect.objectContaining({ action: "settings-save", changes: { lockOverpopulated: true } }),
    ]);
    expect(f.current()?.state).toBe("complete");
    expect(f.alerts.send).not.toHaveBeenCalled();
  });
  it("counts an unconfirmed move as moved and stops itself after an unknown result", async () => {
    const pending = fixture("primary", voteEventFixture);
    pending.admin.act.mockResolvedValue({
      state: "pending",
      changed: true,
      message: "Not shown yet",
      revision: undefined!,
    });
    await pending.service.tick();
    expect(pending.current()).toMatchObject({ state: "active", stop: null });
    expect(Object.keys(pending.current()!.progress.movedAt!)).toHaveLength(1);
    const unknown = fixture("primary", voteEventFixture);
    unknown.admin.act.mockResolvedValue({ state: "unknown", changed: true, message: "Lost", revision: undefined! });
    await unknown.service.tick();
    expect(unknown.current()).toMatchObject({ state: "stopping", stop: { actorId: "system:event-halt" } });
    expect(unknown.alerts.send).toHaveBeenCalledWith("primary", `event-halt:${unknown.record.id}`, expect.any(String));
    unknown.admin.act.mockResolvedValue({ state: "pending", changed: true, message: "Saved", revision: undefined! });
    jest.setSystemTime(eventNow + 5_000);
    await unknown.service.tick();
    expect(actions(unknown).at(-1)).toMatchObject({ changes: { lockOverpopulated: true } });
    expect(unknown.current()?.state).toBe("complete");
  });
  it("settles an interrupted action as unknown and restores the lock instead of waiting for staff", async () => {
    const f = fixture("primary", voteEventFixture);
    const move = operation(f.record, "move", { action: "team" });
    f.set({ ...f.record, operation: move, updatedAt: new Date(eventNow - 121_000) });
    await f.service.tick();
    expect(f.store.halt).toHaveBeenCalledWith(f.record.id, expect.any(String), move.id);
    expect(f.store.recover).not.toHaveBeenCalled();
    await f.service.tick();
    expect(actions(f)).toEqual([expect.objectContaining({ changes: { lockOverpopulated: true } })]);
    expect(f.current()?.state).toBe("complete");
  });
  it("stops itself and restores the lock after three refused moves in a row", async () => {
    const f = fixture("primary", voteEventFixture);
    f.admin.act.mockImplementation(async (_staff, action) =>
      (action as { action: string }).action === "team"
        ? { state: "failed", changed: false, message: "Refused", revision: undefined! }
        : { state: "applied", changed: true, message: "Confirmed", revision: "r3" },
    );
    for (let pass = 0; pass < 2; pass++) {
      jest.setSystemTime(eventNow + pass * 5_000);
      await f.service.tick();
      expect(f.current()).toMatchObject({ state: "active", stop: null, progress: { failures: pass + 1 } });
    }
    jest.setSystemTime(eventNow + 10_000);
    await f.service.tick();
    expect(f.current()).toMatchObject({ state: "stopping", stop: { actorId: "system:event-halt" } });
    expect(f.current()?.stop?.reason).toBe("Team moves were refused (3 attempts).");
    jest.setSystemTime(eventNow + 15_000);
    await f.service.tick();
    expect(actions(f).filter((action) => action.action === "team")).toHaveLength(3);
    expect(actions(f).at(-1)).toMatchObject({ action: "settings-save", changes: { lockOverpopulated: true } });
    expect(f.current()?.state).toBe("complete");
  });
  it("ends when staff switch the lock back on after Gramps confirmed it off, without switching it off again", async () => {
    const f = fixture("primary", voteEventFixture);
    // Gramps confirmed the lock off, then staff switched it on before the round was armed.
    f.set({ ...f.record, state: "preparing" });
    f.game.configuration.mockResolvedValue({ revision: "r4", fields: [lockField(true)] });
    await f.service.tick();
    expect(f.current()?.stop?.actorId).toBe("system:lock-changed");
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ state: "complete" });
  });
  it("stops itself when the team lock cannot be read for five minutes during the 50v50", async () => {
    const f = fixture("primary", voteEventFixture);
    f.game.configuration.mockResolvedValue({ revision: "r4", fields: [lockField(null)] });
    await f.service.tick();
    jest.setSystemTime(eventNow + 5 * 60_000 - 5_000);
    await f.service.tick();
    expect(f.current()).toMatchObject({ state: "active", stop: null });
    jest.setSystemTime(eventNow + 5 * 60_000);
    await f.service.tick();
    expect(f.current()).toMatchObject({ state: "stopping", stop: { actorId: "system:event-halt" } });
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("ends without a write when staff switch the team lock back on", async () => {
    const f = fixture("primary", voteEventFixture);
    f.game.configuration.mockResolvedValue({ revision: "r4", fields: [lockField(true)] });
    await f.service.tick();
    expect(f.current()?.stop?.actorId).toBe("system:lock-changed");
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ state: "complete" });
    expect(f.current()?.message).toContain("Staff had already switched the team lock back on");
  });
  it("retries switching the lock off after an unknown result, at most three times, then stops", async () => {
    const f = fixture("primary", voteEventFixture);
    f.set({ ...f.record, state: "preparing", progress: { ...f.record.progress, lockDisabledAt: undefined } });
    f.game.configuration.mockResolvedValue({ revision: "r4", fields: [lockField(true)] });
    f.admin.act.mockResolvedValue({ state: "unknown", changed: true, message: "Lost", revision: undefined! });
    for (let pass = 0; pass < 3; pass++) {
      jest.setSystemTime(eventNow + pass * 5_000);
      await f.service.tick();
      expect(f.current()?.state).toBe("preparing");
    }
    jest.setSystemTime(eventNow + 15_000);
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(3);
    expect(f.current()).toMatchObject({ state: "stopping", stop: { actorId: "system:event-halt" } });
    // The lock still reads on, which is its original value: nothing to restore.
    await f.service.tick();
    expect(f.current()?.state).toBe("complete");
    expect(f.admin.act).toHaveBeenCalledTimes(3);
  });
  it("treats an unconfirmed lock change that the saved setting shows as applied", async () => {
    const f = fixture("primary", voteEventFixture);
    f.set({ ...f.record, state: "preparing", progress: { ...f.record.progress, lockDisabledAt: undefined } });
    f.game.configuration.mockResolvedValue({ revision: "r4", fields: [lockField(true)] });
    f.admin.act.mockResolvedValueOnce({ state: "unknown", changed: true, message: "Lost", revision: undefined! });
    await f.service.tick();
    f.game.configuration.mockResolvedValue({ revision: "r5", fields: [lockField(false)] });
    jest.setSystemTime(eventNow + 5_000);
    await f.service.tick();
    expect(actions(f)[1]).toMatchObject({ action: "broadcast" });
    expect(f.current()?.progress.lockDisabledAt).toBe(eventNow + 5_000);
  });
  it("retries through a Discord outage instead of parking the event with the lock off", async () => {
    const f = fixture("primary", voteEventFixture);
    f.auth.serverStaff.mockRejectedValue(new ServiceUnavailableException("Discord is unavailable."));
    expect(await f.service.tick()).toBe(30_000);
    expect(f.current()).toMatchObject({ state: "active", stop: null, operation: null });
    expect(f.store.observe).not.toHaveBeenCalled();
    expect(f.alerts.send).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    // A refusal is lost access: that still needs another administrator.
    f.auth.serverStaff.mockRejectedValue(new ForbiddenException("Discord membership could not be verified."));
    jest.setSystemTime(eventNow + 5_000);
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
  });
  it("keeps working through a single failed access check soon after a confirmed one", async () => {
    const f = fixture("primary", voteEventFixture);
    f.set({
      ...f.record,
      stop: { id: randomUUID(), ...systemStops.rounds, reason: "Done", at: "" },
      state: "stopping",
    });
    f.set({ ...f.current()!, progress: { ...f.current()!.progress, endedAt: eventNow } });
    f.game.configuration.mockResolvedValue({ revision: "r9", fields: [lockField(false)] });
    // The first restore attempt is refused by the game; the access check that pass succeeds.
    f.admin.act.mockResolvedValueOnce({ state: "failed", changed: false, message: "Busy", revision: undefined! });
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
    // One Discord timeout a minute later: the restore retry still runs on the recent confirmation.
    f.auth.serverStaff.mockRejectedValueOnce(new ServiceUnavailableException("Discord is unavailable."));
    jest.setSystemTime(eventNow + 61_000);
    await f.service.tick();
    expect(actions(f).at(-1)).toMatchObject({ changes: { lockOverpopulated: true } });
    expect(f.current()?.state).toBe("complete");
  });
  it("keeps its state, rather than waiting for staff, when Gramps stops before sending", async () => {
    const f = fixture("primary", voteEventFixture);
    f.auth.role
      .mockImplementationOnce(async () => "admin")
      .mockImplementationOnce(async () => {
        f.service.onModuleDestroy();
        return "admin";
      });
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ state: "active", operation: null, stop: null });
  });
  it("keeps its round after a restart when the voting worker first sees the server", async () => {
    const f = fixture("primary", voteEventFixture);
    f.game.overview.mockImplementation(async () => clocklessSnapshotAt(Date.now()));
    const tracker = f.record.progress.tracker!;
    // The stored event round was observed without a clock.
    f.record.progress.tracker = { ...tracker, round: { ...tracker.round, id: "observed:1", source: "observed" } };
    f.record.progress.roundId = "observed:1";
    const restarted = f.make();
    // The vote worker's stale seed (an older ballot) leaves an unseeded baseline round.
    const rounds = (restarted as unknown as { rounds: GameRounds }).rounds;
    rounds.observe("primary", clocklessSnapshotAt(eventNow - 1_000), {
      seed: {
        round: {
          id: "observed:0",
          map: "Europe",
          index: 2,
          startedAt: eventNow - 3600_000,
          source: "observed",
          exact: true,
        },
        highest: 90,
      },
    });
    await restarted.tick();
    expect(f.current()?.stop).toBeNull();
    expect(rounds.current("primary")?.round.id).toBe("observed:1");
  });
});
