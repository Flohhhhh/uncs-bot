import { createHash, randomUUID } from "node:crypto";
import { MapVotesService } from "./map-votes.service";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";
import { fixtureServers } from "../admin/game-server-fixture";
import { AdminService } from "../admin/admin.service";
import { AdminAuth } from "../admin/admin.auth";
import { EnvService } from "../env/env.service";
import type { Staff } from "../admin/admin.types";
import { ballotWinner, mapVoteView, type MapVoteRecord, type StartMapVote } from "./map-votes.types";

const staff: Staff = { id: "123456789012345678", name: "Test admin", role: "admin", csrf: "test" };
const guild = "234567890123456789",
  channel = "345678901234567890",
  messageId = "456789012345678901";
const now = new Date("2026-10-01T10:00:00Z");
function fixture(enabled = true, serverId = "primary") {
  const input: StartMapVote = {
    id: randomUUID(),
    serverId,
    revision: "r1",
    choices: [
      { map: "Europe", experiences: [] },
      { map: "Islands", experiences: [] },
    ],
    minutes: 5,
    reason: "Community choice",
  };
  const record: MapVoteRecord = {
    ...input,
    serverName: "The UNCs",
    connectionHash: createHash("sha256").update("https://game.example.test").digest("hex"),
    guildId: guild,
    channelId: channel,
    messageId,
    actorId: staff.id,
    actorName: staff.name,
    requestHash: "hash",
    currentMap: "Kavkazi",
    currentIndex: 0,
    roundStartedAt: new Date(now.getTime() - 600_000),
    createdAt: now,
    updatedAt: now,
    closesAt: now,
    state: "closing",
    winner: 1,
    counts: [1, 2],
    message: "Closing",
    cancellation: null,
  };
  const store = {
    get: jest.fn().mockResolvedValue(null),
    history: jest.fn().mockResolvedValue([record]),
    liveCounts: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (values) => ({
      created: true,
      record: { ...record, ...values, messageId: null, state: "publishing" },
    })),
    published: jest.fn().mockImplementation(async (id, messageId) => ({ ...record, id, messageId, state: "open" })),
    cast: jest.fn().mockResolvedValue(input.choices[0]),
    cancel: jest.fn().mockResolvedValue({ ...record, state: "cancelled" }),
    recover: jest.fn().mockResolvedValue([]),
    due: jest.fn().mockResolvedValue([record]),
    claimClose: jest.fn().mockResolvedValue(record),
    finish: jest.fn().mockImplementation(async (id, state, message) => ({ ...record, id, state, message })),
  };
  const game = {
    configuration: jest.fn().mockResolvedValue({
      revision: "r1",
      rotation: { editable: true, enabled: true, mode: "Ordered", currentMap: "Kavkazi", currentIndex: 0 },
    }),
    capabilities: jest.fn().mockResolvedValue({ endpoints: [] }),
    catalog: jest
      .fn()
      .mockResolvedValue({ maps: [{ id: "Europe" }, { id: "Islands" }], experiences: [], lightings: [] }),
    overview: jest.fn().mockResolvedValue({
      observedAt: now.toISOString(),
      status: { serverName: "The UNCs", map: "Kavkazi", matchSeconds: 600 },
    }),
  };
  const admin = { act: jest.fn().mockResolvedValue({ state: "pending", message: "Saved" }) };
  const role = jest.fn().mockResolvedValue("admin");
  const auth = {
    role,
    serverStaff: jest.fn(async (actor: Staff, serverId: string) => ({
      ...actor,
      serverId,
      serverVersion: "0".repeat(64),
      role: await role(),
    })),
  };
  const discord = { check: jest.fn(), publish: jest.fn().mockResolvedValue(messageId), update: jest.fn() };
  const environment: Record<string, unknown> = {
    MAP_VOTES_ENABLED: enabled,
    WARDOGS_RCON_URL: "https://game.example.test",
    ADMIN_GUILD_ID: guild,
    MAP_VOTES_CHANNEL_ID: channel,
  };
  const service = new MapVotesService(
    store as unknown as MapVotesStore,
    fixtureServers(game, () => environment.WARDOGS_RCON_URL as string, serverId),
    admin as unknown as AdminService,
    auth as unknown as AdminAuth,
    discord as unknown as MapVotesDiscord,
    { get: (key: string) => environment[key] } as EnvService,
  );
  const closing = () => store.get.mockResolvedValue(record);
  return { service, store, game, admin, auth, discord, input, record, closing };
}

