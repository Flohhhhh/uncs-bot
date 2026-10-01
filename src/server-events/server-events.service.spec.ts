import { randomUUID } from "node:crypto";
import { ServerEventsService } from "./server-events.service";
import { ServerEventsStore } from "./server-events.store";
import { fixtureServers } from "../admin/game-server-fixture";
import type { Staff } from "../admin/admin.types";
import { AdminService } from "../admin/admin.service";
import { AdminAuth } from "../admin/admin.auth";
import { EnvService } from "../env/env.service";
import { eventFixture, eventNow, eventStaff, snapshotAt } from "./event-fixtures";
import { operation } from "./event-planner";
import type { EventRecord } from "./server-events.types";

function fixture(serverId = "primary") {
  const record = eventFixture();
  record.serverId = serverId;
  let current: EventRecord | null = record;
  const store = {
    get: jest.fn(async () => current),
    current: jest.fn(async () => current),
    history: jest.fn(async () => (current ? [current] : [])),
    operations: jest.fn(async () => []),
    create: jest.fn(async (values) => {
      current = { ...record, ...values, state: "preparing", restoreRevision: null };
      return { created: true, event: current };
    }),
    claim: jest.fn(async (_id, _version, op, _actor, progress): Promise<EventRecord | null> => {
      current = {
        ...current!,
        operation: op,
        progress,
        state: op.kind === "restore_lock" ? "stopping" : current!.state,
      };
      return current;
    }),
    observe: jest.fn(async (_id, _version, update) => {
      current = { ...current!, ...update };
      return true;
    }),
    settle: jest.fn(async (_id, _op, _result, update) => {
      current = { ...current!, ...update, operation: null };
      return current;
    }),
    stop: jest.fn(async (_id, stop) => {
      current = { ...current!, stop, state: current!.state === "needs_review" ? "needs_review" : "stopping" };
      return current;
    }),
    completeUnchanged: jest.fn(async () => {
      current = { ...current!, state: "complete" };
      return current;
    }),
    recover: jest.fn(),
  };
  const game = {
    configuration: jest.fn(async () => ({
      revision: "r2",
      fields: [{ id: "lockOverpopulated", value: false, editable: true }],
    })),
    overview: jest.fn(async () => snapshotAt()),
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
    WARDOGS_RCON_URL: "https://game.example.test",
    ADMIN_GUILD_ID: record.guildId,
  };
  const service = new ServerEventsService(
    store as unknown as ServerEventsStore,
    fixtureServers(game, () => environment.WARDOGS_RCON_URL as string, serverId),
    admin as unknown as AdminService,
    auth as unknown as AdminAuth,
    { get: (key: string) => environment[key] } as EnvService,
  );
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
    store,
    game,
    admin,
    auth,
    environment,
    record,
    input,
    current: () => current,
    set: (value: EventRecord | null) => {
      current = value;
    },
  };
}

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
  it.each(["revision", "clock", "roster", "capability", "allowance"])(
    "rejects unsafe %s start conditions",
    async (kind) => {
      const f = fixture();
      f.set(null);
      if (kind === "revision") f.input.revision = "old";
      const snapshot = snapshotAt();
      if (kind === "clock") snapshot.status.matchSeconds = undefined;
      if (kind === "roster") snapshot.status.players.current = 20;
      if (kind === "capability") snapshot.capabilities.routes = [];
      if (kind === "allowance") snapshot.capabilities.limits!.maxRequestsPerMinutePerIp = 10;
      f.game.overview.mockResolvedValue(snapshot);
      await expect(f.service.start(eventStaff, f.input)).rejects.toThrow();
      expect(f.store.create).not.toHaveBeenCalled();
      expect(f.admin.act).not.toHaveBeenCalled();
    },
  );
  it("disables only the native team lock and retains its exact saved revision", async () => {
    const f = fixture();
    f.record.state = "preparing";
    f.record.restoreRevision = null;
    f.record.initialRevision = "r2";
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: `system:50v50:${f.record.id}` }),
      expect.objectContaining({ action: "settings-save", revision: "r2", changes: { lockOverpopulated: false } }),
    );
    expect(f.current()).toMatchObject({ state: "preparing", restoreRevision: "r2" });
  });
  it("requires review if the configuration save has no exact revision", async () => {
    const f = fixture();
    f.record.state = "preparing";
    f.record.restoreRevision = null;
    f.record.initialRevision = "r2";
    f.admin.act.mockResolvedValue({ state: "pending", changed: true, message: "Saved", revision: undefined! });
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
  });
  it("arms an event without moving anyone in its current round", async () => {
    const f = fixture();
    f.record.state = "preparing";
    await f.service.tick();
    expect(f.admin.act.mock.calls[0][1]).toMatchObject({ action: "broadcast" });
    expect(f.current()?.state).toBe("waiting_round");
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
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
    f.game.overview.mockResolvedValueOnce(snapshotAt()).mockResolvedValueOnce(snapshotAt(eventNow, 0));
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
  it("does not silently restore over intervening edits", async () => {
    const f = fixture();
    await f.service.stop(eventStaff, f.record.id, { id: randomUUID(), reason: "Finished event" });
    f.game.configuration.mockResolvedValue({
      revision: "changed",
      fields: [{ id: "lockOverpopulated", value: false, editable: true }],
    });
    await f.service.tick();
    expect(f.current()?.state).toBe("needs_review");
    expect(f.admin.act).not.toHaveBeenCalled();
    await f.service.restore(eventStaff, f.record.id, {
      id: randomUUID(),
      reason: "Reviewed newer settings",
      revision: "changed",
      confirm: "RESTORE TEAM LOCK",
    });
    expect(f.admin.act.mock.calls[0][1]).toMatchObject({
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
    expect(f.admin.act.mock.calls[0][1]).toMatchObject({
      action: "settings-save",
      changes: { lockOverpopulated: true },
    });
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
});
