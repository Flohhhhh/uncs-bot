import { createHash, randomUUID } from "node:crypto";
import { ConflictException, HttpException } from "@nestjs/common";
import { MapVotesService } from "./map-votes.service";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";
import { fixtureServers } from "../admin/game-server-fixture";
import { AdminService } from "../admin/admin.service";
import { AdminAuth } from "../admin/admin.auth";
import { GameRounds } from "../admin/game-rounds";
import { EnvService } from "../env/env.service";
import { StaffAlerts } from "../staff-alerts/staff-alerts.service";
import { ServerEventsService } from "../server-events/server-events.service";
import type { Staff } from "../admin/admin.types";
import { ballotWinner, mapVoteView, type MapVoteRecord, type StartMapVote } from "./map-votes.types";
import {
  defaultVotingPolicy,
  defaultVotingSettings,
  voteChoiceKey,
  type DeepPartial,
  type StoredVotingPolicy,
  type VoteAutomation,
  type VotingPolicy,
  type VotingSettings,
  type VoteReminder,
} from "../common/voting-policy";
import { rotationFingerprint } from "./ballot-builder";
import { mergeSettings, readStoredPolicy } from "./voting-settings";
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
    cast: jest.fn().mockResolvedValue({ selection: input.choices[0], closeAtScore: null }),
    cancel: jest.fn().mockResolvedValue({ ...record, state: "cancelled" }),
    recover: jest.fn().mockResolvedValue([]),
    due: jest.fn().mockResolvedValue([record]),
    claimClose: jest.fn().mockResolvedValue(record),
    finish: jest.fn().mockImplementation(async (id, state, message) => ({ ...record, id, state, message })),
    patchAutomation: jest.fn().mockImplementation(async (id: string, patch: Partial<VoteAutomation>) => ({
      ...record,
      id,
      automation: { ...record.automation, ...patch },
    })),
    resolveReview: jest.fn().mockImplementation(async (id: string, state: string, message: string) => ({
      ...record,
      id,
      state,
      message,
    })),
    needsReview: jest.fn().mockResolvedValue([]),
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
      status: {
        serverName: "The UNCs",
        map: "Kavkazi",
        matchSeconds: 600 as number | undefined,
        players: { current: 60, max: 100 },
      },
    }),
  };
  const admin = {
    act: jest.fn().mockResolvedValue({ state: "pending", message: "Saved" }),
    receipt: jest.fn().mockResolvedValue({ record: null }),
  };
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
    findBallotMessage: jest.fn().mockResolvedValue(null),
  };
  const alerts = { send: jest.fn().mockResolvedValue(true) };
  const events = {
    voteEventReadiness: jest.fn().mockResolvedValue({ ok: false, reason: "optional events are off in Gramps" }),
    startFromVote: jest.fn().mockResolvedValue({ created: true, event: {} }),
    voteEvent: jest.fn().mockResolvedValue(null),
  };
  const environment: Record<string, unknown> = {
    MAP_VOTES_ENABLED: enabled,
    WARDOGS_RCON_URL: "https://game.example.test",
    ADMIN_GUILD_ID: guild,
    MAP_VOTES_CHANNEL_ID: channel,
  };
  const servers = fixtureServers(game, () => environment.WARDOGS_RCON_URL as string, serverId);
  /** A new process: fresh in-memory round state over the same storage, game and Discord. */
  const make = () => {
    const rounds = new GameRounds(servers);
    const service = new MapVotesService(
      store as unknown as MapVotesStore,
      servers,
      admin as unknown as AdminService,
      auth as unknown as AdminAuth,
      discord as unknown as MapVotesDiscord,
      { get: (key: string) => environment[key] } as EnvService,
      rounds,
      alerts as unknown as StaffAlerts,
      events as unknown as ServerEventsService,
    );
    return { service, rounds };
  };
  const { service, rounds } = make();
  const closing = () => store.get.mockResolvedValue(record);
  return {
    service,
    rounds,
    make,
    store,
    game,
    admin,
    auth,
    discord,
    alerts,
    events,
    input,
    record,
    closing,
    environment,
  };
}

