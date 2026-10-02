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
import { automaticMapVotes } from "../common/map-vote-automation";

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
      rotation: {
        editable: true,
        enabled: true,
        mode: "Ordered",
        currentMap: "Kavkazi",
        currentIndex: 0 as number | null,
        entries: [
          { map: "Kavkazi", experiences: [] },
          { map: "Europe", experiences: [] },
          { map: "Islands", experiences: [] },
        ],
      },
    }),
    checkRotation: jest.fn().mockResolvedValue({
      revision: "r1",
      total: 3,
      issues: [] as { index: number; unavailable: boolean; message: string }[],
    }),
    capabilities: jest.fn().mockResolvedValue({ routes: [] as string[] }),
    request: jest.fn().mockResolvedValue({ alternators: [{ tag: "Zone.Farmland" }] }),
    catalog: jest
      .fn()
      .mockResolvedValue({ maps: [{ id: "Europe" }, { id: "Islands" }], experiences: [], lightings: [] }),
    overview: jest.fn().mockResolvedValue({
      observedAt: now.toISOString(),
      status: { serverName: "The UNCs", map: "Kavkazi", matchSeconds: 600 as number | undefined },
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
  return { service, store, game, admin, auth, discord, input, record, closing, environment };
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
  it("excludes the running map when status uses its in-game name and the ballot uses its catalog ID", async () => {
    const { service, input, game, store, discord } = fixture();
    const settings = await game.configuration();
    game.configuration.mockResolvedValue({ ...settings, rotation: { ...settings.rotation, currentMap: "Ozeti" } });
    const overview = await game.overview();
    game.overview.mockResolvedValue({ ...overview, status: { ...overview.status, map: "Ozeti" } });
    await expect(service.start(staff, input)).rejects.toThrow("Leave the current map out");
    expect(store.create).not.toHaveBeenCalled();
    expect(discord.publish).not.toHaveBeenCalled();
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
    "lost_clock",
    "invalid_time",
    "recovered",
    "shutdown",
    "endpoint",
    "guild",
    "channel",
    "position",
    "staff_override",
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
    if (failure === "lost_clock")
      game.overview.mockResolvedValue({
        observedAt: now.toISOString(),
        status: { serverName: "Test", map: "Kavkazi", matchSeconds: undefined },
      });
    if (failure === "position" || failure === "staff_override") {
      const snapshot = await game.configuration();
      game.configuration.mockResolvedValue({
        ...snapshot,
        revision: failure === "staff_override" ? "r2" : "r1",
        rotation: { ...snapshot.rotation, currentIndex: failure === "position" ? 1 : 0 },
      });
    }
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
    if (failure === "recovered") expect(store.finish).not.toHaveBeenCalled();
    else expect(store.finish).toHaveBeenCalledWith(record.id, "cancelled", expect.any(String));
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
    expect(ballotWinner([2, 2, 1])).toBeNull();
    expect(ballotWinner([0, 4, 4])).toBeNull();
    expect(ballotWinner([0, 5, 4])).toBe(1);
  });
  it("uses a confirmed rotation position without inventing a missing clock", async () => {
    const f = fixture();
    f.game.overview.mockResolvedValue({
      observedAt: now.toISOString(),
      status: { serverName: "Test", map: "Kavkazi", matchSeconds: undefined },
    });
    await f.service.start(staff, f.input);
    expect(f.store.create.mock.calls[0][0].roundStartedAt).toBeNull();
    f.record.roundStartedAt = null;
    f.closing();
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "queued", expect.any(String));
  });
  it("keeps the saved rotation on a tie without calling game or authority providers", async () => {
    const f = fixture();
    f.record.winner = null;
    f.record.counts = [2, 2];
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.game.configuration).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "tied", expect.stringContaining("left unchanged"));
  });

  function automatic(serverId = "primary") {
    const f = fixture(true, serverId);
    f.environment.MAP_VOTES_AUTOMATIC = automaticMapVotes.parse([{ serverId, actorId: staff.id }]);
    f.store.due.mockResolvedValue([]);
    f.store.history.mockResolvedValue([]);
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: { serverName: "Test", map: "Kavkazi", matchSeconds: undefined },
    }));
    f.store.published.mockImplementation(async (id, messageId) => {
      const record = { ...f.record, ...f.store.create.mock.calls.at(-1)![0], id, messageId, state: "open" as const };
      f.store.history.mockResolvedValue([record]);
      return record;
    });
    return f;
  }
  async function observeForWindow(f: ReturnType<typeof automatic>) {
    await f.service.tick();
    for (let i = 0; i < 4; i++) {
      jest.setSystemTime(Date.now() + 30_000);
      await f.service.tick();
    }
  }
  it("opens an automatic ballot from validated rotation entries for the explicit server, without a game write", async () => {
    const f = automatic("event");
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "event", roundStartedAt: null, choices: f.input.choices }),
      null,
    );
    expect(f.auth.serverStaff).toHaveBeenCalledWith(expect.objectContaining({ id: staff.id }), "event", true);
    expect(f.admin.act).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    const status = await f.service.list({ ...staff, serverId: "event" });
    expect(status.automatic).toMatchObject({ enabled: true, minutes: 5 });
    expect(JSON.stringify(status.automatic)).not.toContain(staff.id);
  });
  it.each(["queued", "cancelled", "tied", "no_votes"] as const)(
    "does not reopen after %s at the same position, including after a bot restart",
    async (state) => {
      const f = automatic();
      f.store.history.mockResolvedValue([{ ...f.record, roundStartedAt: null, state }]);
      await observeForWindow(f);
      expect(f.discord.publish).not.toHaveBeenCalled();
    },
  );
  it.each(["storage", "role", "catalog", "unknown-position", "too-few-maps", "changed-before-publish"])(
    "does not automatically publish when %s is unavailable",
    async (failure) => {
      const f = automatic();
      if (failure === "storage") f.store.history.mockRejectedValue(new Error("offline"));
      if (failure === "role") f.auth.role.mockResolvedValue("viewer");
      if (failure === "catalog")
        f.game.checkRotation.mockResolvedValue({
          revision: "r1",
          total: 3,
          issues: [{ index: 1, unavailable: false, message: "Read failed" }],
        });
      if (failure === "unknown-position" || failure === "too-few-maps") {
        const settings = await f.game.configuration();
        f.game.configuration.mockResolvedValue({
          ...settings,
          rotation: {
            ...settings.rotation,
            currentIndex: failure === "unknown-position" ? null : 0,
            entries: failure === "too-few-maps" ? settings.rotation.entries.slice(0, 2) : settings.rotation.entries,
          },
        });
      }
      if (failure === "changed-before-publish")
        f.auth.role.mockImplementation(async () => {
          const settings = await f.game.configuration();
          f.game.configuration.mockResolvedValue({ ...settings, rotation: { ...settings.rotation, currentIndex: 1 } });
          return "admin";
        });
      await observeForWindow(f);
      expect(f.discord.publish).not.toHaveBeenCalled();
      expect(f.admin.act).not.toHaveBeenCalled();
    },
  );
  it("requires a fresh continuous observation window after a read gap", async () => {
    const f = automatic();
    await f.service.tick();
    jest.setSystemTime(Date.now() + 180_000);
    await f.service.tick();
    expect(f.discord.publish).not.toHaveBeenCalled();
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
  });
  it("opens the next automatic ballot after the verified rotation position advances", async () => {
    const f = automatic();
    f.store.history.mockResolvedValue([{ ...f.record, roundStartedAt: null, state: "queued" }]);
    await observeForWindow(f);
    expect(f.discord.publish).not.toHaveBeenCalled();
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: { ...settings.rotation, currentMap: "Europe", currentIndex: 1 },
    });
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: { serverName: "Test", map: "Europe", matchSeconds: undefined },
    }));
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Kavkazi" }, { id: "Europe" }, { id: "Islands" }],
      experiences: [],
      lightings: [],
    });
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        currentIndex: 1,
        currentMap: "Europe",
        choices: [
          { map: "Islands", experiences: [] },
          { map: "Kavkazi", experiences: [] },
        ],
      }),
      f.record.id,
    );
  });
  it("waits again after a reported clock reset at the same rotation position", async () => {
    const f = automatic();
    let startedAt = Date.now() - 600_000;
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: { serverName: "Test", map: "Kavkazi", matchSeconds: (Date.now() - startedAt) / 1000 },
    }));
    f.store.history.mockResolvedValue([{ ...f.record, state: "queued" }]);
    await observeForWindow(f);
    expect(f.discord.publish).not.toHaveBeenCalled();
    startedAt = Date.now();
    await f.service.tick();
    expect(f.discord.publish).not.toHaveBeenCalled();
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.store.create.mock.calls[0][0].roundStartedAt).toEqual(new Date(startedAt));
  });
  it("continues another configured server when one policy targets an unavailable server", async () => {
    const f = automatic();
    f.environment.MAP_VOTES_AUTOMATIC = automaticMapVotes.parse([
      { serverId: "missing", actorId: staff.id },
      { serverId: "primary", actorId: staff.id },
    ]);
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.store.create.mock.calls[0][0].serverId).toBe("primary");
  });
  it("skips known unavailable saved options but preserves a later validated mode and zone", async () => {
    const f = automatic();
    const settings = await f.game.configuration();
    const valid = { map: "Europe", experiences: ["Infantry"], zoneAlternator: "Zone.Farmland" };
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: {
        ...settings.rotation,
        entries: [
          settings.rotation.entries[0],
          { ...valid, zoneAlternator: "Zone.Removed" },
          valid,
          settings.rotation.entries[2],
        ],
      },
    });
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Europe" }, { id: "Islands" }],
      experiences: [{ id: "Infantry" }],
      lightings: [],
    });
    f.game.capabilities.mockResolvedValue({ routes: ["GET /v1/catalog/maps/{map}/alternators"] });
    f.game.checkRotation.mockResolvedValue({
      revision: "r1",
      total: 4,
      issues: [{ index: 1, unavailable: true, message: "Old option removed" }],
    });
    await observeForWindow(f);
    expect(f.store.create.mock.calls[0][0].choices[0]).toEqual(valid);
  });
  it("rejects duplicate server policies and unsafe automatic durations", () => {
    const recipe = { serverId: "primary", actorId: staff.id };
    expect(automaticMapVotes.safeParse([recipe, recipe]).success).toBe(false);
    expect(automaticMapVotes.safeParse([{ ...recipe, delaySeconds: 0 }]).success).toBe(false);
    expect(automaticMapVotes.safeParse([{ ...recipe, minutes: 0 }]).success).toBe(false);
  });
});
