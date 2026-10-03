import { createHash, randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { MapVotesService } from "./map-votes.service";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";
import { fixtureServers } from "../admin/game-server-fixture";
import { AdminService } from "../admin/admin.service";
import type { AdminStore } from "../admin/admin.store";
import { AdminAuth } from "../admin/admin.auth";
import { EnvService } from "../env/env.service";
import type { Staff } from "../admin/admin.types";
import { ballotWinner, mapVoteView, type MapVoteRecord, type StartMapVote } from "./map-votes.types";
import { defaultVotingPolicy, type VotingPolicy, type VoteReminder } from "../common/voting-policy";
import { actionSchema } from "../admin/admin.types";

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
    policy: jest.fn().mockResolvedValue(null),
    policies: jest.fn().mockResolvedValue([]),
    savePolicy: jest.fn().mockResolvedValue({ closed: [] }),
    automaticOpen: jest.fn().mockResolvedValue([]),
    observeScore: jest.fn().mockResolvedValue(true),
    claimReminder: jest.fn().mockResolvedValue(null),
    finishReminder: jest.fn().mockResolvedValue(undefined),
    checkSetup: jest.fn().mockResolvedValue({ unfinished: false }),
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
  const discord = {
    check: jest.fn().mockResolvedValue({ name: "map-voting" }),
    publish: jest.fn().mockResolvedValue(messageId),
    update: jest.fn(),
    remind: jest.fn().mockResolvedValue(undefined),
  };
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
  it("opens a ballot when status and configuration use known names for the same map", async () => {
    const f = fixture();
    const overview = await f.game.overview();
    f.game.overview.mockResolvedValue({ ...overview, status: { ...overview.status, map: "Bakurani" } });
    await expect(f.service.start(staff, f.input)).resolves.toMatchObject({ state: "open" });
    expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({ currentMap: "Kavkazi" }));
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("queues a ballot winner when the same map is reported by its known in-game name", async () => {
    const f = fixture();
    f.closing();
    const overview = await f.game.overview();
    f.game.overview.mockResolvedValue({ ...overview, status: { ...overview.status, map: "Bakurani" } });
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledTimes(1);
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "primary" }),
      expect.objectContaining({ currentMap: "Kavkazi", entry: f.input.choices[1] }),
    );
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "queued", expect.any(String));
  });
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
    await expect(service.setup({ ...staff, role })).rejects.toMatchObject({ status: 403 });
    await expect(service.start({ ...staff, role }, input)).rejects.toMatchObject({ status: 403 });
    await expect(
      service.cancel({ ...staff, role }, input.id, { id: randomUUID(), reason: "Close vote" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.checkSetup).not.toHaveBeenCalled();
  });
  it("checks disabled voting setup for the selected server without enabling or sending effects", async () => {
    const f = fixture(false, "event");
    f.store.policy.mockResolvedValue({
      serverId: "event",
      actorId: staff.id,
      policy: defaultVotingPolicy,
      connectionHash: f.record.connectionHash,
    });
    const result = await f.service.setup({ ...staff, serverId: "event" });
    expect(result.serverId).toBe("event");
    expect(result.checks.map((item) => item.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.store.checkSetup).toHaveBeenCalledWith("event");
    expect(f.auth.serverStaff).toHaveBeenCalledWith(expect.objectContaining({ id: staff.id }), "event", true);
    expect(result.checks[1].message).toContain("#map-voting");
    expect(JSON.stringify(result)).not.toContain(staff.id);
    expect(f.environment.MAP_VOTES_ENABLED).toBe(false);
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect(f.discord.update).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("reports setup failures independently without exposing provider details", async () => {
    const f = fixture(false);
    const privateError = new Error("private connection and credential details");
    f.store.policy.mockResolvedValue({
      serverId: "primary",
      actorId: staff.id,
      policy: defaultVotingPolicy,
      connectionHash: f.record.connectionHash,
    });
    f.store.checkSetup.mockRejectedValue(privateError);
    f.discord.check.mockRejectedValue(privateError);
    f.auth.serverStaff.mockRejectedValue(privateError);
    f.game.configuration.mockRejectedValue(privateError);
    const result = await f.service.setup(staff);
    expect(result.checks.map((item) => item.status)).toEqual(["blocked", "blocked", "blocked", "blocked"]);
    expect(JSON.stringify(result)).not.toContain("private connection");
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("distinguishes missing policy/channel configuration and an unfinished ballot", async () => {
    const f = fixture(false);
    delete f.environment.MAP_VOTES_CHANNEL_ID;
    f.store.checkSetup.mockResolvedValue({ unfinished: true });
    const result = await f.service.setup(staff);
    expect(result.checks.map((item) => item.status)).toEqual(["review", "blocked", "blocked", "ok"]);
    expect(f.discord.check).not.toHaveBeenCalled();
    expect(f.auth.serverStaff).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
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
        { map: "Europe", experiences: [] },
      ],
    },
    { extra: true },
  ])("rejects malformed or ambiguous ballots: %j", async (patch) => {
    const { service, input, store, game } = fixture();
    await expect(service.start(staff, { ...input, ...patch })).rejects.toMatchObject({ status: 400 });
    expect(store.create).not.toHaveBeenCalled();
    expect(game.configuration).not.toHaveBeenCalled();
  });
  it("allows the current map as a next-round choice while keeping its exact catalog ID", async () => {
    const { service, input, game, store, discord } = fixture();
    const settings = await game.configuration();
    game.configuration.mockResolvedValue({ ...settings, rotation: { ...settings.rotation, currentMap: "Ozeti" } });
    const overview = await game.overview();
    game.overview.mockResolvedValue({ ...overview, status: { ...overview.status, map: "Ozeti" } });
    await expect(service.start(staff, input)).resolves.toMatchObject({ state: "open" });
    expect(store.create.mock.calls[0][0].choices[0].map).toBe("Europe");
    expect(discord.publish).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ id: `system:map-vote:${input.id}`, name: staff.name, role: "admin" }),
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
  it("closes under its own audit actor, so the creator's last dashboard action cannot throttle it", async () => {
    const f = fixture();
    const servers = fixtureServers({
      ...f.game,
      execute: jest.fn().mockResolvedValue({ state: "pending", message: "Saved" }),
    });
    const adminStore = { begin: jest.fn().mockResolvedValue({ created: true }), finish: jest.fn() };
    const admin = new AdminService(servers, adminStore as unknown as AdminStore);
    const service = new MapVotesService(
      f.store as unknown as MapVotesStore,
      servers,
      admin,
      f.auth as unknown as AdminAuth,
      f.discord as unknown as MapVotesDiscord,
      { get: (key: string) => f.environment[key] } as EnvService,
    );
    await admin.act(
      { ...staff, serverId: "primary" },
      { id: randomUUID(), action: "broadcast", reason: "Staff notice", message: "Hello" },
    );
    f.closing();
    await service.tick();
    expect(adminStore.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: `system:map-vote:${f.record.id}`, name: staff.name }),
      expect.objectContaining({ id: f.record.id, action: "map-next" }),
      expect.any(String),
    );
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "queued", expect.any(String));
  });
  it("closes as cancelled when the audited action path refuses the queue change before sending it", async () => {
    const { service, closing, store, admin, input } = fixture();
    closing();
    admin.act.mockRejectedValue(new HttpException("Wait a moment before sending another action.", 429));
    await service.tick();
    expect(admin.act).toHaveBeenCalledTimes(1);
    expect(store.finish).toHaveBeenCalledWith(input.id, "cancelled", expect.stringContaining("without sending"));
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
    const saved = {
      serverId,
      actorId: staff.id,
      version: 1,
      connectionHash: f.record.connectionHash,
      policy: { ...defaultVotingPolicy, enabled: true },
    };
    f.store.policy.mockResolvedValue(saved);
    f.store.policies.mockResolvedValue([saved]);
    f.store.due.mockResolvedValue([]);
    f.store.history.mockResolvedValue([]);
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: {
        serverName: "Test",
        map: "Kavkazi",
        matchSeconds: undefined,
        factionScores: [
          { name: "A", score: 10 },
          { name: "B", score: 5 },
        ],
      },
    }));
    f.store.published.mockImplementation(async (id, messageId) => {
      const record = { ...f.record, ...f.store.create.mock.calls.at(-1)![0], id, messageId, state: "open" as const };
      f.store.history.mockResolvedValue([record]);
      return record;
    });
    return { ...f, saved };
  }
  async function observeForWindow(f: ReturnType<typeof automatic>) {
    await f.service.tick();
    for (let i = 0; i < 4; i++) {
      jest.setSystemTime(Date.now() + 30_000);
      await f.service.tick();
    }
  }
  it("keeps automatic observation valid across known configuration/status map names", async () => {
    const f = automatic();
    const overview = await f.game.overview();
    f.game.overview.mockImplementation(async () => ({
      ...overview,
      observedAt: new Date().toISOString(),
      status: { ...overview.status, map: "Bakurani" },
    }));
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ currentMap: "Kavkazi", choices: f.input.choices }),
      null,
    );
    expect(f.admin.act).not.toHaveBeenCalled();
  });
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
    expect(status.automatic).toMatchObject({ enabled: true, closesAtScore: 95 });
    expect(JSON.stringify(status.automatic)).not.toContain(staff.id);
  });
  it("opens mode-only automatic choices on the current map from validated rotation combinations", async () => {
    const f = automatic();
    const policy = { ...defaultVotingPolicy, enabled: true, mapChoices: false, modeChoices: true };
    const saved = {
      serverId: "primary",
      actorId: staff.id,
      policy,
      connectionHash: f.record.connectionHash,
      version: 1,
    };
    f.store.policy.mockResolvedValue(saved);
    f.store.policies.mockResolvedValue([saved]);
    const settings = await f.game.configuration();
    const normal = { map: "Kavkazi", experiences: ["KOTH"] };
    const infantry = { map: "Kavkazi", experiences: ["KOTH", "KOTH_InfantryOnly"] };
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: {
        ...settings.rotation,
        entries: [normal, { map: "Europe", experiences: ["KOTH"] }, infantry, { ...infantry, lighting: "DayClear" }],
      },
    });
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Kavkazi" }, { id: "Europe" }],
      experiences: [{ id: "KOTH" }, { id: "KOTH_InfantryOnly" }],
      lightings: [{ id: "DayClear" }],
    });
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: {
        serverName: "Test",
        map: "Kavkazi",
        matchSeconds: undefined,
        factionScores: [
          { name: "A", score: 10 },
          { name: "B", score: 5 },
        ],
      },
    }));
    await observeForWindow(f);
    expect(f.store.create.mock.calls[0][0]).toMatchObject({
      choices: [infantry, normal],
      automation: { policy, highestScore: 10, reminders: {} },
    });
    expect(f.admin.act).not.toHaveBeenCalled();
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
      status: {
        serverName: "Test",
        map: "Europe",
        matchSeconds: undefined,
        factionScores: [
          { name: "A", score: 10 },
          { name: "B", score: 5 },
        ],
      },
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
      status: {
        serverName: "Test",
        map: "Kavkazi",
        matchSeconds: (Date.now() - startedAt) / 1000,
        factionScores: [
          { name: "A", score: 10 },
          { name: "B", score: 5 },
        ],
      },
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
    f.store.policies.mockResolvedValue([{ ...f.saved, serverId: "missing" }, f.saved]);
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(f.store.create.mock.calls[0][0].serverId).toBe("primary");
  });
  it("skips known unavailable saved options but preserves a later validated mode and zone", async () => {
    const f = automatic();
    f.saved.policy.modeChoices = true;
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
      maps: [{ id: "Europe" }, { id: "Islands" }, { id: "Kavkazi" }],
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
  it("does not let an obsolete environment recipe bypass absent or disabled dashboard controls", async () => {
    const f = automatic();
    f.environment.MAP_VOTES_AUTOMATIC = [{ serverId: "primary", actorId: staff.id }];
    f.store.policy.mockResolvedValue(null);
    f.store.policies.mockResolvedValue([]);
    await observeForWindow(f);
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect((await f.service.list(staff)).automatic).toBeNull();
  });
});