/** A live status during a populated, clockless round on the first rotation entry. */
function baseStatus() {
  return {
    serverName: "Test",
    map: "Kavkazi",
    matchSeconds: undefined as number | undefined,
    rotation: { nowIndex: 0 as number | null, nextIndex: 1 as number | null },
    players: { current: 60, max: 100 },
    factionScores: [
      { name: "Lonestar", score: 10 },
      { name: "Manticore", score: 5 },
      { name: "Valkyra", score: 2 },
    ],
  };
}
type StatusPatch = Partial<ReturnType<typeof baseStatus>>;
function automatic(serverId = "primary", settings: DeepPartial<VotingSettings> = {}) {
  const f = fixture(true, serverId);
  const saved = {
    serverId,
    actorId: staff.id,
    actorName: staff.name,
    version: 1,
    connectionHash: f.record.connectionHash,
    // In-game announcements have their own tests; keep the other cases to ballot effects.
    policy: {
      ...defaultVotingPolicy,
      enabled: true,
      settings: mergeSettings(
        mergeSettings(defaultVotingSettings, { announce: { openInGame: false, resultInGame: false } }),
        settings,
      ),
    } as StoredVotingPolicy,
  };
  f.store.policy.mockImplementation(async () => saved);
  f.store.policies.mockImplementation(async () => [saved]);
  f.store.due.mockResolvedValue([]);
  f.store.history.mockResolvedValue([]);
  let status: StatusPatch = {};
  f.game.overview.mockImplementation(async () => ({
    observedAt: new Date().toISOString(),
    status: { ...baseStatus(), ...status },
  }));
  f.store.published.mockImplementation(async (id, messageId) => {
    const record = { ...f.record, ...f.store.create.mock.calls.at(-1)![0], id, messageId, state: "open" as const };
    f.store.history.mockResolvedValue([record]);
    return record;
  });
  return {
    ...f,
    saved,
    status: (patch: StatusPatch) => {
      status = { ...status, ...patch };
    },
  };
}
/** Seven passes 30 seconds apart: more than the default three-minute opening delay. */
async function observeForWindow(f: ReturnType<typeof automatic>) {
  await f.service.tick();
  for (let i = 0; i < 7; i++) {
    jest.setSystemTime(Date.now() + 30_000);
    await f.service.tick();
  }
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
    await expect(service.preview({ ...staff, role }, { serverId: "primary" })).rejects.toMatchObject({ status: 403 });
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
    expect(result.checks.map((item) => item.label)).toEqual([
      "Storage",
      "Discord channel",
      "Automatic voting",
      "Rotation",
      "Players",
      "50v50 option",
    ]);
    expect(result.checks.map((item) => item.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(result.checks[4].message).toBe("60 players online. Ballots open from 40 players.");
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
    expect(result.checks.map((item) => item.status)).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "ok",
    ]);
    expect(JSON.stringify(result)).not.toContain("private connection");
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it("distinguishes missing policy/channel configuration and an unfinished ballot", async () => {
    const f = fixture(false);
    delete f.environment.MAP_VOTES_CHANNEL_ID;
    f.store.checkSetup.mockResolvedValue({ unfinished: true });
    const result = await f.service.setup(staff);
    expect(result.checks.map((item) => item.status)).toEqual(["review", "blocked", "blocked", "ok", "ok", "ok"]);
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
    {
      choices: [
        { map: "Europe", experiences: [], event: "50v50" },
        { map: "Islands", experiences: [] },
      ],
    },
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
  it.each(["unknown", "accepted"])("does not claim queueing for an %s action receipt", async (state) => {
    const { service, closing, store, admin, input } = fixture();
    closing();
    admin.act.mockResolvedValue({ state, message: "Check receipt" });
    await service.tick();
    expect(store.finish).toHaveBeenCalledWith(input.id, "needs_review", "Check receipt");
    expect(admin.act).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["a failed queue result", () => ({ state: "failed", message: "The current round changed." })],
    ["a refused request", () => Promise.reject(new HttpException("Wait a moment before sending another action.", 429))],
  ])("closes the ballot and keeps the rotation after %s, because nothing was changed", async (_, result) => {
    const { service, closing, store, admin, input } = fixture();
    closing();
    admin.act.mockImplementation(async () => result());
    await service.tick();
    expect(store.finish).toHaveBeenCalledWith(
      input.id,
      "cancelled",
      expect.stringMatching(/^Not queued: .+ The rotation continues\.$/),
      { outcome: "refused" },
    );
    expect(store.finish).not.toHaveBeenCalledWith(input.id, "needs_review", expect.anything());
  });
  it("keeps an unexpected error after sending in review", async () => {
    const { service, closing, store, admin, input } = fixture();
    closing();
    admin.act.mockRejectedValue(new Error("socket closed"));
    await service.tick();
    expect(store.finish).toHaveBeenCalledWith(input.id, "needs_review", expect.stringContaining("unconfirmed"));
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

  it.each(["queued", "cancelled", "tied", "no_votes"] as const)(
    "does not reopen after %s at the same position, including after a bot restart",
    async (state) => {
      const f = automatic();
      f.store.history.mockResolvedValue([{ ...f.record, roundStartedAt: null, state }]);
      await observeForWindow(f);
      expect(f.discord.publish).not.toHaveBeenCalled();
      expect((await f.service.list(staff)).automatic).toMatchObject({ phase: "done_this_round" });
    },
  );
  it("keeps automatic observation valid across known configuration/status map names", async () => {
    const f = automatic();
    f.status({ map: "Bakurani" });
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
    expect(status.automatic).toMatchObject({ enabled: true, closesAtScore: 95, delaySeconds: 180, choices: 3 });
    expect(JSON.stringify(status.automatic)).not.toContain(staff.id);
  });
  it("offers rule variants of the running map from the rotation, never the running option itself", async () => {
    const f = automatic();
    f.saved.policy = { ...f.saved.policy, mapChoices: false, modeChoices: true };
    const settings = await f.game.configuration();
    const normal = { map: "Kavkazi", experiences: ["KOTH"] };
    const infantry = { map: "Kavkazi", experiences: ["KOTH", "KOTH_InfantryOnly"] };
    const hardcore = { map: "Kavkazi", experiences: ["KOTH", "KOTH_Hardcore"] };
    const entries = [
      normal,
      { map: "Europe", experiences: ["KOTH"] },
      infantry,
      { ...infantry, lighting: "DayClear" },
      hardcore,
    ];
    f.game.configuration.mockResolvedValue({ ...settings, rotation: { ...settings.rotation, entries } });
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Kavkazi" }, { id: "Europe" }],
      experiences: [{ id: "KOTH" }, { id: "KOTH_InfantryOnly" }, { id: "KOTH_Hardcore" }],
      lightings: [{ id: "DayClear" }],
    });
    await observeForWindow(f);
    const created = f.store.create.mock.calls[0][0];
    expect(created.choices).toEqual([infantry, hardcore]);
    expect(created.automation).toEqual({
      policy: readStoredPolicy(f.saved.policy).policy,
      policyVersion: 1,
      settings: readStoredPolicy(f.saved.policy).settings,
      highestScore: 10,
      openedAtScore: 10,
      maxStep: 0,
      reminders: {},
      round: expect.objectContaining({ source: "baseline", map: "Kavkazi", index: 0, exact: false }),
      rotation: {
        fingerprint: rotationFingerprint({ enabled: true, mode: "Ordered", entries }),
        length: 5,
        currentIndex: 0,
        nextSlot: 1,
        nextKey: voteChoiceKey(entries[1]),
        nextLabel: "Ozeti · King of the Hill",
      },
    });
    expect(f.admin.act).not.toHaveBeenCalled();
  });
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
    f.status({ map: "Europe", rotation: { nowIndex: 1, nextIndex: 2 } });
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
    let factionScores = baseStatus().factionScores;
    f.game.overview.mockImplementation(async () => ({
      observedAt: new Date().toISOString(),
      status: { ...baseStatus(), factionScores, matchSeconds: (Date.now() - startedAt) / 1000 },
    }));
    f.store.history.mockResolvedValue([{ ...f.record, state: "queued" }]);
    await observeForWindow(f);
    expect(f.discord.publish).not.toHaveBeenCalled();
    // Each status read has its own observation time. The new match starts at 0 and scores again.
    jest.setSystemTime(Date.now() + 1_000);
    startedAt = Date.now();
    factionScores = leadingScores(0);
    await f.service.tick();
    expect(f.discord.publish).not.toHaveBeenCalled();
    factionScores = leadingScores(4);
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
    f.saved.policy = { ...f.saved.policy, modeChoices: true };
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
    expect(f.store.savePolicy).toHaveBeenCalledWith("primary", 0, expect.any(Function), staff, f.record.connectionHash);
    const saved = f.store.savePolicy.mock.calls[0][2](null);
    expect(saved).toMatchObject({ enabled: false, finalReminder: true, midpointReminder: false });
    expect(saved.settings).toEqual(defaultVotingSettings);
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
  it.each(["ended", "reset", "staff-override", "disabled", "stale", "missing-scores", "permission"])(
    "does not send messages or queue a winner after %s",
    async (failure) => {
      const f = scored();
      if (failure === "ended") f.score(100);
      if (failure === "reset") f.score(0);
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

const leadingScores = (lonestar: number) => [
  { name: "Lonestar", score: lonestar },
  { name: "Manticore", score: Math.min(lonestar, 20) },
  { name: "Valkyra", score: Math.min(lonestar, 10) },
];
/** An open automatic ballot created by this version, in an observed round on the first entry. */
async function openBallot(
  options: {
    settings?: DeepPartial<VotingSettings>;
    policy?: Partial<VotingPolicy>;
    openedAt?: number;
    leading?: number;
  } = {},
) {
  const f = automatic("primary", options.settings);
  f.saved.policy = { ...f.saved.policy, ...options.policy };
  const { policy, settings } = readStoredPolicy(f.saved.policy);
  const config = await f.game.configuration();
  const opened = options.openedAt ?? 20;
  const automation: VoteAutomation = {
    policy,
    policyVersion: 1,
    settings,
    highestScore: opened,
    openedAtScore: opened,
    maxStep: 0,
    reminders: {},
    round: {
      id: "observed:1",
      map: "Kavkazi",
      index: 0,
      startedAt: now.getTime() - 600_000,
      source: "observed",
      exact: true,
    },
    rotation: {
      fingerprint: rotationFingerprint(config.rotation),
      length: 3,
      currentIndex: 0,
      nextSlot: 1,
      nextKey: voteChoiceKey(config.rotation.entries[1]),
      nextLabel: "Ozeti · Normal",
    },
  };
  f.record.state = "open";
  f.record.winner = null;
  f.record.counts = [0, 0];
  f.record.roundStartedAt = null;
  f.record.closesAt = new Date(now.getTime() + 180 * 60_000);
  f.record.automation = automation;
  f.store.automaticOpen.mockImplementation(async () => (f.record.state === "open" ? [f.record] : []));
  f.store.get.mockImplementation(async () => f.record);
  f.store.history.mockImplementation(async () => [f.record]);
  f.store.liveCounts.mockResolvedValue([
    { voteId: f.record.id, choice: 0, total: 3 },
    { voteId: f.record.id, choice: 1, total: 2 },
  ]);
  f.store.observeScore.mockImplementation(async (_id: string, score: number, step: number | null) => {
    automation.highestScore = Math.max(automation.highestScore, score);
    automation.maxStep = Math.max(automation.maxStep ?? 0, step ?? 0);
    return true;
  });
  f.store.claimReminder.mockImplementation(async (_id: string, stage: VoteReminder, receiptId: string) => {
    if (automation.reminders[stage]) return null;
    automation.reminders[stage] = { id: receiptId, state: "started", message: "Claimed", at: now.toISOString() };
    return f.record;
  });
  f.store.claimClose.mockImplementation(async () => {
    f.record.state = "closing";
    f.record.counts = [2, 3];
    f.record.winner = 1;
    return { ...f.record };
  });
  f.store.cancel.mockImplementation(async (_id: string, _request: string, _actor: Staff, reason: string) => {
    f.record.state = "cancelled";
    f.record.message = reason;
    return { ...f.record };
  });
  f.status({ factionScores: leadingScores(options.leading ?? 30) });
  return { ...f, automation, score: (value: number) => f.status({ factionScores: leadingScores(value) }) };
}
const later = (ms = 15_000) => jest.setSystemTime(Date.now() + ms);
const broadcasts = (admin: { act: jest.Mock }) =>
  (admin.act.mock.calls as [Staff, { action: string; message: string }][]).filter(
    ([, action]) => action.action === "broadcast",
  );

describe("automatic ballots that follow the round, not the clock", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  it("opens nothing during the live pre-round sample or below the player minimum", async () => {
    const f = automatic();
    f.status({
      players: { current: 1, max: 100 },
      factionScores: leadingScores(0),
      rotation: { nowIndex: 0, nextIndex: 1 },
    });
    await observeForWindow(f);
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "pre_round",
      message: "Waiting for players (1/20) before the round starts.",
    });
    f.status({ players: { current: 23, max: 100 }, factionScores: leadingScores(10) });
    await observeForWindow(f);
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "waiting_players",
      message: "Waiting for 40 players before a ballot opens (23/100).",
      players: { current: 23, required: 40 },
    });
    expect(f.discord.publish).not.toHaveBeenCalled();
    f.saved.policy = { ...f.saved.policy, settings: { ...f.saved.policy.settings, minPlayers: 20 } };
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
  });
  it("opens at once when the match clock shows the round is already far enough along", async () => {
    const f = automatic();
    f.status({ matchSeconds: 400 });
    await f.service.tick();
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    const created = f.store.create.mock.calls[0][0];
    expect(created.roundStartedAt).toEqual(new Date(now.getTime() - 400_000));
    expect(created.automation.round).toMatchObject({
      source: "clock",
      exact: true,
      startedAt: now.getTime() - 400_000,
    });
  });
  it("opens again at the same rotation entry after an observed score reset, ten minutes after the last ballot", async () => {
    const f = automatic();
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    const [first] = (await f.store.history()) as MapVoteRecord[];
    f.store.history.mockResolvedValue([{ ...first, state: "queued" }]);
    for (let i = 0; i < 8; i++) {
      later(30_000);
      await f.service.tick();
    }
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "done_this_round",
      message: "This round already had a ballot. Waiting for the next round.",
    });
    f.status({ factionScores: leadingScores(0) });
    later(30_000);
    await f.service.tick();
    f.status({ factionScores: leadingScores(3) });
    for (let i = 0; i < 7; i++) {
      later(30_000);
      await f.service.tick();
    }
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect((await f.service.list(staff)).automatic?.message).toBe(
      "Waiting at least 10 minutes between automatic ballots.",
    );
    for (let i = 0; i < 5; i++) {
      later(30_000);
      await f.service.tick();
    }
    expect(f.discord.publish).toHaveBeenCalledTimes(2);
    const second = f.store.create.mock.calls[1][0].automation;
    expect(second.round).toMatchObject({ source: "observed", exact: true });
    expect(second.round.id).not.toBe(first.automation!.round!.id);
  });
  it("opens no ballot between the score reset and map travel, and counts the delay on the new map", async () => {
    const f = automatic("primary", { openDelaySeconds: 60 });
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Kavkazi" }, { id: "Europe" }, { id: "Islands" }],
      experiences: [],
      lightings: [],
    });
    f.status({ factionScores: leadingScores(100) });
    await f.service.tick();
    // Round N ends: the scores reset on Kavkazi and the server travels to Europe 90 seconds later.
    f.status({ factionScores: leadingScores(0) });
    for (let i = 0; i < 7; i++) {
      later();
      await f.service.tick();
    }
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect((await f.service.list(staff)).automatic?.message).toBe(
      "A new round is starting. Waiting for its first points before a ballot opens.",
    );
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: { ...settings.rotation, currentIndex: 1, currentMap: "Europe" },
    });
    f.status({ map: "Europe", rotation: { nowIndex: 1, nextIndex: 2 } });
    later();
    await f.service.tick();
    later(45_000);
    f.status({ factionScores: leadingScores(3) });
    await f.service.tick();
    // Points 45 seconds after travel: the 60-second delay counts from the new map, not the reset.
    expect(f.discord.publish).not.toHaveBeenCalled();
    later();
    await f.service.tick();
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    const created = f.store.create.mock.calls[0][0];
    expect(created).toMatchObject({ currentMap: "Europe", currentIndex: 1 });
    expect(created.automation.round).toMatchObject({ map: "Europe", index: 1 });
  });
  it("opens no ballot once the leading team passes the opening ceiling", async () => {
    const f = automatic();
    f.status({ factionScores: leadingScores(75) });
    await observeForWindow(f);
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "too_late",
      message: "Too late in this round; the next round gets a ballot.",
      leadingProgress: 75,
    });
  });
  it("shows the game's rotation position note word for word", async () => {
    const f = automatic();
    const note =
      "This match was not started from the rotation, so the game will play entry 2 next. Queue a map once that round starts.";
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: { ...settings.rotation, currentIndex: null, positionNote: note },
    });
    await observeForWindow(f);
    expect((await f.service.list(staff)).automatic?.message).toBe(note);
    expect((await f.service.setup(staff)).checks.find((check) => check.label === "Rotation")).toEqual({
      label: "Rotation",
      status: "review",
      message: note,
    });
    expect(f.discord.publish).not.toHaveBeenCalled();
  });
  it("opens after the last entry only when the game confirms it returns to the first", async () => {
    const f = automatic();
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: { ...settings.rotation, currentIndex: 2, currentMap: "Islands" },
    });
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Kavkazi" }, { id: "Europe" }, { id: "Islands" }],
      experiences: [],
      lightings: [],
    });
    f.status({ map: "Islands", rotation: { nowIndex: 2, nextIndex: null } });
    await observeForWindow(f);
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect((await f.service.list(staff)).automatic?.message).toContain("returns to entry 1 after the last entry");
    f.status({ rotation: { nowIndex: 2, nextIndex: 0 } });
    await observeForWindow(f);
    expect(f.store.create.mock.calls[0][0].choices).toEqual([
      { map: "Kavkazi", experiences: [] },
      { map: "Europe", experiences: [] },
    ]);
  });
  it("keeps a ballot open through unrelated settings saves and queues at the fresh revision", async () => {
    const f = await openBallot();
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({ ...settings, revision: "r2" });
    await f.service.tick();
    expect(f.store.cancel).not.toHaveBeenCalled();
    later();
    f.score(95);
    await f.service.tick();
    expect(f.store.claimClose).toHaveBeenCalledWith(f.record.id, true);
    expect(f.store.patchAutomation).toHaveBeenCalledWith(
      f.record.id,
      {
        queue: {
          receiptId: f.record.id,
          before: f.automation.rotation!.fingerprint,
          after: rotationFingerprint({
            ...settings.rotation,
            entries: [settings.rotation.entries[0], settings.rotation.entries[2], settings.rotation.entries[1]],
          }),
          kind: "move",
        },
      },
      ["closing"],
    );
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: "system:map-vote:primary", role: "admin" }),
      expect.objectContaining({ action: "map-next", revision: "r2", entry: { map: "Islands", experiences: [] } }),
    );
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "queued", expect.any(String));
  });
  it("cancels when staff change the rotation itself", async () => {
    const f = await openBallot();
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      revision: "r2",
      rotation: {
        ...settings.rotation,
        entries: [settings.rotation.entries[0], ...settings.rotation.entries.slice(1).reverse()],
      },
    });
    await f.service.tick();
    expect(f.store.cancel).toHaveBeenCalledWith(
      f.record.id,
      expect.any(String),
      expect.anything(),
      "Staff changed the rotation. Votes were not applied.",
      "Staff changed the rotation. Votes were not applied.",
    );
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it.each([
    ["the score reaches 100", { factionScores: leadingScores(100) }, 60],
    // The game moves on to the next entry; the configuration's position follows the live status.
    ["the map changes", { map: "Europe", rotation: { nowIndex: 1, nextIndex: 2 } }, 60],
    ["the next map shows the old final scores", { map: "Europe", rotation: { nowIndex: 1, nextIndex: 2 } }, 92],
    ["the scores reset", { factionScores: leadingScores(0) }, 60],
  ] as [string, StatusPatch, number][])(
    "cancels without queueing when %s before the close",
    async (_, patch, leading) => {
      const f = await openBallot({ leading });
      await f.service.tick();
      later();
      f.status(patch);
      if (patch.map) {
        const settings = await f.game.configuration();
        f.game.configuration.mockResolvedValue({
          ...settings,
          rotation: { ...settings.rotation, currentIndex: 1, currentMap: "Europe" },
        });
      }
      await f.service.tick();
      expect(f.store.cancel).toHaveBeenCalledWith(
        f.record.id,
        expect.any(String),
        expect.anything(),
        "The match ended before voting closed. The rotation continues.",
        expect.any(String),
      );
      expect(f.admin.act).not.toHaveBeenCalled();
    },
  );
  it("cancels when the round tracker sees a new round although the map and score still match", async () => {
    const f = await openBallot({ leading: 30 });
    f.status({ matchSeconds: 600 });
    await f.service.tick();
    expect(f.store.cancel).not.toHaveBeenCalled();
    // The match clock restarts while the scoreboard and rotation position are unchanged.
    later();
    f.status({ matchSeconds: 5 });
    await f.service.tick();
    expect(f.store.cancel).toHaveBeenCalledWith(
      f.record.id,
      expect.any(String),
      expect.anything(),
      "The match ended before voting closed. The rotation continues.",
      expect.any(String),
    );
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it.each([
    [
      "staff reorder the rotation",
      (f: Awaited<ReturnType<typeof openBallot>>, settings: Awaited<ReturnType<typeof f.game.configuration>>) =>
        f.game.configuration.mockResolvedValue({
          ...settings,
          rotation: {
            ...settings.rotation,
            entries: [settings.rotation.entries[0], ...settings.rotation.entries.slice(1).reverse()],
          },
        }),
    ],
    [
      "the round tracker sees a new round",
      (f: Awaited<ReturnType<typeof openBallot>>) => {
        later(1_000);
        f.status({ matchSeconds: 5 });
      },
    ],
  ])("closes without queueing when %s between the close claim and the close", async (_, change) => {
    const f = await openBallot({ leading: 80 });
    f.status({ matchSeconds: 600 });
    await f.service.tick();
    const settings = await f.game.configuration();
    const claim = f.store.claimClose.getMockImplementation()!;
    f.store.claimClose.mockImplementation(async (...args: unknown[]) => {
      const claimed = await claim(...args);
      change(f, settings);
      return claimed;
    });
    later();
    f.status({ factionScores: leadingScores(95), matchSeconds: 615 });
    await f.service.tick();
    expect(f.store.claimClose).toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "cancelled", expect.any(String));
  });
  it("never opens below the game's start threshold, even with a lower saved minimum", async () => {
    const f = automatic("primary", { minPlayers: 10 });
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      fields: [{ id: "minRequiredPlayers", value: 30, editable: true }],
    });
    f.status({ players: { current: 25, max: 100 } });
    await observeForWindow(f);
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "waiting_players",
      message: "Waiting for 30 players before a ballot opens (25/100).",
      players: { current: 25, required: 30 },
    });
    expect(f.discord.publish).not.toHaveBeenCalled();
  });
  it.each([
    [86, 5_000],
    [84, 15_000],
  ])("at %s points, polls again after %s ms", async (leading, delay) => {
    const f = await openBallot({ leading });
    await f.service.tick();
    const timers = jest.spyOn(global, "setTimeout");
    f.service.onApplicationBootstrap();
    expect(timers).toHaveBeenLastCalledWith(expect.any(Function), delay);
    f.service.onModuleDestroy();
    timers.mockRestore();
  });
  it("keeps an open ballot after a restart that reads the same round", async () => {
    const f = await openBallot({ leading: 30 });
    const restarted = f.make().service;
    await restarted.tick();
    expect(f.store.cancel).not.toHaveBeenCalled();
    expect((await restarted.list(staff)).automatic?.message).toBe(
      "Voting is open. Leading score: 30/100; closes at 95.",
    );
  });
  it("closes one observed scoring step early when the next step could end the match", async () => {
    const f = await openBallot({ leading: 70 });
    for (const score of [70, 80, 88]) {
      f.score(score);
      await f.service.tick();
      later();
    }
    expect(f.store.claimClose).not.toHaveBeenCalled();
    expect(f.automation.maxStep).toBe(10);
    f.score(90);
    await f.service.tick();
    expect(f.store.claimClose).toHaveBeenCalledWith(f.record.id, true);
    expect(f.admin.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "map-next" }));
  });
  it("does not count a score jump across a read gap as one scoring step", async () => {
    const f = await openBallot({ leading: 70 });
    await f.service.tick();
    later(25_000);
    f.score(88);
    await f.service.tick();
    expect(f.automation.maxStep).toBe(0);
    expect(f.store.claimClose).not.toHaveBeenCalled();
  });
  it("uses the configured close and reminder scores", async () => {
    const f = await openBallot({
      settings: { closeAtScore: 90, reminders: { midpoint: { score: 40 }, final: { score: 80 } } },
      policy: { midpointReminder: true, finalReminder: true },
    });
    f.score(45);
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledWith(expect.anything(), "midpoint");
    // Reads more than 20 seconds apart: no scoring step is inferred, so the vote stays open.
    later(25_000);
    f.score(80);
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenLastCalledWith(expect.anything(), "final");
    expect(broadcasts(f.admin)).toHaveLength(2);
    for (const [actor, action] of broadcasts(f.admin)) {
      expect(actor.id).toBe("system:map-vote-say:primary");
      expect(action.message).toContain("Closes at 90 points");
      expect(action.message.length).toBeLessThanOrEqual(200);
    }
    later();
    f.score(90);
    await f.service.tick();
    expect(f.store.claimClose).toHaveBeenCalledWith(f.record.id, true);
  });
  it("skips a reminder whose score had passed when the ballot opened", async () => {
    const f = await openBallot({ openedAt: 55, leading: 60, policy: { midpointReminder: true, finalReminder: true } });
    await f.service.tick();
    expect(f.discord.remind).not.toHaveBeenCalled();
    later(25_000);
    f.score(86);
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.discord.remind).toHaveBeenCalledWith(expect.anything(), "final");
  });
  it.each([
    ["in Discord", { discord: true, inGame: false }, 1, 0, "Sent in Discord only."],
    ["in game", { discord: false, inGame: true }, 0, 1, "In game only. Saved"],
  ])("sends a reminder only %s when configured", async (_, channels, discord, game, message) => {
    const f = await openBallot({ settings: { reminders: { midpoint: channels } }, policy: { midpointReminder: true } });
    f.admin.act.mockResolvedValue({ state: "applied", message: "Saved" });
    f.score(55);
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(discord);
    expect(broadcasts(f.admin)).toHaveLength(game);
    expect(f.store.finishReminder).toHaveBeenCalledWith(f.record.id, "midpoint", "applied", message);
  });
  it("sends the update reminder when only it is on, even at or above the switched-off last-chance score", async () => {
    // The last-chance score stays at its default 85; saving accepts it because that reminder is off.
    const f = await openBallot({
      settings: { reminders: { midpoint: { score: 88 } } },
      policy: { midpointReminder: true, finalReminder: false },
    });
    f.score(89);
    await f.service.tick();
    later();
    f.score(90);
    await f.service.tick();
    expect(f.store.claimReminder.mock.calls.map(([, stage]) => stage)).toEqual(["midpoint", "midpoint"]);
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.discord.remind).toHaveBeenCalledWith(expect.anything(), "midpoint");
  });
  it("sends only the reminder the ballot opened with, not one switched on later", async () => {
    const f = await openBallot({ policy: { midpointReminder: false, finalReminder: true } });
    // Staff switch the update reminder on after the ballot opened; the ballot keeps its own switches.
    f.saved.policy = { ...f.saved.policy, midpointReminder: true };
    f.score(60);
    await f.service.tick();
    expect(f.store.claimReminder).not.toHaveBeenCalled();
    later(25_000);
    f.score(86);
    await f.service.tick();
    expect(f.discord.remind).toHaveBeenCalledTimes(1);
    expect(f.discord.remind).toHaveBeenCalledWith(expect.anything(), "final");
  });
  it("announces an automatic ballot in game once, as the voting system", async () => {
    const f = automatic("primary", { announce: { openInGame: true } });
    await observeForWindow(f);
    expect(f.discord.publish).toHaveBeenCalledTimes(1);
    expect(broadcasts(f.admin)).toEqual([
      [
        expect.objectContaining({ id: "system:map-vote-say:primary", role: "admin" }),
        expect.objectContaining({
          action: "broadcast",
          message: "Next round vote is open in Discord #map-voting: Ozeti, Islands. Closes at 95 points.",
        }),
      ],
    ]);
  });
  it("announces a queued or tied result in game without sharing the queue's actor", async () => {
    const queued = await openBallot({ settings: { announce: { resultInGame: true } } });
    queued.score(95);
    await queued.service.tick();
    expect(
      (queued.admin.act.mock.calls as [Staff, { action: string }][]).map(([actor, action]) => [
        actor.id,
        action.action,
      ]),
    ).toEqual([
      ["system:map-vote:primary", "map-next"],
      ["system:map-vote-say:primary", "broadcast"],
    ]);
    expect(broadcasts(queued.admin)[0][1].message).toBe("Vote result: Islands is next (3 of 5 votes).");
    const tied = await openBallot({ settings: { announce: { resultInGame: true } } });
    tied.store.claimClose.mockImplementation(async () => {
      tied.record.state = "closing";
      tied.record.counts = [2, 2];
      tied.record.winner = null;
      return { ...tied.record };
    });
    tied.store.finish.mockImplementation(async (id: string, state: string, message: string) => ({
      ...tied.record,
      id,
      state,
      message,
    }));
    tied.score(95);
    await tied.service.tick();
    expect(broadcasts(tied.admin).map(([, action]) => action.message)).toEqual([
      "Vote tied: the rotation continues with Ozeti Normal.",
    ]);
  });
  it("records a winner that is already next without a game write", async () => {
    const f = await openBallot();
    f.store.claimClose.mockImplementation(async () => {
      f.record.state = "closing";
      f.record.counts = [4, 1];
      f.record.winner = 0;
      return { ...f.record };
    });
    f.score(95);
    await f.service.tick();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      f.record.id,
      "queued",
      "Ozeti · Normal was already next. The rotation was left unchanged.",
    );
  });
  /** A ballot opened on the last entry (Islands) after the game confirmed it returns to entry 1. */
  async function lastRowBallot() {
    const f = await openBallot();
    const settings = await f.game.configuration();
    f.game.configuration.mockResolvedValue({
      ...settings,
      rotation: { ...settings.rotation, currentIndex: 2, currentMap: "Islands" },
    });
    f.game.catalog.mockResolvedValue({
      maps: [{ id: "Kavkazi" }, { id: "Europe" }, { id: "Islands" }],
      experiences: [],
      lightings: [],
    });
    Object.assign(f.record, { currentIndex: 2, currentMap: "Islands" });
    f.record.choices = [
      { map: "Kavkazi", experiences: [] },
      { map: "Europe", experiences: [] },
    ];
    Object.assign(f.automation.round!, { map: "Islands", index: 2 });
    Object.assign(f.automation.rotation!, {
      currentIndex: 2,
      nextSlot: 0,
      nextKey: voteChoiceKey(settings.rotation.entries[0]),
    });
    f.status({ map: "Islands", rotation: { nowIndex: 2, nextIndex: 0 } });
    // Europe, an earlier row, wins: planned as a swap into the first slot.
    return f;
  }
  it("swaps an earlier winner into the first slot after the last entry while the game confirms the wrap", async () => {
    const f = await lastRowBallot();
    f.score(95);
    await f.service.tick();
    expect(f.store.patchAutomation).toHaveBeenCalledWith(
      f.record.id,
      { queue: expect.objectContaining({ kind: "swap" }) },
      ["closing"],
    );
    expect(f.admin.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: "system:map-vote:primary" }),
      expect.objectContaining({ action: "map-next", currentIndex: 2, nextSlot: 0 }),
    );
    expect(actionSchema.safeParse(f.admin.act.mock.calls[0][1]).success).toBe(true);
  });
  it("closes without queueing when the game stops confirming the wrap before the close", async () => {
    const f = await lastRowBallot();
    f.score(30);
    await f.service.tick();
    later();
    // A transient read omits nextIndex: Europe would be appended as a duplicate last row.
    f.status({ factionScores: leadingScores(95), rotation: { nowIndex: 2, nextIndex: null } });
    await f.service.tick();
    expect(f.store.claimClose).toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.patchAutomation).not.toHaveBeenCalledWith(
      f.record.id,
      expect.objectContaining({ queue: expect.anything() }),
      expect.anything(),
    );
    expect(f.store.finish).toHaveBeenCalledWith(
      f.record.id,
      "cancelled",
      "The game no longer confirms it returns to entry 1 after the last entry, so the winner was not queued. The rotation continues.",
    );
  });
  it("closes cleanly and keeps voting automatic when the game refuses the winner", async () => {
    const f = await openBallot();
    f.admin.act.mockResolvedValue({ state: "failed", message: "Keep the rotation to 100 entries or fewer." });
    f.score(95);
    await f.service.tick();
    expect(f.store.finish).toHaveBeenCalledWith(
      f.record.id,
      "cancelled",
      "Not queued: Keep the rotation to 100 entries or fewer. The rotation continues.",
      { outcome: "refused" },
    );
  });
});

