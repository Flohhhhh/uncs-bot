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
import { AdminStore } from "../src/admin/admin.store";
import type { Staff } from "../src/admin/admin.types";
import { MapVotesStore } from "../src/map-votes/map-votes.store";

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
  function worker(pool: Pool) {
    const db = drizzle({ client: pool, schema });
    return {
      pool,
      supporters: new SupportersStore(db),
      applications: new ApplicationsStore(db),
      votes: new MapVotesStore(db),
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
    table: "supporter_members" | "supporter_payments" | "whitelist_applications" | "map_votes",
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
      await client.query(await readFile(join(directory, file), "utf8"));
    }
    // Test-only fixture for the proposed source schema, NOT a deployment migration.
    // A human must generate and review the real migration before enabling map votes.
    await client.query(`CREATE TABLE map_votes (
      id uuid PRIMARY KEY, server_id text NOT NULL, server_name text NOT NULL, connection_hash text NOT NULL,
      guild_id text NOT NULL, channel_id text NOT NULL, message_id text,
      actor_id text NOT NULL, actor_name text NOT NULL, reason text NOT NULL, request_hash text NOT NULL,
      choices jsonb NOT NULL, revision text NOT NULL, current_map text NOT NULL, current_index integer NOT NULL,
      round_started_at timestamptz, state text NOT NULL DEFAULT 'publishing', winner integer,
      counts jsonb NOT NULL, message text NOT NULL DEFAULT 'Creating the Discord ballot.', cancellation jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), closes_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX map_votes_active_server_idx ON map_votes(server_id) WHERE state IN ('publishing', 'open', 'closing', 'needs_review');
    CREATE INDEX map_votes_created_idx ON map_votes(created_at);
    CREATE TABLE map_vote_ballots (
      vote_id uuid NOT NULL REFERENCES map_votes(id), discord_user_id text NOT NULL, choice integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (vote_id, discord_user_id)
    )`);
    const db = drizzle({ client, schema });
    supporters = new SupportersStore(db);
    applications = new ApplicationsStore(db);
    admin = new AdminStore(db);
    votes = new MapVotesStore(db);
    workers = ["a", "b"].map((name) =>
      worker(new Pool({ ...connection, max: 1, application_name: `uncs_launch_worker_${name}` })),
    );
    initialized = true;
  }, 30_000);
  beforeEach(async () => {
    if (!initialized) return;
    await client.query(
      "TRUNCATE map_vote_ballots, map_votes, supporter_actions, supporter_founders, supporter_payments, supporter_observations, supporter_members, whitelist_application_reviews, whitelist_applications, admin_actions, admin_sessions CASCADE",
    );
  });
  afterAll(async () => {
    await Promise.all([...workers.map(({ pool }) => pool.end()), client?.end()]);
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
  const messageId = "345678901234567890";
  async function openBallot() {
    const input = ballotInput();
    await votes.create(input);
    await votes.published(input.id, messageId);
    return input;
  }
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
    expect(await votes.get(vote.id)).toMatchObject({ state: "closing", winner: 0, counts: [1, 1] });
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