describe("score-based voting controls and reminders", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  function scored(policy: Partial<VotingPolicy> = {}) {
    const f = fixture();
    f.record.state = "open";
    f.record.closesAt = new Date(now.getTime() + 180 * 60_000);
    f.record.automation = {
      policy: {
        ...defaultVotingPolicy,
        enabled: true,
        modeChoices: true,
        midpointReminder: true,
        finalReminder: true,
        ...policy,
      },
      highestScore: 20,
      reminders: {},
    };
    const saved = {
      serverId: "primary",
      version: 1,
      actorId: staff.id,
      actorName: staff.name,
      connectionHash: f.record.connectionHash,
      policy: f.record.automation.policy,
    };
    f.store.policy.mockResolvedValue(saved);
    f.store.policies.mockResolvedValue([saved]);
    f.store.due.mockResolvedValue([]);
    f.store.automaticOpen.mockResolvedValue([f.record]);
    f.store.get.mockResolvedValue(f.record);
    f.store.liveCounts.mockResolvedValue([
      { voteId: f.record.id, choice: 0, total: 3 },
      { voteId: f.record.id, choice: 1, total: 2 },
    ]);
    f.store.claimReminder.mockImplementation(async (_id: string, stage: VoteReminder, receiptId: string) => {
      if (
        f.record.automation!.reminders[stage] ||
        !saved.policy[stage === "midpoint" ? "midpointReminder" : "finalReminder"]
      )
        return null;
      f.record.automation!.reminders[stage] = {
        id: receiptId,
        state: "started",
        message: "Claimed",
        at: now.toISOString(),
      };
      return f.record;
    });
    let leading = 50;
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: {
        serverName: "The UNCs",
        map: "Kavkazi",
        matchSeconds: 600,
        factionScores: [
          { name: "Lonestar", score: leading },
          { name: "Manticore", score: 20 },
          { name: "Valkyra", score: 10 },
        ],
      },
    }));
    return {
      ...f,
      saved,
      score: (value: number) => {
        leading = value;
      },
    };
  }
  it("prepares independent switches while the live gate stays off, without any Discord or game writes", async () => {
    const f = fixture(false);
    const controls = await f.service.controls(staff);
    expect(controls).toMatchObject({ version: 0, policy: defaultVotingPolicy, available: true, ready: false });
    await f.service.saveControls(staff, {
      serverId: "primary",
      version: 0,
      policy: { ...defaultVotingPolicy, modeChoices: true, finalReminder: true },
    });
    expect(f.store.savePolicy).toHaveBeenCalledWith(
      "primary",
      0,
      expect.objectContaining({ enabled: false, finalReminder: true, midpointReminder: false }),
      staff,
      f.record.connectionHash,
    );
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    await expect(
      f.service.saveControls(staff, {
        serverId: "primary",
        version: 0,
        policy: { ...defaultVotingPolicy, enabled: true },
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("requires an explicit off/save step before moving an enabled policy to a changed game connection", async () => {
    const f = scored();
    f.environment.WARDOGS_RCON_URL = "https://changed.example.test";
    expect(await f.service.controls(staff)).toMatchObject({
      ready: false,
      message: expect.stringContaining("connection changed"),
    });
    expect((await f.service.list(staff)).automatic).toMatchObject({
      enabled: false,
      message: expect.stringContaining("connection changed"),
    });
    await expect(
      f.service.saveControls(staff, { serverId: "primary", version: 1, policy: f.saved.policy }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.store.savePolicy).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("refuses unauthorized and cross-server control writes, and reports missing storage honestly", async () => {
    const f = fixture(false);
    await expect(f.service.controls({ ...staff, role: "moderator" })).rejects.toMatchObject({ status: 403 });
    await expect(f.service.saveControls({ ...staff, role: "viewer" }, {})).rejects.toMatchObject({ status: 403 });
    await expect(
      f.service.saveControls(staff, { serverId: "other", version: 0, policy: defaultVotingPolicy }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.store.savePolicy).not.toHaveBeenCalled();
    f.store.policy.mockRejectedValue(new Error("private DB URL"));
    const controls = await f.service.controls(staff);
    expect(controls.available).toBe(false);
    expect(JSON.stringify(controls)).not.toContain("private DB URL");
  });
  it("offers two validated modes on the same map and preserves the exact winner selection", async () => {
    const f = fixture();
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Europe" }],
      experiences: [{ id: "KOTH" }, { id: "KOTH_InfantryOnly" }],
      lightings: [],
    });
    f.input.choices = [
      { map: "Europe", experiences: ["KOTH"] },
      { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] },
    ];
    await f.service.start(staff, f.input);
    expect(f.store.create.mock.calls[0][0].choices).toEqual(f.input.choices);
    f.record.choices = f.input.choices;
    f.closing();
    await f.service.tick();
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "primary" }),
      expect.objectContaining({ action: "map-next", entry: f.input.choices[1] }),
    );
  });
  it("sends current totals at 50 and 85 once, using the actual channel and a valid short broadcast", async () => {
    const f = scored();
    for (let index = 0; index < 3; index++) await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.discord.remind).toHaveBeenCalledWith(expect.objectContaining({ counts: [3, 2] }), "midpoint");
    f.score(85);
    await f.service.tick();
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(2);
    expect(f.admin.act).toHaveBeenCalledTimes(2);
    for (const [, action] of f.admin.act.mock.calls as unknown as [unknown, { message: string }][]) {
      expect(actionSchema.safeParse(action).success).toBe(true);
      expect(action.message).toContain("3/5");
      expect(action.message).toContain("#map-voting");
    }
    expect(f.store.claimClose).not.toHaveBeenCalled();
  });
  it("broadcasts reminders as the ballot's audit actor and records a refused broadcast as not sent", async () => {
    const f = scored();
    f.admin.act.mockRejectedValue(new HttpException("Wait a moment before sending another action.", 429));
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: `system:map-vote:${f.record.id}`, name: staff.name }),
      expect.objectContaining({ action: "broadcast" }),
    );
    expect(f.store.finishReminder).toHaveBeenCalledWith(
      f.record.id,
      "midpoint",
      "failed",
      expect.stringContaining("not sent"),
    );
  });
  it("skips the earlier reminder when scores jump to the final milestone", async () => {
    const f = scored();
    f.score(90);
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.discord.remind.mock.calls[0][1]).toBe("final");
  });
  it("respects each reminder switch and the global off switch", async () => {
    const f = scored({ midpointReminder: false, finalReminder: false });
    await f.service.tick();
    f.score(85);
    await f.service.tick();
    expect(f.discord.remind).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    f.environment.MAP_VOTES_ENABLED = false;
    f.score(95);
    await f.service.tick();
    expect(f.store.claimClose).not.toHaveBeenCalled();
  });
  it("does not repeat an uncertain announcement", async () => {
    const f = scored();
    f.discord.remind.mockRejectedValue(new Error("Lost Discord response"));
    await f.service.tick();
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.finishReminder).toHaveBeenCalledWith(f.record.id, "midpoint", "unknown", expect.any(String));
  });
  it("honors switching off while the Discord reminder is in flight", async () => {
    const f = scored();
    f.discord.remind.mockImplementation(async () => {
      f.saved.policy.enabled = false;
    });
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("queues only at the score cutoff, keeping the match running", async () => {
    const f = scored();
    f.score(95);
    f.store.claimClose.mockImplementation(async () => {
      f.record.state = "closing";
      return f.record;
    });
    await f.service.tick();
    expect(f.store.claimClose).toHaveBeenCalledWith(f.record.id, true);
    expect(f.admin.act).toHaveBeenCalledTimes(1);
    expect(f.admin.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "map-next" }));
    expect(f.discord.remind).not.toHaveBeenCalled();
  });
  it("honors switching off while the winner's final game read is in flight", async () => {
    const f = scored();
    f.score(95);
    const overview = await f.game.overview();
    let finishRead!: (value: typeof overview) => void;
    const pendingRead = new Promise<typeof overview>((resolve) => {
      finishRead = resolve;
    });
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    f.game.overview.mockResolvedValueOnce(overview).mockImplementationOnce(() => {
      readStarted();
      return pendingRead;
    });
    f.store.claimClose.mockImplementation(async () => {
      f.record.state = "closing";
      return f.record;
    });

    const closing = f.service.tick();
    await reading;
    expect(f.record.state).toBe("closing");
    f.saved.policy.enabled = false;
    finishRead(overview);
    await closing;

    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "cancelled", expect.any(String));
    expect(f.discord.remind).not.toHaveBeenCalled();
  });
  it.each([
    ["ended", 20, 100],
    ["moved backwards", 90, 85],
  ])("cancels without claiming the ballot once the score has %s", async (_case, highest, score) => {
    const f = scored();
    f.record.automation!.highestScore = highest;
    f.score(score);
    // The real store moves a claimed ballot to closing, so a missed guard would reach the queue.
    f.store.claimClose.mockImplementation(async () => {
      f.record.state = "closing";
      return f.record;
    });
    await f.service.tick();
    expect(f.store.cancel).toHaveBeenCalledWith(
      f.record.id,
      expect.any(String),
      expect.objectContaining({ name: "Gramps" }),
      "The score reached 100 or moved backwards. The rotation was left unchanged.",
      expect.any(String),
    );
    expect(f.store.claimClose).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.discord.remind).not.toHaveBeenCalled();
  });
  it.each(["shows 100 points", "is too old"])(
    "closes a claimed ballot without queueing when the winner's own game read %s",
    async (failure) => {
      const f = scored();
      f.score(95);
      const observed = await f.game.overview();
      // Only close()'s own read changes, so its score re-check is the one guard in the way.
      f.game.overview.mockResolvedValueOnce(observed).mockResolvedValueOnce(
        failure === "is too old"
          ? {
              ...observed,
              observedAt: new Date(now.getTime() - 40_000).toISOString(),
              status: { ...observed.status, matchSeconds: 560 },
            }
          : {
              ...observed,
              status: {
                ...observed.status,
                factionScores: [
                  { name: "Lonestar", score: 100 },
                  { name: "Manticore", score: 20 },
                  { name: "Valkyra", score: 10 },
                ],
              },
            },
      );
      f.store.claimClose.mockImplementation(async () => {
        f.record.state = "closing";
        return f.record;
      });
      await f.service.tick();
      expect(f.store.claimClose).toHaveBeenCalledWith(f.record.id, true);
      expect(f.admin.act).not.toHaveBeenCalled();
      expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "cancelled", expect.any(String));
    },
  );
  it.each(["staff-override", "disabled", "stale", "missing-scores", "permission"])(
    "does not send messages or queue a winner after %s",
    async (failure) => {
      const f = scored();
      if (failure === "disabled") f.saved.policy.enabled = false;
      if (failure === "permission") f.auth.role.mockResolvedValue("viewer");
      if (failure === "staff-override") {
        const config = await f.game.configuration();
        f.game.configuration.mockResolvedValue({ ...config, revision: "staff-change" });
      }
      if (failure === "stale" || failure === "missing-scores") {
        const value = await f.game.overview();
        f.game.overview.mockResolvedValue(
          failure === "stale"
            ? { ...value, observedAt: new Date(now.getTime() - 90_000).toISOString() }
            : { ...value, status: { serverName: "The UNCs", map: "Kavkazi", matchSeconds: 600 } },
        );
      }
      await f.service.tick();
      expect(f.admin.act).not.toHaveBeenCalled();
      expect(f.discord.remind).not.toHaveBeenCalled();
    },
  );
});