describe("ballots that need review", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  async function review(patch: Partial<MapVoteRecord> = {}, automation: Partial<VoteAutomation> = {}) {
    const f = await openBallot();
    const vote: MapVoteRecord = {
      ...f.record,
      state: "needs_review",
      message: "Discord publication could not be confirmed.",
      createdAt: new Date(now.getTime() - 180_000),
      updatedAt: new Date(now.getTime() - 180_000),
      ...patch,
      automation: { ...f.automation, ...automation },
    };
    f.store.needsReview.mockResolvedValue([vote]);
    f.store.history.mockImplementation(async () => [vote]);
    f.store.automaticOpen.mockResolvedValue([]);
    return { ...f, vote };
  }
  const queue = { receiptId: "r", before: "b", after: "a", kind: "move" as const };
  it("closes a late-published ballot without counting it", async () => {
    const f = await review({ messageId: null });
    f.discord.findBallotMessage.mockResolvedValue("999999999999999999");
    await f.service.tick();
    expect(f.store.resolveReview).toHaveBeenCalledWith(
      f.vote.id,
      "cancelled",
      "Published late; closed without counting. A new ballot opens next round.",
      expect.objectContaining({
        outcome: "unposted",
        resolution: expect.objectContaining({ by: "system:reconcile" }),
      }),
      "999999999999999999",
    );
    expect(f.discord.update).toHaveBeenCalled();
    expect(f.discord.publish).not.toHaveBeenCalled();
  });
  it("closes an unposted ballot after two minutes, but not while Discord is unreachable", async () => {
    const posted = await review({ messageId: null });
    await posted.service.tick();
    expect(posted.store.resolveReview).toHaveBeenCalledWith(
      posted.vote.id,
      "cancelled",
      "The ballot could not be posted. A new ballot opens next round.",
      expect.objectContaining({ outcome: "unposted" }),
      undefined,
    );
    const young = await review({ messageId: null, createdAt: now });
    await young.service.tick();
    const offline = await review({ messageId: null });
    offline.discord.findBallotMessage.mockRejectedValue(new Error("Discord is not ready"));
    await offline.service.tick();
    expect(young.store.resolveReview).not.toHaveBeenCalled();
    expect(offline.store.resolveReview).not.toHaveBeenCalled();
  });
  it.each([
    ["the rotation already shows the winner", "after", null, "queued"],
    ["the rotation is unchanged", "before", null, "cancelled"],
    ["the receipt confirms the write", "neither", "pending", "queued"],
    ["the receipt shows a refusal", "neither", "failed", "cancelled"],
    ["no receipt exists", "neither", null, "cancelled"],
  ] as const)("settles an unconfirmed queue when %s", async (_, match, receipt, state) => {
    const settings = await fixture().game.configuration();
    const current = rotationFingerprint(settings.rotation);
    const f = await review(
      {},
      {
        queue: {
          ...queue,
          before: match === "before" ? current : "before",
          after: match === "after" ? current : "after",
        },
      },
    );
    f.admin.receipt.mockResolvedValue({ record: receipt ? { state: receipt, message: "Refused." } : null });
    await f.service.tick();
    expect(f.store.resolveReview).toHaveBeenCalledWith(
      f.vote.id,
      state,
      expect.any(String),
      expect.objectContaining({ resolution: expect.objectContaining({ to: state }) }),
      undefined,
    );
    if (receipt === "failed") expect(f.store.resolveReview.mock.calls[0][3]).toMatchObject({ outcome: "refused" });
  });
  it("alerts staff once after two minutes and once more after thirty, and shows the pause", async () => {
    const f = await review({}, { queue });
    f.admin.receipt.mockResolvedValue({ record: { state: "unknown", message: "Unconfirmed." } });
    await f.service.tick();
    expect(f.store.resolveReview).not.toHaveBeenCalled();
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    expect(f.alerts.send).toHaveBeenCalledWith(
      "primary",
      `map-vote-review:${f.vote.id}`,
      expect.stringContaining("needs staff review"),
    );
    expect(f.store.patchAutomation).toHaveBeenCalledWith(
      f.vote.id,
      { alert: { firstAt: now.toISOString(), lastAt: now.toISOString(), count: 1 } },
      ["needs_review"],
    );
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "paused_review",
      message: "Paused: the 09:57 UTC ballot needs staff review: Discord publication could not be confirmed.",
    });
    f.vote.automation!.alert = { firstAt: now.toISOString(), lastAt: now.toISOString(), count: 1 };
    later(10 * 60_000);
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    later(21 * 60_000);
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledTimes(2);
    f.vote.automation!.alert = { firstAt: now.toISOString(), lastAt: now.toISOString(), count: 2 };
    later(60 * 60_000);
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledTimes(2);
  });
  it("does not alert during the first two minutes of review", async () => {
    const f = await review({ updatedAt: now }, { queue });
    f.admin.receipt.mockResolvedValue({ record: { state: "started", message: "Started." } });
    await f.service.tick();
    expect(f.store.resolveReview).not.toHaveBeenCalled();
    expect(f.alerts.send).not.toHaveBeenCalled();
  });
  it("pauses after three refused results under the same controls until they are saved again", async () => {
    const f = automatic();
    const refused = (minutes: number): MapVoteRecord => ({
      ...f.record,
      id: randomUUID(),
      state: "cancelled",
      message: "Not queued: The current round changed. The rotation continues.",
      createdAt: new Date(now.getTime() - minutes * 60_000),
      automation: {
        policy: defaultVotingPolicy,
        highestScore: 95,
        reminders: {},
        policyVersion: 1,
        outcome: "refused",
      },
    });
    const history = [refused(20), refused(60), refused(100)];
    f.store.history.mockResolvedValue(history);
    await f.service.tick();
    expect((await f.service.list(staff)).automatic).toMatchObject({
      phase: "paused",
      message:
        "Paused after 3 refused results (Not queued: The current round changed. The rotation continues.). Save the voting controls to resume.",
    });
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    expect(f.store.patchAutomation).toHaveBeenCalledWith(
      history[0].id,
      expect.objectContaining({ alert: expect.anything() }),
      ["cancelled"],
    );
    history[0].automation!.alert = { firstAt: now.toISOString(), lastAt: now.toISOString(), count: 1 };
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    f.saved.version = 2;
    await f.service.tick();
    expect((await f.service.list(staff)).automatic?.phase).not.toBe("paused");
  });
  it("keeps voting automatic after 50v50 winners that could not start", async () => {
    const f = automatic();
    const unready = (minutes: number): MapVoteRecord => ({
      ...f.record,
      id: randomUUID(),
      state: "cancelled",
      message: "50v50 could not start: 75 of 80 players online. Ozeti plays with normal teams.",
      createdAt: new Date(now.getTime() - minutes * 60_000),
      automation: {
        policy: defaultVotingPolicy,
        highestScore: 95,
        reminders: {},
        policyVersion: 1,
        outcome: "fifty_unready",
      },
    });
    f.store.history.mockResolvedValue([unready(20), unready(60), unready(100)]);
    await f.service.tick();
    expect((await f.service.list(staff)).automatic?.phase).not.toBe("paused");
    expect(f.alerts.send).not.toHaveBeenCalled();
  });
});

