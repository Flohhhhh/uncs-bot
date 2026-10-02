import { Logger } from "@nestjs/common";
import type { EnvService } from "../env/env.service";
import { RconError } from "../admin/rcon-protocol";
import { EnvWatchlistSource, withTimeout } from "./network-bans";
import { snapshot, workerFixture } from "./staff-alerts.fixture";

const listed = "76561198000000001",
  noted = "76561198000000002",
  clean = "76561198000000003";
const watchlist = [
  {
    steamId: listed,
    reason: "Aimbot",
    evidenceUrl: "https://example.com/clip",
    communities: 4,
    recordedAt: "2026-10-02",
    addedBy: "Dennis",
  },
  { steamId: noted, reason: "Teamkilling", source: "staff" as const },
];
const env = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as EnvService;
const enabled = { STAFF_ALERTS_ENABLED: true, STAFF_ALERTS_WATCHLIST_ENABLED: true, STAFF_ALERTS_WATCHLIST: watchlist };

describe("network-ban sources", () => {
  it("looks up only the requested SteamIDs in the staff watch list", async () => {
    const source = new EnvWatchlistSource(env(enabled));
    expect(source.name).toBe("Staff watch list");
    const found = await source.lookup([listed, noted, clean], new AbortController().signal);
    expect([...found.keys()]).toEqual([listed, noted]);
    expect(found.get(listed)).toEqual({
      steamId: listed,
      communities: 4,
      reasons: ["Aimbot"],
      evidenceUrls: ["https://example.com/clip"],
      recordedAt: "2026-10-02",
      source: "wardogs-network",
      addedBy: "Dennis",
    });
    expect(found.get(noted)).toMatchObject({ communities: null, evidenceUrls: [], recordedAt: null, source: "staff" });
    expect((await source.lookup([clean], new AbortController().signal)).size).toBe(0);
  });

  it("returns nothing when the watch list or staff alerts are off", async () => {
    for (const values of [
      { ...enabled, STAFF_ALERTS_WATCHLIST_ENABLED: false },
      { ...enabled, STAFF_ALERTS_ENABLED: false },
      { ...enabled, STAFF_ALERTS_WATCHLIST: undefined },
    ])
      expect((await new EnvWatchlistSource(env(values)).lookup([listed], new AbortController().signal)).size).toBe(0);
  });

  it("refuses a cancelled lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new EnvWatchlistSource(env(enabled)).lookup([listed], controller.signal)).rejects.toThrow("cancelled");
  });

  describe("lookup timeouts", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("resolves a lookup that answers in time", async () => {
      await expect(withTimeout(async () => "found", 3_000)).resolves.toBe("found");
    });

    it("rejects and aborts a lookup that takes longer than its budget", async () => {
      let signal: AbortSignal | undefined;
      const pending = withTimeout((given) => {
        signal = given;
        return new Promise<never>(() => undefined);
      }, 3_000);
      const assertion = expect(pending).rejects.toThrow("timed out");
      await jest.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
    });

    it("rejects a lookup that fails or throws", async () => {
      await expect(withTimeout(() => Promise.reject(new Error("upstream said x")), 3_000)).rejects.toThrow(
        "upstream said x",
      );
      await expect(
        withTimeout(() => {
          throw "not an error";
        }, 3_000),
      ).rejects.toThrow("failed");
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe("watch-list joins", () => {
  const entries = [
    {
      steamId: listed,
      reason: "Aimbot",
      evidenceUrl: "https://example.com/clip",
      communities: 4,
      recordedAt: "2026-10-02",
      addedBy: "Dennis",
    },
    { steamId: noted, reason: "Teamkilling", communities: 2 },
  ];
  const values = { STAFF_ALERTS_WATCHLIST_ENABLED: true, STAFF_ALERTS_WATCHLIST: entries };
  const sourceFor = (extra: Record<string, unknown> = {}) =>
    new EnvWatchlistSource(env({ STAFF_ALERTS_ENABLED: true, ...values, ...extra }));
  const roster = (...players: string[]) =>
    snapshot(players.map((steamId) => ({ steamId, name: steamId === listed ? "Listed **Name**" : "Player" })));
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(Date.parse("2026-10-02T23:00:00Z"));
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("alerts on a listed join, highlighting at the community threshold, as monitoring only", async () => {
    const { pass, alerts, game, discord } = workerFixture(values, { sources: [sourceFor()] });
    await pass(roster(clean), 0);
    await pass(roster(clean, listed, noted));
    const [second, first] = alerts.list("primary");
    expect([first.player?.steamId, first.severity, first.title]).toEqual([listed, "high", "Watch list: player joined"]);
    expect([second.player?.steamId, second.severity]).toEqual([noted, "warning"]);
    expect(first.lines).toEqual([
      "Listed **Name** joined.",
      "Banned in 4 communities (as recorded 2026-10-02). Reason: Aimbot.",
      "Added to the watch list by Dennis.",
      "Monitoring only. Gramps took no action. A ban works only while the player is online.",
    ]);
    expect(first.network).toMatchObject({
      source: "wardogs-network",
      sourceName: "Staff watch list",
      communities: 4,
      evidenceUrls: ["https://example.com/clip"],
      presentAtStart: false,
      knownGood: false,
    });
    const text = JSON.stringify(alerts.list("primary").map((alert) => [alert.title, alert.lines]));
    expect(text).not.toMatch(/ban here|will be banned|banned automatically|auto-?ban|queued/i);
    expect(discord.channel.send).toHaveBeenCalledTimes(2);
    expect(game.execute).not.toHaveBeenCalled();
  });

  it("checks the roster online when Gramps starts once, then only joins", async () => {
    const lookup = jest.spyOn(EnvWatchlistSource.prototype, "lookup");
    const { pass, alerts } = workerFixture(values, { sources: [sourceFor()] });
    await pass(roster(listed, clean), 0);
    expect(lookup).toHaveBeenLastCalledWith([listed, clean], expect.anything());
    expect(alerts.list("primary")[0]).toMatchObject({
      title: "Watch list: player online",
      network: { presentAtStart: true },
    });
    expect(alerts.list("primary")[0].lines[0]).toBe("Listed **Name** was online when Gramps started.");
    // A later read gap is a new baseline, but not a new start: nobody is re-checked.
    await pass(roster(listed, clean), 5 * 60_000);
    await pass(roster(listed, clean));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(alerts.list("primary")).toHaveLength(1);
  });

  it("alerts again only after the cooldown, for a join after the leave grace", async () => {
    const { pass, alerts } = workerFixture(
      { ...values, STAFF_ALERTS_WATCHLIST_COOLDOWN_MINUTES: 30 },
      { sources: [sourceFor()] },
    );
    await pass(roster(clean), 0);
    await pass(roster(clean, listed));
    expect(alerts.list("primary")).toHaveLength(1);
    // Gone past the 60-second leave grace, then back within the 30-minute cooldown.
    for (let index = 0; index < 8; index++) await pass(roster(clean));
    await pass(roster(clean, listed));
    expect(alerts.list("primary")).toHaveLength(1);
    // Brief absence inside the leave grace is not a join at all.
    await pass(roster(clean));
    await pass(roster(clean, listed));
    for (let minute = 0; minute < 30; minute++) {
      await pass(roster(clean), 20_000);
      await pass(roster(clean), 20_000);
      await pass(roster(clean), 20_000);
    }
    await pass(roster(clean, listed));
    expect(alerts.list("primary")).toHaveLength(2);
  });

  it("raises nothing and reports the source when a lookup fails or times out", async () => {
    const failing = { name: "Remote test source", lookup: jest.fn().mockRejectedValue(new Error(`detail ${listed}`)) };
    const { pass, alerts, worker } = workerFixture(values, { sources: [failing] });
    await pass(roster(clean), 0);
    await pass(roster(clean, listed));
    // Once for the roster at start, once for the join; neither is retried in the same pass.
    expect(failing.lookup.mock.calls.map(([steamIds]) => steamIds)).toEqual([[clean], [listed]]);
    expect(alerts.list("primary")).toEqual([]);
    expect(worker.view().sources).toEqual([
      { name: "Remote test source", error: "The lookup failed or took longer than 3 seconds.", at: expect.any(String) },
    ]);
    const logged = (Logger.prototype.warn as jest.Mock).mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged).toEqual(Array(2).fill('Network ban source "Remote test source" failed for primary.'));

    const slow = { name: "Slow source", lookup: jest.fn(() => new Promise<never>(() => undefined)) };
    const late = workerFixture(values, { sources: [slow] });
    const run = async (next: ReturnType<typeof roster>) => {
      late.game.set(next);
      const tick = late.worker.tick();
      await jest.advanceTimersByTimeAsync(3_000);
      return tick;
    };
    await run(roster(clean));
    await run(roster(clean, listed));
    expect(slow.lookup).toHaveBeenCalledTimes(2);
    expect(late.alerts.list("primary")).toEqual([]);
    expect(late.worker.view().sources[0].error).toContain("3 seconds");
  });

  it("alerts on a listed join across one failed read, during an outage and in the first read after a map load", async () => {
    // One failed read at the normal cadence.
    const blip = workerFixture(values, { sources: [sourceFor()] });
    await blip.pass(roster(clean), 0);
    await blip.pass(roster(clean), 15_000);
    blip.game.overview.mockRejectedValueOnce(
      new RconError("The game server could not be reached.", false, "unreachable"),
    );
    await blip.pass(undefined, 15_000);
    await blip.pass(roster(clean, listed), 30_000);
    expect(blip.alerts.list("primary").map((alert) => [alert.player?.steamId, alert.title])).toEqual([
      [listed, "Watch list: player joined"],
    ]);

    // Ten minutes of rejected credentials while the game keeps running.
    const outage = workerFixture(values, { sources: [sourceFor()] });
    await outage.pass(roster(clean), 0);
    outage.game.failWith(new RconError("RCON rejected the credentials.", false, "rejected"));
    for (let read = 0; read < 20; read++) await outage.pass(undefined, 30_000);
    outage.game.failWith(null);
    await outage.pass(roster(clean, listed), 30_000);
    expect(outage.alerts.list("primary").map((alert) => alert.player?.steamId)).toEqual([listed]);

    // A map load: the roster empties, then the listed player is in the first returning read.
    const load = workerFixture(values, { sources: [sourceFor()] });
    const next = {
      map: "Europe",
      matchSeconds: 5,
      factionScores: [
        { name: "Lonestar", score: 0 },
        { name: "Valkyra", score: 0 },
      ],
    };
    await load.pass(roster(clean), 0);
    await load.pass(roster(clean));
    await load.pass(snapshot([], next));
    await load.pass(snapshot([], next));
    await load.pass(
      snapshot(
        [
          { steamId: clean, name: "Player" },
          { steamId: listed, name: "Listed" },
        ],
        next,
      ),
    );
    expect(load.alerts.list("primary").map((alert) => alert.player?.steamId)).toEqual([listed]);
  });

  it("does not re-check players who stay online through an outage or a map load", async () => {
    const lookup = jest.spyOn(EnvWatchlistSource.prototype, "lookup");
    const { pass, game } = workerFixture(values, { sources: [sourceFor()] });
    await pass(roster(clean), 0);
    game.failWith(new RconError("The game server could not be reached.", false, "unreachable"));
    for (let read = 0; read < 10; read++) await pass(undefined, 30_000);
    game.failWith(null);
    await pass(roster(clean), 30_000);
    await pass(snapshot([], { map: "Europe", matchSeconds: 5 }), 15_000);
    for (let read = 0; read < 8; read++) await pass(snapshot([], { map: "Europe", matchSeconds: 5 }), 15_000);
    await pass(snapshot([{ steamId: clean, name: "Player" }], { map: "Europe", matchSeconds: 5 }), 15_000);
    expect(lookup.mock.calls.map(([steamIds]) => steamIds)).toEqual([[clean]]);
  });

  it("alerts when a listed player who was online before a long empty or failed stretch comes back", async () => {
    // Overnight: the listed player leaves last, the roster stays empty for ten hours, and they seed first.
    const night = workerFixture(values, { sources: [sourceFor()] });
    await night.pass(roster(clean), 0);
    await night.pass(roster(clean, listed));
    await night.pass(roster(listed));
    for (let read = 0; read < 40; read++) await night.pass(roster(), 15 * 60_000);
    await night.pass(roster(listed));
    expect(night.alerts.list("primary").map((alert) => alert.title)).toEqual([
      "Watch list: player joined",
      "Watch list: player joined",
    ]);

    // The game goes down with everyone on, and the listed player is in the first read ten hours later.
    const crash = workerFixture(values, { sources: [sourceFor()] });
    await crash.pass(roster(clean), 0);
    await crash.pass(roster(clean, listed));
    crash.game.failWith(new RconError("The game server could not be reached.", false, "unreachable"));
    for (let read = 0; read < 40; read++) await crash.pass(undefined, 15 * 60_000);
    crash.game.failWith(null);
    await crash.pass(roster(listed, clean), 30_000);
    expect(crash.alerts.list("primary")).toHaveLength(2);

    // An empty roster for longer than a map load shows the listed player left, even when they come back first.
    const short = workerFixture({ ...values, STAFF_ALERTS_WATCHLIST_COOLDOWN_MINUTES: 10 }, { sources: [sourceFor()] });
    await short.pass(roster(clean), 0);
    await short.pass(roster(clean, listed));
    await short.pass(roster(listed));
    for (let read = 0; read < 80; read++) await short.pass(roster(), 15_000);
    await short.pass(roster(listed));
    expect(short.alerts.list("primary")).toHaveLength(2);
  });

  it("keeps the start window open when Gramps starts during a map load", async () => {
    const role = "678901234567890123";
    const { pass, alerts, discord } = workerFixture(
      { ...values, STAFF_ALERTS_PING_ROLE_ID: role },
      { sources: [sourceFor()] },
    );
    discord.channel.guild.roles.cache.set(role, { id: role, mentionable: true });
    // The first read after a redeploy lands while the next map loads, and the roster refills over several reads.
    await pass(snapshot([], { map: "Europe", matchSeconds: 5 }), 0);
    await pass(roster(clean), 15_000);
    await pass(roster(clean, listed), 15_000);
    expect(alerts.list("primary")).toEqual([
      expect.objectContaining({
        title: "Watch list: player online",
        pinged: false,
        delivery: { state: "suppressed", reason: "online when Gramps started, recorded only" },
      }),
    ]);
    expect(discord.channel.send).not.toHaveBeenCalled();
    // Once the roster has had a map load's time to refill, a join posts as usual.
    for (let read = 0; read < 10; read++) await pass(roster(clean, listed), 15_000);
    await pass(roster(listed, clean, noted), 15_000);
    expect(alerts.list("primary")[0]).toMatchObject({
      title: "Watch list: player joined",
      player: { steamId: noted },
      delivery: { state: "posted" },
    });

    // A server that was really empty at the start alerts on joins once it stays empty past a map load.
    const empty = workerFixture(values, { sources: [sourceFor()] });
    await empty.pass(roster(), 0);
    for (let read = 0; read < 12; read++) await empty.pass(roster(), 15_000);
    await empty.pass(roster(clean, listed), 15_000);
    expect(empty.alerts.list("primary")).toEqual([
      expect.objectContaining({ title: "Watch list: player joined", delivery: { state: "posted", reason: null } }),
    ]);
  });

  it("records players online when Gramps starts without posting or pinging, and still posts a later join", async () => {
    const role = "678901234567890123";
    const { pass, alerts, discord } = workerFixture(
      { ...values, STAFF_ALERTS_PING_ROLE_ID: role },
      { sources: [sourceFor()] },
    );
    discord.channel.guild.roles.cache.set(role, { id: role, mentionable: true });
    await pass(roster(listed, clean), 0);
    expect(alerts.list("primary")).toEqual([
      expect.objectContaining({
        title: "Watch list: player online",
        severity: "high",
        pinged: false,
        delivery: { state: "suppressed", reason: "online when Gramps started, recorded only" },
        network: expect.objectContaining({ presentAtStart: true }),
      }),
    ]);
    expect(discord.channel.send).not.toHaveBeenCalled();
    // Leaving past the 60-second grace and coming back is an observed join: posted, with the ping.
    for (let read = 0; read < 8; read++) await pass(roster(clean));
    await pass(roster(clean, listed));
    expect(alerts.list("primary")[0]).toMatchObject({
      title: "Watch list: player joined",
      pinged: true,
      delivery: { state: "posted" },
    });
    expect(discord.channel.send).toHaveBeenCalledTimes(1);
    expect(discord.channel.send.mock.calls[0][0].content).toBe(`<@&${role}>`);
  });

  it("calls no source when the watch list is off", async () => {
    const source = { name: "Staff watch list", lookup: jest.fn() };
    const { pass } = workerFixture(
      { ...values, STAFF_ALERTS_WATCHLIST_ENABLED: false, STAFF_ALERTS_HEALTH_ENABLED: true },
      { sources: [source] },
    );
    await pass(roster(clean), 0);
    await pass(roster(clean, listed));
    expect(source.lookup).not.toHaveBeenCalled();
  });

  it("notes a known-good overlap instead of suppressing the match", async () => {
    const { pass, alerts } = workerFixture(
      { ...values, STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: [listed] },
      { sources: [sourceFor()] },
    );
    await pass(roster(clean), 0);
    await pass(roster(clean, listed));
    expect(alerts.list("primary")[0].network?.knownGood).toBe(true);
    expect(alerts.list("primary")[0].lines).toContain("This player is also on the performance known-good list.");
  });
});
