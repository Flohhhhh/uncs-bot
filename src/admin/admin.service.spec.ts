import { randomUUID } from "node:crypto";
import { AdminService } from "./admin.service";
import { AdminStore } from "./admin.store";
import { RconError } from "./wardogs.client";
import { fixtureServers } from "./game-server-fixture";
import type { Staff } from "./admin.types";
import { bansSchema } from "./admin.types";
const staff: Staff = { id: "123456789012345678", name: "Admin", role: "admin", csrf: "csrf" };
const input = () => ({
  id: randomUUID(),
  action: "ban",
  steamId: "76561198123456789",
  confirm: "76561198123456789",
  reason: "Repeated abuse",
});
function fixture() {
  const game = { execute: jest.fn().mockResolvedValue({ state: "applied", message: "Ban confirmed" }) };
  const store = {
    begin: jest.fn().mockResolvedValue({ created: true }),
    finish: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminService(fixtureServers(game), store as unknown as AdminStore);
  return { game, store, service };
}
describe("staff action safeguards", () => {
  it("distinguishes unreadable game data from a database outage without exposing response contents", async () => {
    const parsed = bansSchema.safeParse({ bans: "private upstream data" });
    const game = { bans: jest.fn().mockRejectedValue(parsed.error) };
    const service = new AdminService(fixtureServers(game), {} as AdminStore);
    await expect(service.read("bans")).rejects.toThrow("The game returned data this dashboard could not read");
  });
  it("enforces permissions and target confirmation before recording or sending", async () => {
    const { service, game, store } = fixture();
    await expect(service.act({ ...staff, role: "viewer" }, input())).rejects.toThrow("staff role");
    await expect(service.act(staff, { ...input(), confirm: "76561198066952872" })).rejects.toThrow("does not match");
    await expect(service.act(staff, { ...input(), steamId: "bad-id", confirm: "bad-id" })).rejects.toThrow("SteamID64");
    await expect(
      service.act(
        { ...staff, role: "moderator" },
        { id: randomUUID(), action: "whitelist-add", steamId: "76561198123456789", reason: "Member" },
      ),
    ).rejects.toThrow("staff role");
    expect(game.execute).not.toHaveBeenCalled();
    expect(store.begin).not.toHaveBeenCalled();
  });
  it("fails closed when the initial audit record cannot be saved", async () => {
    const { service, game, store } = fixture();
    store.begin.mockRejectedValue(new Error("DB offline"));
    await expect(service.act(staff, input())).rejects.toThrow("nothing was sent");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("does not execute an already recorded request twice", async () => {
    const { service, game, store } = fixture();
    store.begin.mockImplementation(async (_staff, action, requestHash) => ({
      created: false,
      record: { actorId: staff.id, requestHash, state: "applied", message: "Ban confirmed", id: action.id },
    }));
    expect((await service.act(staff, input())).state).toBe("applied");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("does not replay an unfinished action after a crash", async () => {
    const { service, game, store } = fixture();
    store.begin.mockImplementation(async (_staff, _action, requestHash) => ({
      created: false,
      record: { actorId: staff.id, requestHash, state: "started" },
    }));
    expect((await service.act(staff, input())).state).toBe("unknown");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("rejects reuse of an action ID with a different request", async () => {
    const { service, game, store } = fixture();
    store.begin.mockResolvedValue({ created: false, record: { actorId: staff.id, requestHash: "different" } });
    await expect(service.act(staff, input())).rejects.toThrow("different request");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("records uncertain outcomes without another game request", async () => {
    const { service, game, store } = fixture();
    game.execute.mockRejectedValue(new RconError("Lost response", true));
    expect((await service.act(staff, input())).state).toBe("unknown");
    expect(store.finish).toHaveBeenCalledWith(expect.any(String), { state: "unknown", message: "Lost response" });
    expect(game.execute).toHaveBeenCalledTimes(1);
  });
  it("does not claim a completed audit if the final write fails", async () => {
    const { service, game, store } = fixture();
    store.finish.mockRejectedValue(new Error("DB offline"));
    expect((await service.act(staff, input())).state).toBe("unknown");
    expect(game.execute).toHaveBeenCalledTimes(1);
  });
});
describe("whitelist removal notifications", () => {
  const removal = () => ({
    id: randomUUID(),
    action: "whitelist-remove",
    steamId: "76561198123456789",
    confirm: "76561198123456789",
    reason: "Removed on the Whitelist page",
  });
  it.each(["applied", "pending"] as const)("announces a %s removal after its receipt is saved", async (state) => {
    const { service, game, store } = fixture();
    game.execute.mockResolvedValue({ state, message: "Removed" });
    const events: unknown[] = [];
    let savedBeforeEvent = 0;
    service.whitelistRemovals.subscribe((event) => {
      savedBeforeEvent = store.finish.mock.calls.length;
      events.push(event);
    });
    const action = removal();
    await service.act(staff, action);
    expect(events).toEqual([
      {
        serverId: "primary",
        steamId: action.steamId,
        actionId: action.id,
        actorId: staff.id,
        actorName: staff.name,
        state,
      },
    ]);
    expect(savedBeforeEvent).toBe(1);
  });
  it("announces nothing for a refused, uncertain or unsaved removal, or for a grant", async () => {
    const { service, game, store } = fixture();
    const events: unknown[] = [];
    service.whitelistRemovals.subscribe((event) => events.push(event));
    // Separate staff members avoid the one-second courtesy limit between actions.
    const actor = (index: number) => ({ ...staff, id: `12345678901234567${index}` });
    game.execute.mockResolvedValueOnce({ state: "failed", message: "Refused" });
    await service.act(actor(1), removal());
    game.execute.mockRejectedValueOnce(new RconError("Lost response", true));
    await service.act(actor(2), removal());
    store.finish.mockRejectedValueOnce(new Error("DB offline"));
    await service.act(actor(3), removal());
    game.execute.mockResolvedValueOnce({ state: "applied", message: "Added" });
    await service.act(actor(4), {
      id: randomUUID(),
      action: "whitelist-add",
      steamId: "76561198123456789",
      reason: "Member",
    });
    expect(events).toEqual([]);
  });
});

describe("a person queuing the entry that is already next", () => {
  const queue = () => ({
    id: randomUUID(),
    action: "map-next",
    reason: "Keep the next map",
    revision: "r1",
    currentIndex: 0,
    currentMap: "Kavkazi",
    entry: { map: "Europe", experiences: [] },
  });
  const alreadyNext = {
    state: "applied",
    changed: false,
    message: "This entry is already next in the rotation. No change was sent.",
  };
  function queued() {
    const f = fixture();
    f.game.execute.mockResolvedValue(alreadyNext);
    const listener = jest.fn(async (_staff: Staff, _serverId: string): Promise<string | null> => "Ballot closed.");
    f.service.onUnchangedQueue(listener);
    return { ...f, listener };
  }
  it("lets map votes close the open ballot and tells the staff member", async () => {
    const f = queued();
    const result = await f.service.act(staff, queue());
    expect(f.listener).toHaveBeenCalledWith(staff, "primary");
    expect(result).toMatchObject({
      state: "applied",
      changed: false,
      message: "This entry is already next in the rotation. No change was sent. Ballot closed.",
    });
    // The audit keeps the game's own result.
    expect(f.store.finish).toHaveBeenCalledWith(expect.any(String), alreadyNext);
  });
  it("keeps the game result when the listener fails", async () => {
    const f = queued();
    f.listener.mockRejectedValue(new Error("DB offline"));
    expect(await f.service.act(staff, queue())).toMatchObject(alreadyNext);
  });
  it("leaves ballots alone for Gramps' own queue changes, changed rotations and other actions", async () => {
    const own = queued();
    await own.service.act({ ...staff, id: "system:map-vote:primary" }, queue());
    const changed = queued();
    changed.game.execute.mockResolvedValue({ state: "pending", message: "Saved" });
    await changed.service.act(staff, queue());
    const other = queued();
    await other.service.act(staff, input());
    for (const f of [own, changed, other]) expect(f.listener).not.toHaveBeenCalled();
  });
});

describe("kick and ban records", () => {
  const player = "76561198123456789";
  const kick = () => ({ id: randomUUID(), action: "kick", steamId: player, reason: "Team killing" });
  // Separate staff members avoid the one-second courtesy limit between actions.
  const actor = (index: number) => ({ ...staff, id: `12345678901234567${index}` });

  it("keeps the player's name from the last roster read with a kick or ban, without asking the game", async () => {
    const { service, game, store } = fixture();
    const rosterName = jest.fn((steamId: string) => (steamId === player ? "  Griefer  " : undefined));
    Object.assign(game, { rosterName });
    await service.act(actor(1), kick());
    await service.act(actor(2), input());
    await service.act(actor(3), { ...kick(), action: "message", message: "Please stop" });
    expect(store.begin.mock.calls.map((call) => call.length)).toEqual([4, 4, 3]);
    expect(store.begin.mock.calls.map((call) => call[3])).toEqual(["Griefer", "Griefer", undefined]);
    expect(rosterName).toHaveBeenCalledTimes(2);
    expect(game.execute).toHaveBeenCalledTimes(3);
  });

  it("records a kick without a name when the roster has none or cannot be read", async () => {
    const { service, game, store } = fixture();
    await service.act(actor(1), kick());
    Object.assign(game, { rosterName: () => "x".repeat(100) });
    await service.act(actor(2), kick());
    expect(store.begin.mock.calls[0]).toHaveLength(3);
    expect(store.begin.mock.calls[1][3]).toBe("x".repeat(64));
    expect(game.execute).toHaveBeenCalledTimes(2);
  });

  function readFixture() {
    const record = { count: 3, recent: 2, lastAt: new Date(), lastBy: "Mod", lastReason: "Team killing" };
    const store = {
      moderationSummaries: jest
        .fn()
        .mockResolvedValue(new Map([[player, { name: "Griefer", kicks: record, bans: null }]])),
      moderationEntries: jest.fn().mockResolvedValue([{ id: "entry" }]),
      repeatOffenders: jest.fn().mockResolvedValue([{ steamId: player, name: "Griefer", kicks: record }]),
    };
    return { record, store, service: new AdminService(fixtureServers({}), store as unknown as AdminStore) };
  }

  it("reads one player's record on the selected server for the player panel", async () => {
    const { record, store, service } = readFixture();
    await expect(service.moderation(player)).resolves.toEqual({
      kicks: record,
      bans: null,
      entries: [{ id: "entry" }],
    });
    expect(store.moderationSummaries).toHaveBeenCalledWith("primary", [player]);
    expect(store.moderationEntries).toHaveBeenCalledWith("primary", player);
    store.moderationSummaries.mockResolvedValue(new Map());
    await expect(service.moderation(player)).resolves.toMatchObject({ kicks: null, bans: null });
  });

  it("refuses an invalid SteamID and reports a failed read without its details", async () => {
    const { store, service } = readFixture();
    await expect(service.moderation("../audit")).rejects.toThrow("17-digit SteamID64");
    expect(store.moderationSummaries).not.toHaveBeenCalled();
    store.moderationEntries.mockRejectedValue(new Error("connection refused at 10.0.0.5"));
    await expect(service.moderation(player)).rejects.toThrow(
      "Kick and ban history could not be loaded. Try again shortly.",
    );
  });

  it("lists players kicked twice or more in the last 30 days", async () => {
    jest.useFakeTimers().setSystemTime(Date.parse("2026-10-05T12:00:00Z"));
    try {
      const { store, service } = readFixture();
      await expect(service.repeatOffenders()).resolves.toMatchObject({
        minimum: 2,
        days: 30,
        players: [{ steamId: player }],
      });
      expect(store.repeatOffenders).toHaveBeenCalledWith("primary", new Date("2026-09-05T12:00:00Z"), 2);
      store.repeatOffenders.mockRejectedValue(new Error("DB offline"));
      await expect(service.repeatOffenders()).rejects.toThrow("Repeat offenders could not be loaded.");
    } finally {
      jest.useRealTimers();
    }
  });
});
