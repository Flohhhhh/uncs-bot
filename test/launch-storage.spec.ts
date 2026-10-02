import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as schema from "../src/database/schema";
import { ApplicationsStore } from "../src/applications/applications.store";
import { SupportersStore } from "../src/supporters/supporters.store";
import type {
  FounderPolicy,
  ManualMemberInput,
  SupporterMutation,
  SupporterView,
} from "../src/supporters/supporters.types";
import { AdminStore, COMMUNITY_MESSAGES_ACTOR_ID } from "../src/admin/admin.store";
import type { ActionResult, AdminAction, Staff } from "../src/admin/admin.types";
import { MapVotesStore } from "../src/map-votes/map-votes.store";
import { ServerEventsStore } from "../src/server-events/server-events.store";
import { eventFixture, eventStaff } from "../src/server-events/event-fixtures";
import { operation } from "../src/server-events/event-planner";
import { TelemetryStore } from "../src/telemetry/telemetry.store";
import { parseFeed } from "../src/telemetry/telemetry.types";
import { defaultVotingPolicy } from "../src/common/voting-policy";

// Only the port is configurable. Never load the application's configuration or
// DATABASE_URL: this suite requires an empty, disposable loopback test database.
describe("launch storage on isolated PostgreSQL", () => {
  let client: Pool;
  let workers: ReturnType<typeof worker>[] = [];
  let initialized = false;
  let supporters: SupportersStore;
  let applications: ApplicationsStore;
  let admin: AdminStore;
  let votes: MapVotesStore;
  let events: ServerEventsStore;
  let migratedLegacyData: Record<string, unknown[]>;
  const legacyApplicationId = randomUUID();
  const legacyServerInstanceId = randomUUID();
  const legacyEventId = randomUUID();
  const legacyFirstReceivedAt = new Date("2026-09-30T12:00:00.000Z");
  const legacyLastReceivedAt = new Date("2026-09-30T13:00:00.000Z");
  function worker(pool: Pool) {
    const db = drizzle({ client: pool, schema });
    return {
      pool,
      supporters: new SupportersStore(db),
      applications: new ApplicationsStore(db),
      votes: new MapVotesStore(db),
      events: new ServerEventsStore(db),
    };
  }
  async function waitForBlockedWorkers(expected: number) {
    // PostgreSQL exposes no event for a backend entering a lock wait.
    const deadline = Date.now() + 3_000;
    let waiting = 0;
    do {
      const state = await client.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_stat_activity WHERE datname = current_database()
        AND application_name IN ('uncs_launch_worker_a', 'uncs_launch_worker_b')
        AND wait_event_type = 'Lock'`);
      waiting = state.rows[0].count;
      if (waiting === expected) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(waiting).toBe(expected);
  }

  async function overlap<T>(
    table:
      | "supporter_members"
      | "supporter_payments"
      | "whitelist_applications"
      | "map_votes"
      | "map_vote_policies"
      | "server_events",
    first: (stores: ReturnType<typeof worker>) => Promise<T>,
    second: (stores: ReturnType<typeof worker>) => Promise<T>,
  ) {
    const blocker = await client.connect();
    let results: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${table} IN SHARE MODE`);
      results = Promise.allSettled([first(workers[0]), second(workers[1])]);
      await waitForBlockedWorkers(2);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await results;
    }
    return (await results)!;
  }
  const staff: Staff = { id: "123456789012345678", name: "Test reviewer", role: "admin", csrf: "test-csrf" };
  const campaign = "999001";
  const policy: FounderPolicy = {
    configured: true,
    amountCents: 500,
    currency: "USD",
    startsAt: "2026-09-30T04:00:00.000Z",
    endsAt: "2026-10-15T04:00:00.000Z",
  };
  const memberInput = (patreonMemberId = "sample-member"): ManualMemberInput => ({
    id: randomUUID(),
    patreonMemberId,
    displayName: "Sample supporter",
    campaignMembershipVerified: true,
    reason: "Verified fictional test membership",
  });
  const review = (record: SupporterView) => ({
    id: randomUUID(),
    version: record.version,
    confirm: record.patreonMemberId,
    reason: "Reviewed fictional evidence",
  });
  async function register(name?: string) {
    return (await supporters.register(memberInput(name), staff, campaign, policy)).supporter!;
  }
  async function payment(record: SupporterView, paidAt = policy.startsAt!, reference: string = randomUUID()) {
    const input: SupporterMutation = {
      ...review(record),
      kind: "payment",
      paidAt: new Date(paidAt),
      amountCents: 500,
      currency: "USD",
      reference,
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: true,
    };
    return (await supporters.mutate(record.id, input, staff, campaign, policy)).supporter!;
  }
  const applicationInput = (discordUserId = staff.id, steamId = "76561198000000001") => ({
    discordUserId,
    discordDisplayName: "Sample applicant",
    steamId,
    relationship: "new_player" as const,
    email: "applicant@example.test",
    contactConsent: true,
    consentVersion: "test-consent",
    contactConsentAt: new Date(),
    rulesAcceptedAt: new Date(),
  });

  beforeAll(async () => {
    const port = Number(process.env.UNCS_TEST_POSTGRES_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Set UNCS_TEST_POSTGRES_PORT to an empty disposable PostgreSQL test container's loopback port.");
    const connection = {
      host: "127.0.0.1",
      port,
      database: "uncs_launch_test",
      user: "uncs_launch_test",
      password: "uncs_launch_test",
      ssl: false as const,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    };
    client = new Pool({ ...connection, max: 3, application_name: "uncs_launch_fixture" });
    expect((await client.query("SELECT current_database() AS database, current_user AS username")).rows).toEqual([
      { database: "uncs_launch_test", username: "uncs_launch_test" },
    ]);
    const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    if (existing.rowCount !== 0) throw new Error("Storage rehearsal requires a fresh empty test database.");
    const directory = join(__dirname, "../drizzle");
    for (const file of (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      if (file === "0003_lovely_caretaker.sql") {
        // Exercise the upgrade with records written by the previous single-server release.
        await client.query(
          `INSERT INTO whitelist_applications
            (id, discord_user_id, discord_display_name, steam_id, relationship, email,
             contact_consent, consent_version, rules_accepted_at, status)
           VALUES ($1, $2, 'Legacy applicant', '76561198000000001', 'new_player',
             'legacy@example.test', true, 'test-consent', $3, 'approved')`,
          [legacyApplicationId, staff.id, legacyFirstReceivedAt],
        );
        await client.query(
          `INSERT INTO combat_events
            (server_instance_id, event_id, server_name, received_at, event_time,
             context_tags, headshot, suicide)
           VALUES ($1, $2, 'Legacy server', $3, 120, '[]', false, false)`,
          [legacyServerInstanceId, legacyEventId, legacyLastReceivedAt],
        );
        await client.query(
          "INSERT INTO combat_tracking (id, first_received_at, last_received_at, last_cleanup_at) VALUES ('uncs', $1, $2, $2)",
          [legacyFirstReceivedAt, legacyLastReceivedAt],
        );
      }
      await client.query(await readFile(join(directory, file), "utf8"));
    }
    migratedLegacyData = {
      applications: (
        await client.query("SELECT id, server_id, discord_user_id, steam_id, email, status FROM whitelist_applications")
      ).rows,
      events: (await client.query("SELECT server_id, server_instance_id, event_id, server_name FROM combat_events"))
        .rows,
      tracking: (await client.query("SELECT * FROM combat_tracking")).rows,
    };
    const db = drizzle({ client, schema });
    supporters = new SupportersStore(db);
    applications = new ApplicationsStore(db);
    admin = new AdminStore(db);
    votes = new MapVotesStore(db);
    events = new ServerEventsStore(db);
    workers = ["a", "b"].map((name) =>
      worker(new Pool({ ...connection, max: 1, application_name: `uncs_launch_worker_${name}` })),
    );
    initialized = true;
  }, 30_000);
  beforeEach(async () => {
    if (!initialized) return;
    await client.query(
      "TRUNCATE combat_events, combat_tracking, server_event_operations, server_events, map_vote_ballots, map_votes, map_vote_policies, supporter_actions, supporter_founders, supporter_payments, supporter_observations, supporter_members, whitelist_application_reviews, whitelist_applications, admin_actions, admin_sessions CASCADE",
    );
  });
  afterAll(async () => {
    await Promise.all([...workers.map(({ pool }) => pool.end()), client?.end()]);
  });

  it("preserves existing applications, combat events and tracking when migrating to the primary server", () => {
    expect(migratedLegacyData).toEqual({
      applications: [
        {
          id: legacyApplicationId,
          server_id: "primary",
          discord_user_id: staff.id,
          steam_id: "76561198000000001",
          email: "legacy@example.test",
          status: "approved",
        },
      ],
      events: [
        {
          server_id: "primary",
          server_instance_id: legacyServerInstanceId,
          event_id: legacyEventId,
          server_name: "Legacy server",
        },
      ],
      tracking: [
        {
          id: "primary",
          first_received_at: legacyFirstReceivedAt,
          last_received_at: legacyLastReceivedAt,
          last_cleanup_at: legacyLastReceivedAt,
        },
      ],
    });
  });

  const ballotInput = () => ({
    id: randomUUID(),
    serverId: "primary",
    serverName: "Test",
    connectionHash: "test-connection",
    guildId: "123456789012345678",
    channelId: "234567890123456789",
    actorId: staff.id,
    actorName: staff.name,
    reason: "Test ballot",
    requestHash: randomUUID(),
    choices: [
      { map: "Europe", experiences: [] },
      { map: "Islands", experiences: [] },
    ],
    revision: "r1",
    currentMap: "Kavkazi",
    currentIndex: 0,
    counts: [0, 0],
    closesAt: new Date(Date.now() + 60_000),
  });

  it("keeps applications and grants separate when the same member joins two servers", async () => {
    const east = await applications.create({ ...applicationInput(), serverId: "east" });
    const central = await applications.create({ ...applicationInput(), serverId: "central" });
    expect(east?.id).not.toBe(central?.id);
    expect(await applications.create({ ...applicationInput(), serverId: "east" })).toBeUndefined();
    expect((await applications.own(staff.id, "east"))?.id).toBe(east!.id);
    expect((await applications.list("central")).map((r) => r.id)).toEqual([central!.id]);
    const wrong = await applications.claim(east!.id, { id: randomUUID(), reason: "Wrong target" }, "approve", {
      ...staff,
      serverId: "central",
    });
    expect(wrong).toEqual({ claimed: false, application: undefined });
    expect((await applications.own(staff.id, "east"))?.status).toBe("pending");
    const review = { id: randomUUID(), reason: "Reviewed exact target" };
    expect((await applications.claim(east!.id, review, "approve", { ...staff, serverId: "east" })).claimed).toBe(true);
    await applications.finishApproval(east!.id, review.id, { state: "applied", message: "Confirmed" });
    expect((await applications.own(staff.id, "central"))?.status).toBe("pending");
  });

  it("filters history before its row limit and keeps legacy receipts on primary", async () => {
    const oldId = randomUUID();
    await admin.begin(staff, { id: oldId, action: "broadcast", message: "Legacy", reason: "Old receipt" }, "old");
    await admin.finish(oldId, { state: "accepted", message: "Legacy accepted" });
    const eastId = randomUUID();
    await admin.begin(
      staff,
      { id: eastId, serverId: "east", action: "broadcast", message: "East", reason: "East receipt" },
      "east",
    );
    for (let i = 0; i < 101; i++)
      await admin.begin(
        staff,
        { id: randomUUID(), serverId: "central", action: "broadcast", message: "Central", reason: "Central receipt" },
        `central-${i}`,
      );
    expect((await admin.history("east")).map((r) => r.id)).toEqual([eastId]);
    expect((await admin.history("primary")).map((r) => r.id)).toEqual([oldId]);
    expect(await admin.receipt(eastId, "central")).toBeNull();
    expect(await admin.receipt(oldId, "east")).toBeNull();
    expect((await admin.receipt(oldId, "primary"))?.state).toBe("accepted");
  });

  it("keeps acknowledged automatic messages from crowding notable receipts out of the activity feed", async () => {
    const community: Staff = {
      id: COMMUNITY_MESSAGES_ACTOR_ID,
      name: "Gramps community messages",
      role: "admin",
      csrf: "",
    };
    const voting: Staff = { ...staff, name: "Gramps automatic voting" };
    const steamId = "76561198000000001";
    const record = async (actor: Staff, action: AdminAction, state?: ActionResult["state"]) => {
      await admin.begin(actor, action, action.id);
      if (state) await admin.finish(action.id, { state, message: `Recorded ${state}` });
      return action.id;
    };
    const welcome = (): AdminAction => ({
      id: randomUUID(),
      action: "message",
      steamId,
      message: "Welcome",
      reason: "Automatic observed-join welcome.",
    });
    const roundMessage = (): AdminAction => ({
      id: randomUUID(),
      action: "broadcast",
      message: "GG",
      reason: "Automatic observed round-transition message.",
    });
    const notable = [
      await record(staff, { id: randomUUID(), action: "kick", steamId, reason: "Reviewed report" }, "applied"),
      await record(staff, { id: randomUUID(), action: "message", steamId, message: "Hi", reason: "Rules" }, "accepted"),
      await record(community, welcome(), "failed"),
      await record(community, welcome(), "unknown"),
      await record(community, welcome()),
      await record(community, roundMessage(), "pending"),
    ];
    for (let i = 0; i < 101; i++)
      await record(community, i % 2 ? welcome() : roundMessage(), i % 3 ? "accepted" : "applied");
    const vote = {
      id: randomUUID(),
      action: "broadcast",
      message: "Totals",
      reason: "Map vote midpoint totals",
    } as const;
    notable.push(await record(voting, vote, "accepted"));

    const recent = await admin.history("primary");
    expect(recent).toHaveLength(100);
    expect(recent.filter((r) => notable.includes(r.id)).map((r) => r.id)).toEqual([vote.id]);
    expect((await admin.history("primary", { notable: true })).map((r) => r.id)).toEqual([...notable].reverse());
    expect(await admin.history("east", { notable: true })).toEqual([]);
    expect((await admin.receipt(notable[0], "primary"))?.state).toBe("applied");
  });

  it("deduplicates and aggregates the same game event independently on two configured servers", async () => {
    const telemetry = new TelemetryStore(drizzle({ client, schema }));
    const now = new Date(),
      since = new Date(now.getTime() - 60_000);
    const feed = parseFeed({
      serverId: randomUUID(),
      serverName: "Untrusted game label",
      events: [
        {
          eventId: randomUUID(),
          type: "killed",
          eventTime: 12,
          killerSteamId: "76561198000000001",
          victimSteamId: "76561198000000002",
        },
      ],
    });
    expect((await telemetry.ingest(feed, now, "east")).inserted).toBe(1);
    expect((await telemetry.ingest(feed, now, "central")).inserted).toBe(1);
    expect((await telemetry.ingest(feed, now, "east")).duplicates).toBe(1);
    expect((await telemetry.snapshot(since, now, undefined, "east")).totals.events).toBe(1);
    expect((await telemetry.snapshot(since, now, undefined, "central")).totals.events).toBe(1);
    expect(await telemetry.events(since, now, undefined, "primary")).toEqual([]);
    expect(await telemetry.tracking("primary")).toBeNull();
    expect((await telemetry.tracking("east"))?.lastReceivedAt).toEqual(now);
  });
  function eventInput() {
    const { operation: _operation, ...record } = eventFixture();
    return record;
  }
  const stopEvent = () => ({
    id: randomUUID(),
    actorId: eventStaff.id,
    actorName: eventStaff.name,
    reason: "Finished test event",
    at: new Date().toISOString(),
  });
  it("allows one active event per server under concurrent starts", async () => {
    const a = eventInput(),
      b = eventInput();
    const results = await overlap(
      "server_events",
      ({ events }) => events.create(a),
      ({ events }) => events.create(b),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const current = (await events.current("primary"))!;
    expect((await events.create(current.id === a.id ? a : b)).created).toBe(false);
    await expect(events.create({ ...a, id: current.id, requestHash: "changed" })).rejects.toThrow("already used");
  });
  it("claims an event effect once and compares replayed JSON structurally", async () => {
    const event = (await events.create(eventInput())).event;
    const op = operation(event, "ready", { action: "broadcast", message: "Ready" });
    const claim = ({ events }: ReturnType<typeof worker>) =>
      events.claim(event.id, event.version, op, eventStaff, event.progress);
    const results = await overlap("server_events", claim, claim);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(results.filter((r) => r.status === "fulfilled" && r.value !== null)).toHaveLength(1);
    expect(await events.claim(event.id, event.version, op, eventStaff, event.progress)).toBeNull();
    await expect(
      events.claim(
        event.id,
        event.version,
        { ...op, action: { ...op.action, reason: "Changed reason" } },
        eventStaff,
        event.progress,
      ),
    ).rejects.toThrow("different request");
    expect(await events.operations(event.id)).toHaveLength(1);
  });
  it("keeps stop durable while an already-started effect settles", async () => {
    const event = (await events.create(eventInput())).event,
      op = operation(eventFixture(), "ready", { action: "broadcast", message: "Ready" });
    await events.claim(event.id, event.version, op, eventStaff, event.progress);
    const stopped = await events.stop(event.id, stopEvent());
    expect(
      await events.claim(
        event.id,
        stopped.version,
        operation(event, "ready", { action: "broadcast", message: "Other" }),
        eventStaff,
        event.progress,
      ),
    ).toBeNull();
    await events.settle(
      event.id,
      op.id,
      { state: "accepted", message: "Confirmed" },
      { state: "active", progress: event.progress, message: "Confirmed" },
    );
    expect(await events.get(event.id)).toMatchObject({ state: "stopping", operation: null, stop: stopped.stop });
    expect(
      await events.observe(event.id, stopped.version, { state: "active", progress: event.progress, message: "Stale" }),
    ).toBe(false);
  });
  it("requires review for interrupted effects and retains a late receipt after manual restoration", async () => {
    const event = (await events.create(eventInput())).event,
      op = operation(eventFixture(), "ready", { action: "broadcast", message: "Ready" });
    const claimed = (await events.claim(event.id, event.version, op, eventStaff, event.progress))!;
    await events.recover(claimed, new Date(claimed.updatedAt.getTime() + 121_000));
    let current = (await events.get(event.id))!;
    expect(current).toMatchObject({ state: "needs_review", operation: op });
    current = await events.stop(event.id, stopEvent());
    const restore = operation(event, "restore_lock", {
      action: "settings-save",
      revision: "r2",
      changes: { lockOverpopulated: true },
    });
    expect(await events.claim(event.id, current.version, restore, eventStaff, current.progress)).toBeNull();
    expect(await events.claim(event.id, current.version, restore, eventStaff, current.progress, true)).not.toBeNull();
    await events.settle(
      event.id,
      restore.id,
      { state: "pending", message: "Saved" },
      { state: "complete", progress: current.progress, message: "Restored" },
    );
    await events.settle(
      event.id,
      op.id,
      { state: "accepted", message: "Late confirmation" },
      { state: "active", progress: current.progress, message: "Old result" },
    );
    expect(await events.get(event.id)).toMatchObject({ state: "complete", lastActionId: restore.id });
    expect((await events.operations(event.id)).find((record) => record.id === op.id)?.message).toBe(
      "Late confirmation",
    );
    expect((await events.create(eventInput())).created).toBe(true);
  });
  it("never completes an unchanged-lock event without a durable stop or with an inflight action", async () => {
    const event = (await events.create({ ...eventInput(), originalLock: false })).event;
    expect((await events.completeUnchanged(event.id, event.version))?.state).toBe("active");
    const op = operation(event, "ready", { action: "broadcast", message: "Ready" });
    await events.claim(event.id, event.version, op, eventStaff, event.progress);
    const stopped = await events.stop(event.id, stopEvent());
    expect((await events.completeUnchanged(event.id, stopped.version))?.state).not.toBe("complete");
    await events.settle(
      event.id,
      op.id,
      { state: "accepted", message: "Done" },
      { state: "stopping", progress: event.progress, message: "Stopped" },
    );
    const settled = (await events.get(event.id))!;
    expect((await events.completeUnchanged(event.id, settled.version))?.state).toBe("complete");
  });
  it("fails closed when the inflight-operation pointer cannot be resolved", async () => {
    const event = (await events.create(eventInput())).event;
    await client.query("UPDATE server_events SET operation_id = $1 WHERE id = $2", [randomUUID(), event.id]);
    await expect(events.current("primary")).rejects.toThrow("operation is unavailable");
  });
  const messageId = "345678901234567890";
  it("reads voting setup without changing data and scopes unfinished ballots to the selected server", async () => {
    expect(await votes.checkSetup("primary")).toEqual({ unfinished: false });
    const input = ballotInput();
    await votes.create({ ...input, serverId: "event" });
    expect(await votes.checkSetup("primary")).toEqual({ unfinished: false });
    expect(await votes.checkSetup("event")).toEqual({ unfinished: true });
    expect(await votes.get(input.id)).toMatchObject({ state: "publishing", messageId: null });
    expect((await client.query("SELECT count(*)::int AS count FROM map_votes")).rows).toEqual([{ count: 1 }]);
    expect((await client.query("SELECT count(*)::int AS count FROM map_vote_ballots")).rows).toEqual([{ count: 0 }]);
  });
  async function openBallot() {
    const input = ballotInput();
    await votes.create(input);
    await votes.published(input.id, messageId);
    return input;
  }
  async function scoreBallot() {
    const input = ballotInput();
    const policy = {
      ...defaultVotingPolicy,
      enabled: true,
      modeChoices: true,
      midpointReminder: true,
      finalReminder: true,
    };
    await votes.savePolicy(input.serverId, 0, policy, staff, input.connectionHash);
    await votes.create({ ...input, automation: { policy, highestScore: 50, reminders: {} } });
    await votes.published(input.id, messageId);
    return { input, policy };
  }
  it("keeps voting policy writes scoped and rejects simultaneous stale versions", async () => {
    const results = await overlap(
      "map_vote_policies",
      ({ votes }) => votes.savePolicy("primary", 0, defaultVotingPolicy, staff, "connection"),
      ({ votes }) => votes.savePolicy("primary", 0, { ...defaultVotingPolicy, modeChoices: true }, staff, "connection"),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(await votes.policy("primary")).toMatchObject({ version: 1, actorId: staff.id });
    expect(await votes.policy("event")).toBeNull();
  });
  it("claims each reminder once across workers and preserves that claim after reopening storage", async () => {
    const { input } = await scoreBallot();
    const results = await overlap(
      "map_votes",
      ({ votes }) => votes.claimReminder(input.id, "midpoint", randomUUID()),
      ({ votes }) => votes.claimReminder(input.id, "midpoint", randomUUID()),
    );
    expect(results.filter((item) => item.status === "fulfilled" && item.value)).toHaveLength(1);
    expect(await workers[1].votes.claimReminder(input.id, "midpoint", randomUUID())).toBeNull();
    await votes.finishReminder(input.id, "midpoint", "unknown", "Lost response");
    expect((await votes.get(input.id))?.automation?.reminders.midpoint).toMatchObject({ state: "unknown" });
    expect(await votes.claimReminder(input.id, "midpoint", randomUUID())).toBeNull();
  });
  it("atomically stops automatic ballots when voting is disabled, while preserving manual ballots elsewhere", async () => {
    const { input, policy } = await scoreBallot();
    const other = { ...ballotInput(), serverId: "event" };
    await votes.create(other);
    await votes.published(other.id, messageId);
    const result = await votes.savePolicy("primary", 1, { ...policy, enabled: false }, staff, input.connectionHash);
    expect(result.closed.map((vote) => vote.id)).toEqual([input.id]);
    expect(await votes.claimReminder(input.id, "final", randomUUID())).toBeNull();
    expect(await votes.claimClose(input.id, true)).toBeNull();
    expect(await votes.get(other.id)).toMatchObject({ state: "open" });
  });
  it("retains the highest observed score and refuses a later reset", async () => {
    const { input } = await scoreBallot();
    expect(await votes.observeScore(input.id, 85)).toBe(true);
    expect(await votes.observeScore(input.id, 0)).toBe(false);
    expect((await votes.get(input.id))?.automation?.highestScore).toBe(85);
  });
  it("refuses an automatic publication using controls superseded before its creation", async () => {
    const input = ballotInput();
    await votes.savePolicy("primary", 0, defaultVotingPolicy, staff, input.connectionHash);
    await expect(
      votes.create({
        ...input,
        automation: { policy: { ...defaultVotingPolicy, enabled: true }, highestScore: 10, reminders: {} },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await votes.history("primary")).toEqual([]);
  });
  it("allows one active ballot per server across simultaneous workers and replays only the exact request", async () => {
    const a = ballotInput(),
      b = ballotInput();
    const results = await overlap(
      "map_votes",
      ({ votes }) => votes.create(a),
      ({ votes }) => votes.create(b),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [saved] = await votes.history("primary");
    const original = saved.id === a.id ? a : b;
    expect(await votes.create(original)).toMatchObject({ created: false, record: { id: saved.id } });
    await expect(votes.create({ ...original, requestHash: "different" })).rejects.toMatchObject({ status: 409 });
    await expect(votes.create({ ...original, actorId: "other" })).rejects.toMatchObject({ status: 409 });
    expect((await votes.create({ ...b, id: randomUUID(), serverId: "another-server" })).created).toBe(true);
  });
  it("upserts one choice per member and rejects forged message contexts", async () => {
    const vote = await openBallot();
    await votes.cast(vote.id, staff.id, 0, vote.guildId, vote.channelId, messageId);
    await votes.cast(vote.id, staff.id, 1, vote.guildId, vote.channelId, messageId);
    expect(await votes.liveCounts([vote.id])).toEqual([{ voteId: vote.id, choice: 1, total: 1 }]);
    expect(await votes.liveCounts([])).toEqual([]);
    expect(await votes.liveCounts([randomUUID()])).toEqual([]);
    expect((await client.query("SELECT choice FROM map_vote_ballots")).rows).toEqual([{ choice: 1 }]);
    for (const [guild, channel, message, choice] of [
      ["other", vote.channelId, messageId, 0],
      [vote.guildId, "other", messageId, 0],
      [vote.guildId, vote.channelId, "other", 0],
      [vote.guildId, vote.channelId, messageId, 4],
    ] as const)
      await expect(votes.cast(vote.id, staff.id, choice, guild, channel, message)).rejects.toMatchObject({
        status: 409,
      });
    expect((await client.query("SELECT choice FROM map_vote_ballots")).rows).toEqual([{ choice: 1 }]);
  });
  it.each(["automatic", "staff"] as const)(
    "serializes automatic opening against %s ballots and refuses stale decisions after closure",
    async (kind) => {
      const a = ballotInput(),
        b = ballotInput();
      const results = await overlap(
        "map_votes",
        ({ votes }) => votes.create(a, null),
        ({ votes }) => votes.create(b, kind === "automatic" ? null : undefined),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const [created] = await votes.history("primary");
      await votes.finish(created.id, "no_votes", "No votes; rotation unchanged.");
      await expect(votes.create({ ...ballotInput(), id: randomUUID() }, null)).rejects.toMatchObject({ status: 409 });
      expect((await votes.create(ballotInput(), created.id)).created).toBe(true);
      expect((await votes.create({ ...ballotInput(), serverId: "event" }, null)).created).toBe(true);
    },
  );
  it("claims a due ballot once across workers and counts the final choices with the published tie rule", async () => {
    const vote = await openBallot();
    await votes.cast(vote.id, staff.id, 0, vote.guildId, vote.channelId, messageId);
    await votes.cast(vote.id, "999999999999999999", 1, vote.guildId, vote.channelId, messageId);
    await client.query("UPDATE map_votes SET closes_at = now() - interval '1 second' WHERE id = $1", [vote.id]);
    const results = await overlap(
      "map_votes",
      ({ votes }) => votes.claimClose(vote.id),
      ({ votes }) => votes.claimClose(vote.id),
    );
    expect(results.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(1);
    expect(await votes.get(vote.id)).toMatchObject({ state: "closing", winner: null, counts: [1, 1] });
    await expect(votes.cast(vote.id, staff.id, 1, vote.guildId, vote.channelId, messageId)).rejects.toMatchObject({
      status: 409,
    });
    await expect(votes.cancel(vote.id, randomUUID(), staff, "Close now")).rejects.toMatchObject({ status: 409 });
    await votes.finish(vote.id, "queued", "Saved next map");
    expect(await votes.finish(vote.id, "needs_review", "late completion")).toBeNull();
  });
  it("rechecks the deadline after a waiting voter acquires the lock", async () => {
    const vote = await openBallot();
    const blocker = await client.connect();
    let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM map_votes WHERE id = $1 FOR UPDATE", [vote.id]);
      result = Promise.allSettled([
        workers[0].votes.cast(vote.id, staff.id, 0, vote.guildId, vote.channelId, messageId),
      ]);
      await waitForBlockedWorkers(1);
      await blocker.query("UPDATE map_votes SET closes_at = now() - interval '1 second' WHERE id = $1", [vote.id]);
      await blocker.query("COMMIT");
      expect((await result)[0]).toMatchObject({ status: "rejected", reason: { status: 409 } });
      expect((await client.query("SELECT count(*)::int AS count FROM map_vote_ballots")).rows).toEqual([{ count: 0 }]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await result;
    }
  });
  it("preserves the original uncertain result and exact cancelling identity without permitting replays with changed reasons", async () => {
    const vote = await openBallot();
    await client.query(
      "UPDATE map_votes SET state = 'closing', updated_at = now() - interval '3 minutes' WHERE id = $1",
      [vote.id],
    );
    expect(await votes.recover(new Date())).toMatchObject([{ id: vote.id, state: "needs_review" }]);
    expect(await votes.due(new Date())).toEqual([]);
    await expect(votes.create(ballotInput())).rejects.toMatchObject({ status: 409 });
    const id = randomUUID();
    const closed = await votes.cancel(vote.id, id, staff, "Inspected Discord and receipt");
    expect(closed).toMatchObject({
      state: "cancelled",
      cancellation: { id, actorId: staff.id, previousState: "needs_review" },
    });
    expect(await votes.cancel(vote.id, id, staff, "Inspected Discord and receipt")).toEqual(closed);
    await expect(votes.cancel(vote.id, id, staff, "Changed reason")).rejects.toMatchObject({ status: 409 });
    await expect(
      votes.cancel(vote.id, id, { ...staff, id: "other" }, "Inspected Discord and receipt"),
    ).rejects.toMatchObject({ status: 409 });
    expect((await votes.create(ballotInput())).created).toBe(true);
  });

  it("saves a manual member once and replays its exact receipt without creating payment evidence", async () => {
    const input = memberInput();
    const first = await supporters.register(input, staff, campaign, policy);
    expect(first.supporter).toMatchObject({
      reviewState: "unverified",
      latestPayment: null,
      founder: null,
      version: 1,
    });
    const second = await supporters.register(input, staff, campaign, policy);
    expect(second).toMatchObject({ replayed: true, supporter: { id: first.supporter!.id, version: 1 } });
    await expect(supporters.register({ ...input, id: randomUUID() }, staff, campaign, policy)).rejects.toMatchObject({
      status: 409,
    });
    expect((await client.query("SELECT count(*)::int AS count FROM supporter_actions")).rows).toEqual([{ count: 1 }]);
  });

  it("rolls back a newly inserted member when its action ID belongs to another record", async () => {
    const input = memberInput();
    await supporters.register(input, staff, campaign, policy);
    await expect(
      supporters.register({ ...input, patreonMemberId: "different-member" }, staff, campaign, policy),
    ).rejects.toMatchObject({ status: 409 });
    expect((await supporters.list(campaign, policy)).map((item) => item.patreonMemberId)).toEqual([
      input.patreonMemberId,
    ]);
  });

  it("finds older members outside the latest 100 and treats search as literal, campaign-scoped input", async () => {
    const original = await register("older-member");
    await client.query(`INSERT INTO supporter_members (id, campaign_id, patreon_member_id, display_name, observed_at)
      SELECT gen_random_uuid(), '${campaign}', 'newer-' || i, 'New member ' || i, now() + interval '1 day'
      FROM generate_series(1, 101) AS i`);
    expect(await supporters.list(campaign, policy)).toHaveLength(100);
    expect(await supporters.list(campaign, policy, undefined, "older-member")).toMatchObject([{ id: original.id }]);
    expect(await supporters.list("other-campaign", policy, undefined, "older-member")).toEqual([]);
    expect(await supporters.list(campaign, policy, undefined, "%")).toEqual([]);
    expect(await supporters.list(campaign, policy, undefined, "' OR 1=1 --")).toEqual([]);
  });

  it("records an eligible founder and preserves the promise after a cancellation observation", async () => {
    let record = await register();
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "link", discordId: staff.id, steamId: "76561200000000000" },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    record = await payment(record);
    expect(record.founderEligiblePayment).toMatchObject({
      amountCents: 500,
      firstSuccessfulPaymentVerified: true,
      verificationState: "verified",
    });
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: record.founderEligiblePayment!.id },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    const founder = record.founder;
    expect(founder).not.toBeNull();
    const observation = {
      hash: "c".repeat(64),
      campaignId: campaign,
      patreonMemberId: record.patreonMemberId,
      displayName: null,
      patronStatus: "former_patron",
      lastChargeStatus: null,
      lastChargeAt: null,
      receivedAt: new Date(),
      trigger: "members:delete",
    };
    expect(await supporters.ingest(observation)).toEqual({ duplicate: false });
    expect(await supporters.ingest(observation)).toEqual({ duplicate: true });
    const saved = await supporters.get(record.id, campaign, policy);
    expect(saved).toMatchObject({
      patronStatus: "former_patron",
      founder,
      reviewState: "pending",
      version: record.version + 1,
    });
  });

  it.each(["2026-09-30T03:59:59.999Z", "2026-10-15T04:00:00.000Z"])(
    "excludes payments outside the advertised window: %s",
    async (time) => {
      const record = await payment(await register(), time);
      expect(record.latestPayment).not.toBeNull();
      expect(record.founderEligiblePayment).toBeNull();
    },
  );

  it("rolls back duplicate payment receipts and stale reviews without advancing the member", async () => {
    const original = await register("first-member");
    await payment(original, policy.startsAt!, "receipt-same");
    const other = await register("second-member");
    await expect(payment(other, policy.startsAt!, "RECEIPT-SAME")).rejects.toThrow();
    expect(await supporters.get(other.id, campaign, policy)).toMatchObject({ version: 1, latestPayment: null });
    await expect(
      supporters.mutate(original.id, { ...review(original), kind: "review" }, staff, campaign, policy),
    ).rejects.toMatchObject({ status: 409 });
    expect((await client.query("SELECT kind FROM supporter_actions WHERE member_id = $1", [other.id])).rows).toEqual([
      { kind: "manual-member" },
    ]);
  });

  it("keeps duplicate applicant identities and SteamIDs from creating additional requests", async () => {
    const input = applicationInput();
    const first = await applications.create(input);
    expect(first?.status).toBe("pending");
    expect(await applications.create(input)).toBeUndefined();
    expect(await applications.create({ ...input, discordUserId: "999999999999999999" })).toBeUndefined();
    expect(await applications.own(input.discordUserId)).toMatchObject({ id: first!.id });
    expect(await applications.own("999999999999999999")).toBeUndefined();
  });

  it("persists one approval claim and its result and rejects a superseded completion", async () => {
    const record = (await applications.create(applicationInput()))!;
    const actionId = randomUUID();
    expect(
      await applications.claim(record.id, { id: actionId, reason: "Reviewed test account" }, "approve", staff),
    ).toMatchObject({ claimed: true });
    expect(
      await applications.claim(record.id, { id: randomUUID(), reason: "Second reviewer" }, "approve", staff),
    ).toMatchObject({ claimed: false });
    await expect(
      applications.finishApproval(record.id, randomUUID(), { state: "applied", message: "Wrong receipt" }),
    ).rejects.toThrow("original claim");
    const saved = await applications.finishApproval(record.id, actionId, {
      state: "applied",
      message: "Sample confirmation",
    });
    expect(saved).toMatchObject({ status: "approved", actionId, reviewId: actionId });
    expect(
      (await client.query("SELECT state, completed_at FROM whitelist_application_reviews WHERE id = $1", [actionId]))
        .rows[0],
    ).toMatchObject({ state: "applied", completed_at: expect.any(Date) });
  });

  it("recovers an interrupted approval by readback and retains a later original receipt without overwriting it", async () => {
    const record = (await applications.create(applicationInput()))!;
    const actionId = randomUUID();
    await applications.claim(record.id, { id: actionId, reason: "Original review" }, "approve", staff);
    const reopened = workers[0].applications;
    expect(await reopened.get(record.id, "event")).toBeUndefined();
    const previous = (await reopened.get(record.id, "primary"))!;
    expect(previous.status).toBe("processing");
    const recheck = { id: randomUUID(), reason: "Read existing access" };
    const result = await reopened.finishRecheck(previous, recheck, staff, {
      state: "applied",
      message: "Live access confirmed",
    });
    expect(result).toMatchObject({ status: "approved", actionId, reviewId: recheck.id, reviewKind: "recheck" });
    await expect(
      applications.finishApproval(record.id, actionId, { state: "unknown", message: "Original response lost" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await applications.own(record.discordUserId)).toMatchObject({
      status: "approved",
      reviewId: recheck.id,
      lastActionMessage: "Live access confirmed",
    });
    const history = await client.query(
      "SELECT id, state, completed_at FROM whitelist_application_reviews WHERE application_id = $1",
      [record.id],
    );
    expect(history.rows).toEqual(
      expect.arrayContaining([
        { id: actionId, state: "unknown", completed_at: expect.any(Date) },
        { id: recheck.id, state: "applied", completed_at: expect.any(Date) },
      ]),
    );
  });

  it("rejects stale readbacks and rolls back their receipts if approval completed during the check", async () => {
    const record = (await applications.create(applicationInput()))!;
    const approvalId = randomUUID();
    await applications.claim(record.id, { id: approvalId, reason: "Original review" }, "approve", staff);
    const previous = (await applications.get(record.id, "primary"))!;
    await applications.finishApproval(record.id, approvalId, { state: "applied", message: "Original confirmation" });
    const recheck = { id: randomUUID(), reason: "Read existing access" };
    await expect(
      workers[0].applications.finishRecheck(previous, recheck, staff, { state: "pending", message: "Older read" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await applications.own(record.discordUserId)).toMatchObject({ status: "approved", reviewId: approvalId });
    expect(
      (await client.query("SELECT id FROM whitelist_application_reviews WHERE id = $1", [recheck.id])).rowCount,
    ).toBe(0);
  });

  it("records one of two concurrent readbacks and leaves no losing receipt or new grant", async () => {
    const record = (await applications.create(applicationInput()))!;
    const approvalId = randomUUID();
    await applications.claim(record.id, { id: approvalId, reason: "Original review" }, "approve", staff);
    const previous = (await applications.get(record.id, "primary"))!;
    const first = { id: randomUUID(), reason: "First read" };
    const second = { id: randomUUID(), reason: "Second read" };
    const results = await overlap(
      "whitelist_applications",
      ({ applications }) =>
        applications.finishRecheck(previous, first, staff, { state: "pending", message: "Not confirmed" }),
      ({ applications }) =>
        applications.finishRecheck(previous, second, staff, { state: "unknown", message: "Read unavailable" }),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = (await applications.own(record.discordUserId))!;
    expect(current).toMatchObject({ status: "needs_review", actionId: approvalId });
    expect([first.id, second.id]).toContain(current.reviewId);
    const history = await client.query(
      "SELECT id FROM whitelist_application_reviews WHERE application_id = $1 AND kind = 'recheck'",
      [record.id],
    );
    expect(history.rows).toEqual([{ id: current.reviewId }]);
    const final = await applications.finishRecheck(current, { id: randomUUID(), reason: "Fresh read" }, staff, {
      state: "applied",
      message: "Confirmed",
    });
    expect(final).toMatchObject({ status: "approved", actionId: approvalId });
  });

  it("revokes stored sessions and retains durable action receipts across store instances", async () => {
    const tokenHash = "d".repeat(64);
    await admin.createSession({
      tokenHash,
      userId: staff.id,
      displayName: staff.name,
      csrf: staff.csrf,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await admin.session(tokenHash)).toMatchObject({ userId: staff.id });
    await admin.deleteSession(tokenHash);
    expect(await admin.session(tokenHash)).toBeUndefined();
    const id = randomUUID();
    const action = { id, action: "broadcast" as const, message: "Simulated only", reason: "Sample review" };
    expect(await admin.begin(staff, action, "test-fingerprint")).toMatchObject({ created: true });
    await admin.finish(id, { state: "unknown", message: "Sample unconfirmed outcome" });
    admin = new AdminStore(drizzle({ client, schema }));
    expect(await admin.begin(staff, action, "test-fingerprint")).toMatchObject({
      created: false,
      record: { state: "unknown" },
    });
    expect(await admin.receipt(id)).toMatchObject({ id, state: "unknown" });
  });

  it("serializes simultaneous copies of a member request into one record and one replay", async () => {
    const input = memberInput();
    const save = ({ supporters }: ReturnType<typeof worker>) => supporters.register(input, staff, campaign, policy);
    const results = await overlap("supporter_members", save, save);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(values.map((value) => value.replayed).sort()).toEqual([false, true]);
    expect(values[0].supporter!.id).toBe(values[1].supporter!.id);
    expect((await client.query("SELECT count(*)::int AS count FROM supporter_actions")).rows).toEqual([{ count: 1 }]);
    expect(await supporters.list(campaign, policy)).toHaveLength(1);
  });

  it("rejects a concurrent second registration with a different action ID without leaving extra receipts", async () => {
    const results = await overlap(
      "supporter_members",
      ({ supporters }) => supporters.register(memberInput(), staff, campaign, policy),
      ({ supporters }) => supporters.register(memberInput(), staff, campaign, policy),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await supporters.list(campaign, policy)).toHaveLength(1);
    expect((await client.query("SELECT count(*)::int AS count FROM supporter_actions")).rows).toEqual([{ count: 1 }]);
  });

  it("rejects a concurrent stale review after the other reviewer advances the member", async () => {
    const record = await register();
    const save = ({ supporters }: ReturnType<typeof worker>) =>
      supporters.mutate(record.id, { ...review(record), kind: "review" }, staff, campaign, policy);
    const results = await overlap("supporter_members", save, save);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await supporters.get(record.id, campaign, policy)).toMatchObject({ version: 2, reviewState: "verified" });
    expect(
      (await client.query("SELECT count(*)::int AS count FROM supporter_actions WHERE kind = 'review'")).rows,
    ).toEqual([{ count: 1 }]);
  });

  it("rolls back the losing member when two reviews claim the same payment receipt", async () => {
    const records = [await register("first"), await register("second")];
    const save =
      (index: number) =>
      ({ supporters }: ReturnType<typeof worker>) =>
        supporters.mutate(
          records[index].id,
          {
            ...review(records[index]),
            kind: "payment",
            paidAt: new Date(policy.startsAt!),
            amountCents: 500,
            currency: "USD",
            reference: index === 0 ? "same-receipt" : "SAME-RECEIPT",
            completedPaymentVerified: true,
            firstSuccessfulPaymentVerified: true,
          },
          staff,
          campaign,
          policy,
        );
    const results = await overlap("supporter_payments", save(0), save(1));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { cause: { code: "23505" } },
    });
    const saved = await supporters.list(campaign, policy);
    expect(saved.map((record) => record.version).sort()).toEqual([1, 2]);
    expect(saved.filter((record) => record.latestPayment !== null)).toHaveLength(1);
    expect(
      (await client.query("SELECT count(*)::int AS count FROM supporter_actions WHERE kind = 'payment'")).rows,
    ).toEqual([{ count: 1 }]);
  });

  it("allows only one of two members to link the same Steam identity", async () => {
    const records = [await register("first"), await register("second")];
    const save =
      (index: number) =>
      ({ supporters }: ReturnType<typeof worker>) =>
        supporters.mutate(
          records[index].id,
          {
            ...review(records[index]),
            kind: "link",
            discordId: `${staff.id.slice(0, -1)}${index}`,
            steamId: "76561198000000001",
          },
          staff,
          campaign,
          policy,
        );
    const results = await overlap("supporter_members", save(0), save(1));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { cause: { code: "23505" } },
    });
    const saved = await supporters.list(campaign, policy);
    expect(saved.map((record) => record.version).sort()).toEqual([1, 2]);
    expect(saved.filter((record) => record.steamId !== null)).toHaveLength(1);
    expect(saved.find((record) => record.steamId === null)).toMatchObject({ discordId: null, version: 1 });
    expect(
      (await client.query("SELECT count(*)::int AS count FROM supporter_actions WHERE kind = 'link'")).rows,
    ).toEqual([{ count: 1 }]);
  });

  it("accepts one concurrent application for a shared SteamID without exposing it to the other applicant", async () => {
    const inputs = [applicationInput(), applicationInput("999999999999999999")];
    const results = await overlap(
      "whitelist_applications",
      ({ applications }) => applications.create(inputs[0]),
      ({ applications }) => applications.create(inputs[1]),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
    expect(values).toHaveLength(1);
    const losingApplicant = inputs.find((input) => input.discordUserId !== values[0].discordUserId)!;
    expect(await applications.own(losingApplicant.discordUserId)).toBeUndefined();
    expect(await applications.list()).toHaveLength(1);
  });

  it("grants exactly one approval claim to simultaneous staff reviewers", async () => {
    const record = (await applications.create(applicationInput()))!;
    const claim = ({ applications }: ReturnType<typeof worker>) =>
      applications.claim(record.id, { id: randomUUID(), reason: "Simultaneous review" }, "approve", staff);
    const results = await overlap("whitelist_applications", claim, claim);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(values.map((value) => value.claimed).sort()).toEqual([false, true]);
    const winner = values.find((value) => value.claimed)!.application!;
    expect((await client.query("SELECT id FROM whitelist_application_reviews")).rows).toEqual([
      { id: winner.reviewId },
    ]);
    expect(
      await applications.finishApproval(record.id, winner.reviewId!, { state: "applied", message: "Simulated" }),
    ).toMatchObject({
      status: "approved",
      reviewId: winner.reviewId,
    });
  });
});