describe("durable Discord map voting", () => {
  it("reports current open-ballot totals without closing, publishing or touching the game", async () => {
    const { service, store, record, game, discord, admin } = fixture(true, "event");
    store.history.mockResolvedValue([{ ...record, state: "open", winner: null, counts: [0, 0] }]);
    store.liveCounts.mockResolvedValue([
      { voteId: record.id, choice: 0, total: 4 },
      { voteId: record.id, choice: 1, total: 2 },
    ]);
    const result = await service.list({ ...staff, serverId: "event" });
    expect(store.history).toHaveBeenCalledWith("event");
    expect(store.liveCounts).toHaveBeenCalledWith([record.id]);
    expect(result.votes[0]).toMatchObject({ state: "open", counts: [4, 2], counted: true, winner: null });
    expect(result.observedAt).toBe(now.toISOString());
    expect(game.overview).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
    expect(discord.publish).not.toHaveBeenCalled();
  });
  it("does not replace an unreadable live tally with zero votes", async () => {
    const { service, store, record } = fixture();
    store.history.mockResolvedValue([{ ...record, state: "open" }]);
    store.liveCounts.mockRejectedValue(new Error("Database unavailable"));
    await expect(service.list(staff)).rejects.toThrow("Database unavailable");
  });
  it("closes a non-primary ballot using that server and fresh server-specific authority", async () => {
    const { service, closing, admin, auth, store } = fixture(true, "event");
    closing();
    await service.tick();
    expect(auth.serverStaff).toHaveBeenCalledWith(expect.objectContaining({ id: staff.id }), "event", true);
    expect(admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "event", serverVersion: "0".repeat(64) }),
      expect.objectContaining({ action: "map-next" }),
    );
    expect(store.finish).toHaveBeenCalledWith(expect.any(String), "queued", expect.any(String));
  });
  it("rejects another server's ballot before cancellation or replay", async () => {
    const { service, store, record, input } = fixture();
    store.get.mockResolvedValue({ ...record, serverId: "event" });
    await expect(service.cancel(staff, record.id, { id: randomUUID(), reason: "Close ballot" })).rejects.toThrow(
      "selected server",
    );
    await expect(service.start(staff, input)).rejects.toThrow("different request");
    expect(store.cancel).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it("does not touch storage, Discord or the game while disabled", async () => {
    const { service, store, game, discord, input } = fixture(false);
    expect(await service.list(staff)).toMatchObject({ enabled: false, serverId: "primary", votes: [] });
    await expect(service.start(staff, input)).rejects.toMatchObject({ status: 503 });
    service.onApplicationBootstrap();
    await service.tick();
    service.onModuleDestroy();
    expect(store.history).not.toHaveBeenCalled();
    expect(store.liveCounts).not.toHaveBeenCalled();
    expect(store.due).not.toHaveBeenCalled();
    expect(game.configuration).not.toHaveBeenCalled();
    expect(discord.publish).not.toHaveBeenCalled();
  });
  it.each(["viewer", "moderator"] as const)("rejects %s on every staff route", async (role) => {
    const { service, input, store } = fixture();
    await expect(service.list({ ...staff, role })).rejects.toMatchObject({ status: 403 });
    await expect(service.start({ ...staff, role }, input)).rejects.toMatchObject({ status: 403 });
    await expect(
      service.cancel({ ...staff, role }, input.id, { id: randomUUID(), reason: "Close vote" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.get).not.toHaveBeenCalled();
  });
  it.each([
    { serverId: "other" },
    { minutes: 1 },
    { minutes: 31 },
    { minutes: 2.5 },
    { reason: "x\ny" },
    { choices: [{ map: "Europe", experiences: [] }] },
    {
      choices: [
        { map: "Europe", experiences: [] },
        { map: "Europe", experiences: ["Hardcore"] },
      ],
    },
    { extra: true },
  ])("rejects malformed or ambiguous ballots: %j", async (patch) => {
    const { service, input, store, game } = fixture();
    await expect(service.start(staff, { ...input, ...patch })).rejects.toMatchObject({ status: 400 });
    expect(store.create).not.toHaveBeenCalled();
    expect(game.configuration).not.toHaveBeenCalled();
  });
  it("validates maps and the round, saves intent before publishing and never changes the game when starting", async () => {
    const { service, input, store, discord, admin } = fixture();
    expect(await service.start(staff, input)).toMatchObject({
      id: input.id,
      state: "open",
      messageUrl: `https://discord.com/channels/${guild}/${channel}/${messageId}`,
    });
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: staff.id,
        closesAt: new Date(now.getTime() + 300_000),
        roundStartedAt: new Date(now.getTime() - 600_000),
      }),
    );
    expect(store.create.mock.invocationCallOrder[0]).toBeLessThan(discord.publish.mock.invocationCallOrder[0]);
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("replays an exact start receipt without sending another message", async () => {
    const { service, input, store, discord, game } = fixture();
    await service.start(staff, input);
    store.get.mockResolvedValue(store.create.mock.calls[0][0]);
    const before = game.configuration.mock.calls.length;
    await service.start(staff, input);
    expect(discord.publish).toHaveBeenCalledTimes(1);
    expect(game.configuration).toHaveBeenCalledTimes(before);
    await expect(service.start(staff, { ...input, minutes: 10 })).rejects.toMatchObject({ status: 409 });
    await expect(service.start({ ...staff, id: "999999999999999999" }, input)).rejects.toMatchObject({ status: 409 });
  });
  it("honors the store's concurrent-create winner", async () => {
    const { service, input, store, record, discord } = fixture();
    store.create.mockResolvedValue({ created: false, record });
    await service.start(staff, input);
    expect(discord.publish).not.toHaveBeenCalled();
  });
  it.each(["configuration", "clock", "current", "catalog", "storage", "channel"])(
    "does not publish when %s validation fails",
    async (failure) => {
      const { service, input, store, game, discord } = fixture();
      if (failure === "configuration") input.revision = "old";
      if (failure === "clock")
        game.overview.mockResolvedValue({
          observedAt: "bad",
          status: { serverName: "Test", map: "Kavkazi", matchSeconds: 0 },
        });
      if (failure === "current") input.choices[0].map = "Kavkazi";
      if (failure === "catalog") input.choices[0].map = "NotReal";
      if (failure === "storage") store.create.mockRejectedValue(new Error("DB down"));
      if (failure === "channel") discord.check.mockRejectedValue(new Error("No permission"));
      await expect(service.start(staff, input)).rejects.toThrow();
      expect(discord.publish).not.toHaveBeenCalled();
    },
  );
  it.each(["send", "save"])("records uncertain publication after a %s failure without retrying", async (failure) => {
    const { service, input, store, discord } = fixture();
    if (failure === "send") discord.publish.mockRejectedValue(new Error("secret token upstream"));
    else store.published.mockRejectedValue(new Error("DB failed"));
    const result = await service.start(staff, input);
    expect(result.state).toBe("needs_review");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(discord.publish).toHaveBeenCalledTimes(1);
  });
  it("checks guild, screening, user ID and button range before saving", async () => {
    const { service, input, store } = fixture();
    for (const [id, choice, userId, guildId, eligible] of [
      [input.id, "0", staff.id, guild, false],
      [input.id, "0", staff.id, "other", true],
      [input.id, "5", staff.id, guild, true],
      ["bad", "0", staff.id, guild, true],
      [input.id, "0", "bad", guild, true],
    ] as const)
      await expect(service.cast(id, choice, userId, guildId, channel, messageId, eligible)).rejects.toThrow();
    expect(store.cast).not.toHaveBeenCalled();
    await service.cast(input.id, "1", staff.id, guild, channel, messageId, true);
    expect(store.cast).toHaveBeenCalledWith(input.id, staff.id, 1, guild, channel, messageId);
  });
  it("claims closure and uses the existing audited next-map path once", async () => {
    const { service, store, closing, admin, auth, input } = fixture();
    closing();
    await service.tick();
    store.claimClose.mockResolvedValue(null);
    await service.tick();
    expect(auth.serverStaff).toHaveBeenCalledWith(expect.objectContaining({ id: staff.id }), "primary", true);
    expect(admin.act).toHaveBeenCalledTimes(1);
    expect(admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: staff.id, role: "admin" }),
      expect.objectContaining({
        id: input.id,
        action: "map-next",
        entry: input.choices[1],
        currentMap: "Kavkazi",
        currentIndex: 0,
        revision: "r1",
      }),
    );
    expect(store.finish).toHaveBeenCalledWith(input.id, "queued", expect.any(String));
  });
  it("retains the rotation without game or role reads when nobody voted", async () => {
    const { service, store, record, admin, game, auth } = fixture();
    store.claimClose.mockResolvedValue({ ...record, winner: null, counts: [0, 0] });
    await service.tick();
    expect(admin.act).not.toHaveBeenCalled();
    expect(game.overview).not.toHaveBeenCalled();
    expect(auth.role).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(record.id, "no_votes", expect.any(String));
  });
  it.each([
    "role",
    "new_round",
    "new_map",
    "no_clock",
    "invalid_time",
    "recovered",
    "shutdown",
    "endpoint",
    "guild",
    "channel",
  ])("stops automatic queueing after %s", async (failure) => {
    const { service, store, closing, game, auth, admin, record } = fixture();
    closing();
    if (failure === "role") auth.role.mockResolvedValue("viewer");
    if (failure === "endpoint") record.connectionHash = "different endpoint";
    if (failure === "guild") record.guildId = "different guild";
    if (failure === "channel") record.channelId = "different channel";
    if (failure === "new_round")
      game.overview.mockResolvedValue({
        observedAt: now.toISOString(),
        status: { serverName: "Test", map: "Kavkazi", matchSeconds: 2 },
      });
    if (failure === "new_map")
      game.overview.mockResolvedValue({
        observedAt: now.toISOString(),
        status: { serverName: "Test", map: "Europe", matchSeconds: 600 },
      });
    if (failure === "no_clock") record.roundStartedAt = null;
    if (failure === "invalid_time")
      game.overview.mockResolvedValue({
        observedAt: "bad",
        status: { serverName: "Test", map: "Kavkazi", matchSeconds: 600 },
      });
    if (failure === "recovered") store.get.mockResolvedValue({ ...record, state: "needs_review" });
    if (failure === "shutdown")
      auth.role.mockImplementation(async () => {
        service.onModuleDestroy();
        return "admin";
      });
    await service.tick();
    expect(admin.act).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(record.id, "needs_review", expect.any(String));
  });
  it.each(["unknown", "failed", "accepted"])("does not claim queueing for an %s action receipt", async (state) => {
    const { service, closing, store, admin, input } = fixture();
    closing();
    admin.act.mockResolvedValue({ state, message: "Check receipt" });
    await service.tick();
    expect(store.finish).toHaveBeenCalledWith(input.id, "needs_review", "Check receipt");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it("recovers interrupted work without resending publication or a game change", async () => {
    const { service, store, discord, admin, record } = fixture();
    store.due.mockResolvedValue([]);
    store.recover.mockResolvedValue([{ ...record, state: "needs_review" }]);
    await service.tick();
    expect(discord.update).toHaveBeenCalled();
    expect(discord.publish).not.toHaveBeenCalled();
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("does not start a side effect when shutdown occurs during its final database check", async () => {
    const starting = fixture();
    starting.store.create.mockImplementation(async (input) => {
      starting.service.onModuleDestroy();
      return { created: true, record: { ...starting.record, ...input } };
    });
    expect((await starting.service.start(staff, starting.input)).state).toBe("needs_review");
    expect(starting.discord.publish).not.toHaveBeenCalled();
    const closing = fixture();
    closing.store.get.mockImplementation(async () => {
      closing.service.onModuleDestroy();
      return closing.record;
    });
    await closing.service.tick();
    expect(closing.admin.act).not.toHaveBeenCalled();
  });
  it("records the cancelling administrator and request identity without a game action", async () => {
    const { service, store, input, admin, closing } = fixture();
    closing();
    const id = randomUUID();
    await service.cancel(staff, input.id, { id, reason: "Event changed" });
    expect(store.cancel).toHaveBeenCalledWith(input.id, id, staff, "Event changed");
    expect(admin.act).not.toHaveBeenCalled();
  });
  it("keeps private hashes, channel metadata and voter identities out of staff JSON", () => {
    const { record } = fixture();
    const view = mapVoteView(record);
    expect(view).not.toHaveProperty("requestHash");
    expect(view).not.toHaveProperty("connectionHash");
    expect(view).not.toHaveProperty("guildId");
    expect(view).not.toHaveProperty("actorId");
  });
  it("uses the displayed tie rule and never declares a zero-vote winner", () => {
    expect(ballotWinner([0, 0])).toBeNull();
    expect(ballotWinner([2, 2, 1])).toBe(0);
    expect(ballotWinner([0, 4, 4])).toBe(1);
  });
});