describe("customizable voting controls", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  const stored = {
    ...defaultVotingPolicy,
    settings: {
      closeAtScore: 90,
      source: "pool",
      pool: [
        { map: "Europe", experiences: [] },
        { map: "Islands", experiences: [] },
      ],
    },
  } as StoredVotingPolicy;
  function saving() {
    const f = fixture(false);
    let written: StoredVotingPolicy | null = null;
    f.store.savePolicy.mockImplementation(
      async (_server: string, _version: number, next: (previous: StoredVotingPolicy) => StoredVotingPolicy) => {
        written = next(stored);
        return { saved: written, closed: [] };
      },
    );
    return { ...f, written: () => written! };
  }
  it("keeps saved settings when the original dashboard saves only the switches", async () => {
    const f = saving();
    await f.service.saveControls(staff, {
      serverId: "primary",
      version: 3,
      policy: { ...defaultVotingPolicy, modeChoices: true },
    });
    expect(f.written()).toMatchObject({ ...defaultVotingPolicy, modeChoices: true });
    expect(f.written().settings).toMatchObject({ closeAtScore: 90, source: "pool", pool: stored.settings!.pool });
  });
  it("merges a partial settings save and replaces the map pool whole", async () => {
    const f = saving();
    const pool = [
      { map: "Kavkazi", experiences: [] },
      { map: "Islands", experiences: [] },
    ];
    await f.service.saveControls(staff, {
      serverId: "primary",
      version: 3,
      policy: defaultVotingPolicy,
      settings: { reminders: { final: { score: 80 } }, pool },
    });
    expect(f.written().settings).toMatchObject({
      closeAtScore: 90,
      reminders: {
        midpoint: defaultVotingSettings.reminders.midpoint,
        final: { score: 80, discord: true, inGame: true },
      },
      pool,
    });
  });
  it.each([
    [
      { openScoreCeiling: 88 },
      ["settings", "openScoreCeiling"],
      "Close score must be at least 5 points above the opening ceiling.",
    ],
    [{ optionCount: 9 }, ["settings", "optionCount"], "Options per ballot must be a whole number from 2 to 5."],
  ])("names the field of an invalid setting: %j", async (settings, path, message) => {
    const f = saving();
    const error = await f.service
      .saveControls(staff, { serverId: "primary", version: 3, policy: defaultVotingPolicy, settings })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(400);
    expect((error as HttpException).getResponse()).toMatchObject({ message, path });
  });
  it("enforces the request shape and reports a concurrent save", async () => {
    const f = saving();
    await expect(
      f.service.saveControls(staff, { serverId: "primary", version: 3, policy: defaultVotingPolicy, extra: 1 }),
    ).rejects.toMatchObject({ status: 400, message: "Review the voting controls for the selected server." });
    await expect(
      f.service.saveControls(staff, {
        serverId: "primary",
        version: 3,
        policy: { ...defaultVotingPolicy, settings: {} },
      }),
    ).rejects.toMatchObject({ status: 400 });
    f.store.savePolicy.mockRejectedValue(new ConflictException("Voting controls changed. Refresh before saving."));
    await expect(
      f.service.saveControls(staff, { serverId: "primary", version: 3, policy: defaultVotingPolicy }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("returns only the five switches as the policy, with settings, limits and game context", async () => {
    const f = fixture(false);
    f.store.policy.mockResolvedValue({
      serverId: "primary",
      version: 4,
      actorId: staff.id,
      connectionHash: f.record.connectionHash,
      policy: stored,
    });
    const controls = await f.service.controls(staff);
    expect(controls.policy).toEqual(defaultVotingPolicy);
    expect(controls.settings).toMatchObject({ closeAtScore: 90, source: "pool", optionCount: 3 });
    expect(controls.limits?.optionCount).toEqual({ min: 2, max: 5 });
    expect(controls.context).toMatchObject({
      startThreshold: 20,
      factions: [],
      routes: { kill: false, message: false },
    });
  });
});

describe("previewing the next automatic ballot", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  it("shows the options a draft would offer and why no ballot would open yet, without recording anything", async () => {
    const f = automatic();
    f.status({ players: { current: 23, max: 100 } });
    const preview = await f.service.preview(staff, {
      serverId: "primary",
      settings: { minPlayers: 20, optionCount: 2 },
    });
    expect(preview).toMatchObject({
      phase: "waiting_delay",
      blocked: "Opens in 3:00, 180 seconds into the round.",
      players: { current: 23, required: 20 },
      next: { label: "Ozeti · Map defaults" },
      options: [
        { label: "Ozeti · Normal", kind: "map", placement: "already-next" },
        { label: "Islands · Normal", kind: "map", placement: "move" },
      ],
      fifty: { offered: false },
    });
    expect(f.rounds.current("primary")).toBeNull();
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.store.savePolicy).not.toHaveBeenCalled();
    expect(f.discord.publish).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    await expect(f.service.preview(staff, { serverId: "primary" })).rejects.toMatchObject({ status: 429 });
    later(5_000);
    expect((await f.service.preview(staff, { serverId: "primary" })).blocked).toBe(
      "Waiting for 40 players before a ballot opens (23/100).",
    );
  });
  it("refuses an invalid draft or another server", async () => {
    const f = automatic();
    await expect(f.service.preview(staff, { serverId: "primary", settings: { optionCount: 7 } })).rejects.toMatchObject(
      { status: 400 },
    );
    later(5_000);
    await expect(f.service.preview(staff, { serverId: "other" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("a 50v50 option on automatic ballots", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  const offered = { fiftyFifty: { offered: true, minPlayers: 40, minVotes: 3 } };
  it("offers 50v50 on the next entry as the last option only when every readiness check passes", async () => {
    const waiting = automatic("primary", offered);
    waiting.events.voteEventReadiness.mockResolvedValue({ ok: false, reason: "64 of 80 players online" });
    await observeForWindow(waiting);
    expect(waiting.store.create.mock.calls[0][0].choices).toEqual([
      { map: "Europe", experiences: [] },
      { map: "Islands", experiences: [] },
    ]);
    expect((await waiting.service.list(staff)).automatic?.fifty).toEqual({
      offered: false,
      reason: "50v50 not offered: 64 of 80 players online.",
    });
    const ready = automatic("primary", offered);
    ready.events.voteEventReadiness.mockResolvedValue({ ok: true });
    await observeForWindow(ready);
    expect(ready.store.create.mock.calls[0][0].choices).toEqual([
      { map: "Europe", experiences: [] },
      { map: "Islands", experiences: [] },
      { map: "Europe", experiences: [], event: "50v50" },
    ]);
    // The readiness check receives the settings, the live round and the automatic ballots for the cooldown.
    expect(ready.events.voteEventReadiness).toHaveBeenCalledWith(
      "primary",
      expect.objectContaining({ offered: true, minPlayers: 40 }),
      expect.objectContaining({ revision: "r1" }),
      expect.objectContaining({ status: expect.objectContaining({ map: "Kavkazi" }) }),
      expect.objectContaining({ phase: "live" }),
      [],
    );
    expect((await ready.service.list(staff)).automatic?.fifty).toEqual({
      offered: true,
      reason: "Offered as the last option.",
    });
    const off = automatic();
    await observeForWindow(off);
    expect(off.events.voteEventReadiness).not.toHaveBeenCalled();
  });
  /** An open ballot whose 50v50 option won outright with 8 of 10 votes. */
  async function fiftyWon(settings: DeepPartial<VotingSettings> = offered) {
    const f = await openBallot({ settings: settings as DeepPartial<VotingSettings> });
    f.record.choices = [
      { map: "Europe", experiences: [] },
      { map: "Europe", experiences: [], event: "50v50" },
    ];
    f.store.claimClose.mockImplementation(async () => {
      f.record.state = "closing";
      f.record.counts = [2, 8];
      f.record.winner = 1;
      return { ...f.record };
    });
    f.store.finish.mockImplementation(
      async (id: string, state: string, message: string, patch?: Partial<VoteAutomation>) => ({
        ...f.record,
        id,
        state,
        message,
        automation: { ...f.record.automation!, ...patch },
      }),
    );
    f.score(95);
    return f;
  }
  it("arms the event for the next round without any queue change or result broadcast", async () => {
    const f = await fiftyWon({ ...offered, announce: { resultInGame: true } });
    f.saved.actorName = "Dennis";
    await f.service.tick();
    expect(f.events.startFromVote).toHaveBeenCalledWith({
      voteId: f.record.id,
      serverId: "primary",
      actor: expect.objectContaining({ id: staff.id, name: "Dennis", role: "admin" }),
      fifty: expect.objectContaining({ offered: true, minPlayers: 40, minVotes: 3, rounds: 1, autoEnd: true }),
      // The offer minimum less 10 players who may leave as the voted round ends.
      minPlayers: 30,
      votes: 8,
      total: 10,
      label: "Ozeti",
    });
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.patchAutomation).not.toHaveBeenCalledWith(
      f.record.id,
      expect.objectContaining({ queue: expect.anything() }),
      expect.anything(),
    );
    expect(f.store.finish).toHaveBeenCalledWith(
      f.record.id,
      "queued",
      "50v50 chosen (8 of 10 votes). Next round on Ozeti runs as 50v50; teams are sorted at round start; normal teams return after 1 round.",
      { event: { id: f.record.id } },
    );
  });
  it.each([
    [
      "too few votes",
      { ...offered, fiftyFifty: { ...offered.fiftyFifty, minVotes: 9 } },
      "50v50 won but it needed 9 votes and had 8. The rotation continues with normal teams.",
    ],
    [
      "too few players at the close",
      { ...offered, fiftyFifty: { ...offered.fiftyFifty, minPlayers: 80 } },
      "50v50 won but only 60 players are online (70 needed). The rotation continues with normal teams.",
    ],
  ] as const)("keeps normal teams when there are %s", async (_, settings, message) => {
    const f = await fiftyWon(settings as DeepPartial<VotingSettings>);
    await f.service.tick();
    expect(f.events.startFromVote).not.toHaveBeenCalled();
    expect(f.admin.act).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(f.record.id, "cancelled", message);
  });
  it("keeps normal teams when the event refuses cleanly", async () => {
    const f = await fiftyWon();
    f.events.startFromVote.mockRejectedValue(
      new ConflictException("Another optional event is active or needs review."),
    );
    await f.service.tick();
    expect(f.store.finish).toHaveBeenCalledWith(
      f.record.id,
      "cancelled",
      "50v50 could not start: Another optional event is active or needs review. Ozeti plays with normal teams; the rotation was left unchanged.",
      // Not a queue refusal: it never counts towards pausing automatic voting.
      { outcome: "fifty_unready" },
    );
    expect(f.admin.act).not.toHaveBeenCalled();
  });
  it.each([
    ["recorded", { state: "preparing" }, "queued"],
    ["missing", null, "needs_review"],
  ] as const)(
    "settles an unexpected start error from the event store when the event is %s",
    async (_, event, state) => {
      const f = await fiftyWon();
      f.events.startFromVote.mockRejectedValue(new Error("connection reset"));
      f.events.voteEvent.mockResolvedValue(event);
      await f.service.tick();
      expect(f.store.finish).toHaveBeenCalledWith(
        f.record.id,
        state,
        expect.any(String),
        ...(state === "queued" ? [{ event: { id: f.record.id } }] : []),
      );
    },
  );
  it.each([
    ["the event is recorded", { state: "preparing" }, "queued"],
    ["no event was recorded", null, "cancelled"],
  ] as const)("rechecks an unconfirmed 50v50 start when %s", async (_, event, state) => {
    const f = await openBallot();
    const vote: MapVoteRecord = {
      ...f.record,
      state: "needs_review",
      winner: 1,
      counts: [2, 8],
      choices: [
        { map: "Europe", experiences: [] },
        { map: "Europe", experiences: [], event: "50v50" },
      ],
      message: "The 50v50 start is unconfirmed.",
      updatedAt: new Date(now.getTime() - 180_000),
    };
    f.store.needsReview.mockResolvedValue([vote]);
    f.store.history.mockImplementation(async () => [vote]);
    f.store.automaticOpen.mockResolvedValue([]);
    f.events.voteEvent.mockResolvedValue(event);
    await f.service.tick();
    expect(f.store.resolveReview).toHaveBeenCalledWith(
      vote.id,
      state,
      expect.any(String),
      expect.objectContaining({ resolution: expect.objectContaining({ to: state }) }),
      undefined,
    );
    // No map-next was sent for a 50v50, so the action receipt is never consulted.
    expect(f.admin.receipt).not.toHaveBeenCalled();
  });
  it("shows and alerts staff once when a voted 50v50 needs review", async () => {
    const f = automatic();
    const linked = {
      ...f.record,
      state: "queued" as const,
      automation: { policy: defaultVotingPolicy, highestScore: 95, reminders: {}, event: { id: f.record.id } },
    };
    f.store.history.mockResolvedValue([linked]);
    f.events.voteEvent.mockResolvedValue({ state: "needs_review", stop: null, message: "The endpoint changed." });
    await f.service.tick();
    await f.service.tick();
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    expect(f.alerts.send).toHaveBeenCalledWith(
      "primary",
      `event-review:${f.record.id}`,
      expect.stringContaining("needs staff review"),
    );
    expect((await f.service.list(staff)).automatic?.alert?.message).toContain(
      "The 50v50 chosen by the 10:00 UTC ballot needs staff review: The endpoint changed.",
    );
    f.events.voteEvent.mockResolvedValue({ state: "complete", stop: null, message: "Done." });
    await f.service.tick();
    expect((await f.service.list(staff)).automatic?.alert).toBeFalsy();
  });
  it("reports 50v50 readiness in setup and the controls context", async () => {
    const f = automatic("primary", offered);
    f.environment.SERVER_EVENTS_ENABLED = true;
    f.events.voteEventReadiness.mockResolvedValue({ ok: false, reason: "the server is waiting for players" });
    const setup = await f.service.setup(staff);
    expect(setup.checks.find((check) => check.label === "50v50 option")).toEqual({
      label: "50v50 option",
      status: "review",
      message: "Offered, but not right now: the server is waiting for players.",
    });
    f.game.capabilities.mockResolvedValue({ routes: ["PATCH /v1/players/{id}", "POST /v1/broadcast"] });
    expect((await f.service.controls(staff)).context?.fifty).toMatchObject({ available: true });
    f.environment.SERVER_EVENTS_ENABLED = false;
    expect((await f.service.controls(staff)).context?.fifty).toMatchObject({
      available: false,
      message: expect.stringContaining("Optional events are off in Gramps"),
    });
  });
});
