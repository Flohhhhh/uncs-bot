import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as schema from "../src/database/schema";
import { ApplicationsStore } from "../src/applications/applications.store";
import { SupportersStore } from "../src/supporters/supporters.store";
import {
  SupporterMatchStore,
  type AutoMatchOptions,
  type AutoMatchResult,
} from "../src/supporters/supporter-match.store";
import { supporterNextSteps } from "../src/supporters/supporter-match.rules";
import type {
  FounderPolicy,
  ManualMemberInput,
  PaypalInput,
  SupporterMutation,
  SupporterView,
} from "../src/supporters/supporters.types";
import type { PatreonMemberSnapshot } from "../src/supporters/patreon.client";
import { AdminStore, COMMUNITY_MESSAGES_ACTOR_ID } from "../src/admin/admin.store";
import type { ActionResult, AdminAction, Staff } from "../src/admin/admin.types";
import { MapVotesStore } from "../src/map-votes/map-votes.store";
import { ServerEventsStore } from "../src/server-events/server-events.store";
import { eventFixture, eventStaff, voteEventFixture } from "../src/server-events/event-fixtures";
import { operation } from "../src/server-events/event-planner";
import { TelemetryStore } from "../src/telemetry/telemetry.store";
import { DiscordRolesStore } from "../src/discord-roles/discord-roles.store";
import { PATRON_LINK_ACTOR, PatronLinkStore, type PatronLinkResult } from "../src/patron-link/patron-link.store";
import { PATRON_LINK_FOUNDER_REASON } from "../src/supporters/supporter-match.rules";
import { parseFeed } from "../src/telemetry/telemetry.types";
import { defaultVotingPolicy, defaultVotingSettings } from "../src/common/voting-policy";

// Only the port is configurable. Never load the application's configuration or
// DATABASE_URL: this suite requires an empty, disposable loopback test database.
describe("launch storage on isolated PostgreSQL", () => {
  let client: Pool;
  let workers: ReturnType<typeof worker>[] = [];
  let initialized = false;
  let supporters: SupportersStore;
  let match: SupporterMatchStore;
  let applications: ApplicationsStore;
  let admin: AdminStore;
  let votes: MapVotesStore;
  let events: ServerEventsStore;
  let roles: DiscordRolesStore;
  let patronLink: PatronLinkStore;
  let migratedApplicationAccess: unknown[] | undefined;
  let migratedLegacyData: Record<string, unknown[]>;
  let migratedSupporterData: unknown[] | undefined;
  let migratedDiscordSources: unknown[] | undefined;
  const legacySupporterId = randomUUID();
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
      match: new SupporterMatchStore(db),
      patronLink: new PatronLinkStore(db),
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
    source: "SUPPORTER_FOUNDER",
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
    confirm: record.confirmKey,
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
  async function linked(name: string, steamId: string) {
    const record = await register(name);
    return (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "link", discordId: staff.id, steamId },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
  }
  const charge = (id: string, date: string, type = "pledge_start") => ({
    id,
    date: new Date(date),
    amountCents: 500,
    currency: "USD",
    paymentStatus: "Paid",
    type,
  });
  const apiMember = (
    patreonMemberId: string,
    events: PatreonMemberSnapshot["events"],
    historyComplete: boolean,
  ): PatreonMemberSnapshot => ({
    patreonMemberId,
    displayName: "Sample supporter",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: events.at(-1)?.date ?? null,
    discordId: null,
    discordKnown: true,
    events,
    historyComplete,
  });
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
      if (file.startsWith("0005_")) {
        // Supporter records written before the provider-neutral ledger must stay valid Patreon records.
        await client.query(
          `INSERT INTO supporter_members (id, campaign_id, patreon_member_id, display_name, observed_at, discord_id,
             steam_id)
           VALUES ($1, '999001', 'legacy-member', 'Legacy supporter', $2, $3, '76561198000000001')`,
          [legacySupporterId, legacyFirstReceivedAt, staff.id],
        );
        await client.query(
          `INSERT INTO supporter_payments (id, member_id, campaign_id, paid_at, amount_cents, currency, source,
             reference, verification_state, first_successful_payment_verified, verified_by, recorded_at)
           VALUES (gen_random_uuid(), $1, '999001', $2, 500, 'USD', 'manual_receipt', 'legacy-receipt',
             'verified', true, $3, $2)`,
          [legacySupporterId, legacyFirstReceivedAt, staff.id],
        );
      }
      if (file.startsWith("0006_")) {
        // Discord sources recorded before patron sign-in links must stay valid under the widened check.
        await client.query(
          `INSERT INTO supporter_members (id, provider, campaign_id, patreon_member_id, observed_at, discord_id,
             discord_source, patreon_discord_id)
           VALUES ($1, 'patreon', '999001', 'imported-member', $3, '234567890123456781', 'patreon',
             '234567890123456781'),
             ($2, 'paypal', NULL, NULL, $3, '234567890123456782', 'staff', NULL)`,
          [randomUUID(), randomUUID(), legacyFirstReceivedAt],
        );
      }
      await client.query(await readFile(join(directory, file), "utf8"));
    }
    migratedDiscordSources = (
      await client.query(
        "SELECT provider, discord_source FROM supporter_members WHERE discord_source IS NOT NULL ORDER BY provider",
      )
    ).rows;
    migratedApplicationAccess = (
      await client.query(
        "SELECT status, access_intent, whitelist_grant, revoked_at FROM whitelist_applications WHERE id = $1",
        [legacyApplicationId],
      )
    ).rows;
    migratedSupporterData = (
      await client.query(
        `SELECT m.provider, m.campaign_id, m.patreon_member_id, m.discord_source, m.patreon_discord_id,
        m.steam_source, m.steam_application_id, p.source, p.minimum_confirmed,
        p.recorded_by FROM supporter_members m JOIN supporter_payments p ON p.member_id = m.id WHERE m.id = $1`,
        [legacySupporterId],
      )
    ).rows;
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
    match = new SupporterMatchStore(db);
    applications = new ApplicationsStore(db);
    admin = new AdminStore(db);
    votes = new MapVotesStore(db);
    events = new ServerEventsStore(db);
    roles = new DiscordRolesStore(db);
    patronLink = new PatronLinkStore(db);
    workers = ["a", "b"].map((name) =>
      worker(new Pool({ ...connection, max: 1, application_name: `uncs_launch_worker_${name}` })),
    );
    initialized = true;
  }, 30_000);
  beforeEach(async () => {
    if (!initialized) return;
    await client.query(
      "TRUNCATE combat_events, combat_tracking, server_event_operations, server_events, map_vote_ballots, map_votes, map_vote_policies, discord_role_actions, supporter_actions, supporter_founders, supporter_payments, supporter_observations, supporter_members, whitelist_application_reviews, whitelist_applications, admin_actions, admin_sessions CASCADE",
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

  it("keeps applications from before revocation support as granted, unrevoked records", () => {
    expect(migratedApplicationAccess).toEqual([
      { status: "approved", access_intent: "grant", whitelist_grant: null, revoked_at: null },
    ]);
  });

  it("keeps supporter records from before the provider-neutral ledger as Patreon records", () => {
    expect(migratedSupporterData).toEqual([
      {
        provider: "patreon",
        campaign_id: "999001",
        patreon_member_id: "legacy-member",
        // Links made before sources were recorded stay unclassified until the startup classification runs.
        discord_source: null,
        patreon_discord_id: null,
        steam_source: null,
        steam_application_id: null,
        source: "manual_receipt",
        minimum_confirmed: false,
        recorded_by: null,
      },
    ]);
  });

  it("keeps Discord sources recorded before patron sign-in links", () => {
    expect(migratedDiscordSources).toEqual([
      { provider: "patreon", discord_source: "patreon" },
      { provider: "paypal", discord_source: "staff" },
    ]);
  });

  it("rejects identity sources that do not match the record's identities or provider", async () => {
    const insert = (values: {
      provider?: "patreon" | "paypal";
      discordId?: string | null;
      discordSource?: string | null;
      patreonDiscordId?: string | null;
      steamId?: string | null;
      steamSource?: string | null;
      steamApplicationId?: string | null;
    }) => {
      const provider = values.provider ?? "patreon";
      return client.query(
        `INSERT INTO supporter_members (id, provider, campaign_id, patreon_member_id, observed_at, discord_id,
           discord_source, patreon_discord_id, steam_id, steam_source, steam_application_id)
         VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10)`,
        [
          randomUUID(),
          provider,
          provider === "patreon" ? campaign : null,
          provider === "patreon" ? randomUUID() : null,
          values.discordId ?? null,
          values.discordSource ?? null,
          values.patreonDiscordId ?? null,
          values.steamId ?? null,
          values.steamSource ?? null,
          values.steamApplicationId ?? null,
        ],
      );
    };
    const discordSource = "supporter_members_discord_source_check",
      steamSource = "supporter_members_steam_source_check",
      steamApplication = "supporter_members_steam_application_check",
      patreonDiscord = "supporter_members_patreon_discord_check";
    for (const [values, constraint] of [
      [{ discordSource: "staff" }, discordSource],
      [{ discordId: staff.id, discordSource: "someone" }, discordSource],
      [{ provider: "paypal", discordId: staff.id, discordSource: "patreon" }, discordSource],
      [{ discordSource: "patron_signin" }, discordSource],
      [{ provider: "paypal", discordId: staff.id, discordSource: "patron_signin" }, discordSource],
      [{ steamSource: "staff" }, steamSource],
      [
        {
          provider: "paypal",
          steamId: "76561198000000001",
          steamSource: "application",
          steamApplicationId: randomUUID(),
        },
        steamSource,
      ],
      [{ steamId: "76561198000000001", steamSource: "application" }, steamApplication],
      [{ steamId: "76561198000000001", steamSource: "staff", steamApplicationId: randomUUID() }, steamApplication],
      [{ provider: "paypal", patreonDiscordId: staff.id }, patreonDiscord],
    ] as const)
      await expect(insert(values)).rejects.toMatchObject({ code: "23514", constraint });
    await insert({
      discordId: staff.id,
      discordSource: "patreon",
      patreonDiscordId: staff.id,
      steamId: "76561198000000001",
      steamSource: "application",
      steamApplicationId: randomUUID(),
    });
    await insert({
      provider: "paypal",
      discordId: staff.id,
      discordSource: "staff",
      steamId: "76561198000000002",
      steamSource: "staff",
    });
    // A patron's own sign-in link is a Patreon record's.
    await insert({ discordId: "234567890123456783", discordSource: "patron_signin" });
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

  it("counts each player's kicks and bans the game applied or accepted, on one server", async () => {
    const [griefer, other, clean] = ["76561198000000001", "76561198000000002", "76561198000000003"];
    const record = async (
      action: "kick" | "ban",
      steamId: string,
      state: ActionResult["state"] | null,
      daysAgo: number,
      extra: { serverId?: string; name?: string; reason?: string } = {},
    ) => {
      const id = randomUUID();
      const base = { id, steamId, reason: extra.reason ?? "Team killing", serverId: extra.serverId };
      await admin.begin(
        staff,
        action === "ban" ? { ...base, action, confirm: steamId } : { ...base, action },
        id,
        extra.name,
      );
      if (state) await admin.finish(id, { state, message: `Recorded ${state}` });
      await client.query("UPDATE admin_actions SET created_at = now() - make_interval(days => $1) WHERE id = $2", [
        daysAgo,
        id,
      ]);
      return id;
    };
    const oldest = await record("kick", griefer, "applied", 40, { name: "Old name", reason: "Spawn camping" });
    await record("kick", griefer, "failed", 3, { name: "Refused" });
    // Started (a crash before the result), unknown and pending kicks may never have reached the game.
    const unfinished = await record("kick", griefer, null, 5, { name: "Unfinished" });
    const unknown = await record("kick", griefer, "unknown", 6, { name: "Unknown result" });
    const pending = await record("kick", griefer, "pending", 7, { name: "Pending result" });
    const earlier = await record("kick", griefer, "applied", 4);
    const accepted = await record("kick", griefer, "accepted", 2, { name: "Griefer" });
    const ban = await record("ban", griefer, "applied", 1, { name: "Griefer", reason: "Cheating" });
    await record("kick", griefer, "applied", 1, { serverId: "east", name: "Elsewhere" });
    await record("kick", other, "applied", 10);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    const summaries = await admin.moderationSummaries("primary", [griefer, other, clean], since);
    expect([...summaries.keys()].sort()).toEqual([griefer, other]);
    expect(summaries.get(griefer)).toEqual({
      name: "Griefer",
      kicks: { count: 3, recent: 2, lastAt: expect.any(Date), lastBy: staff.name, lastReason: "Team killing" },
      bans: { count: 1, recent: 1, lastAt: expect.any(Date), lastBy: staff.name, lastReason: "Cheating" },
    });
    expect(summaries.get(griefer)!.bans!.lastAt.getTime()).toBeGreaterThan(
      summaries.get(griefer)!.kicks!.lastAt.getTime(),
    );
    expect(summaries.get(other)).toMatchObject({ name: null, kicks: { count: 1, recent: 1 }, bans: null });
    expect((await admin.moderationSummaries("east", [griefer])).get(griefer)).toMatchObject({
      name: "Elsewhere",
      kicks: { count: 1 },
      bans: null,
    });

    // Recent entries list the unconfirmed kicks with their outcome; only refused ones are left out.
    expect((await admin.moderationEntries("primary", griefer)).map((entry) => entry.id)).toEqual([
      ban,
      accepted,
      earlier,
      unfinished,
      unknown,
      pending,
      oldest,
    ]);
    expect(await admin.repeatOffenders("primary", since, 2)).toEqual([
      {
        steamId: griefer,
        name: "Griefer",
        kicks: { count: 2, recent: 2, lastAt: expect.any(Date), lastBy: staff.name, lastReason: "Team killing" },
      },
    ]);
    expect(await admin.repeatOffenders("primary", since, 3)).toEqual([]);
    expect(await admin.repeatOffenders("east", since, 2)).toEqual([]);
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

  it("stores game GUIDs that are not RFC 4122 UUIDs and deduplicates them across letter case", async () => {
    const telemetry = new TelemetryStore(drizzle({ client, schema }));
    const now = new Date(),
      since = new Date(now.getTime() - 60_000);
    // Version 0 / variant 0 values: valid hexadecimal GUIDs that zod's uuid() rejects.
    const serverId = "ABCDEF01-2345-0789-0BCD-EF0123456789",
      eventId = "00000000-0000-0000-0000-00000000000A",
      matchId = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
    const feed = (id: string) =>
      parseFeed({
        serverId,
        serverName: "Game label",
        events: [{ eventId: id, type: "killed", eventTime: 1, matchId }],
      });
    expect(await telemetry.ingest(feed(eventId), now, "east")).toEqual({ inserted: 1, duplicates: 0, skipped: 0 });
    expect(await telemetry.ingest(feed(eventId.toLowerCase()), now, "east")).toEqual({
      inserted: 0,
      duplicates: 1,
      skipped: 0,
    });
    expect(await telemetry.events(since, now, undefined, "east")).toEqual([
      expect.objectContaining({
        eventId: eventId.toLowerCase(),
        serverInstanceId: serverId.toLowerCase(),
        matchId: matchId.toLowerCase(),
      }),
    ]);
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
  it("halts a voted event atomically, settling only its own stale operation as unknown", async () => {
    const { operation: _operation, ...vote } = voteEventFixture();
    const event = (await events.create(vote)).event;
    expect(event.options).toEqual(vote.options);
    expect(event.progress).toEqual(vote.progress);
    const op = operation(event, "move", { action: "team" });
    const claimed = (await events.claim(event.id, event.version, op, eventStaff, event.progress))!;
    expect(await events.halt(event.id, "Interrupted.", randomUUID())).toBeNull();
    const halted = (await events.halt(event.id, "Interrupted.", op.id))!;
    expect(halted).toMatchObject({
      state: "stopping",
      operation: null,
      lastActionId: op.id,
      stop: { actorId: "system:event-halt", reason: "Interrupted." },
    });
    expect(halted.version).toBe(claimed.version + 1);
    expect((await events.operations(event.id))[0]).toMatchObject({ id: op.id, state: "unknown" });
    // A late settlement cannot reopen the event, and only the notice and the restore may start now.
    await events.settle(
      event.id,
      op.id,
      { state: "applied", message: "Late" },
      { state: "active", progress: event.progress, message: "Late" },
    );
    expect(await events.get(event.id)).toMatchObject({ state: "stopping" });
    const move = operation(event, "move", { action: "team" });
    expect(await events.claim(event.id, halted.version, move, eventStaff, event.progress)).toBeNull();
    const ended = operation(event, "ended", { action: "broadcast", message: "50v50 is over." });
    expect(await events.claim(event.id, halted.version, ended, eventStaff, event.progress)).toMatchObject({
      state: "stopping",
    });
    await events.settle(
      event.id,
      ended.id,
      { state: "applied", message: "Sent" },
      { state: "stopping", progress: event.progress, message: "Sent" },
    );
    const stopped = (await events.get(event.id))!;
    expect(await events.halt(event.id, "Again.")).toMatchObject({ stop: halted.stop });
    // The lock already reads its original value: complete without a write, only from stopping.
    expect((await events.completeRestored(event.id, stopped.version, "Already restored."))?.state).toBe("stopping");
    const current = (await events.get(event.id))!;
    expect(await events.completeRestored(event.id, current.version, "Already restored.")).toMatchObject({
      state: "complete",
      message: "Already restored.",
    });
    expect(await events.halt(event.id, "After completion.")).toBeNull();
  });
  it("never halts an event that waits for staff review", async () => {
    const { operation: _operation, ...vote } = voteEventFixture();
    const event = (await events.create(vote)).event;
    const op = operation(event, "move", { action: "team" });
    const claimed = (await events.claim(event.id, event.version, op, eventStaff, event.progress))!;
    await events.recover(claimed, new Date(claimed.updatedAt.getTime() + 121_000));
    expect(await events.halt(event.id, "Interrupted.", op.id)).toBeNull();
    expect(await events.get(event.id)).toMatchObject({ state: "needs_review", stop: null });
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
    await votes.create({ ...input, automation: { policy, policyVersion: 1, highestScore: 50, reminders: {} } });
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
  it("merges a partial save with the stored settings under the version check", async () => {
    const settings = { ...defaultVotingSettings, closeAtScore: 90 };
    await votes.savePolicy("primary", 0, { ...defaultVotingPolicy, settings }, staff, "connection");
    const result = await votes.savePolicy(
      "primary",
      1,
      (previous) => ({ ...defaultVotingPolicy, modeChoices: true, settings: previous?.settings }),
      staff,
      "connection",
    );
    expect(result.saved.policy).toMatchObject({ modeChoices: true, settings: { closeAtScore: 90 } });
    await expect(votes.savePolicy("primary", 1, (previous) => previous!, staff, "connection")).rejects.toMatchObject({
      status: 409,
    });
    expect((await votes.policy("primary"))?.version).toBe(2);
  });
  it("opens an automatic ballot only under the saved controls version", async () => {
    const input = ballotInput();
    const policy = { ...defaultVotingPolicy, enabled: true };
    await votes.savePolicy(input.serverId, 0, policy, staff, input.connectionHash);
    await expect(
      votes.create({ ...input, automation: { policy, policyVersion: 0, highestScore: 10, reminders: {} } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await votes.create({ ...input, automation: { policy, policyVersion: 1, highestScore: 10, reminders: {} } }))
        .created,
    ).toBe(true);
  });
  it("closes at the snapshot's early score with its tie rule and records a refusal", async () => {
    const input = ballotInput();
    const policy = { ...defaultVotingPolicy, enabled: true };
    await votes.savePolicy(input.serverId, 0, policy, staff, input.connectionHash);
    const settings = { ...defaultVotingSettings, closeAtScore: 90, tieRule: "first_option" as const };
    await votes.create({
      ...input,
      automation: { policy, policyVersion: 1, settings, highestScore: 70, maxStep: 0, reminders: {} },
    });
    await votes.published(input.id, messageId);
    await votes.cast(input.id, staff.id, 0, input.guildId, input.channelId, messageId);
    await votes.cast(input.id, "999999999999999999", 1, input.guildId, input.channelId, messageId);
    expect(await votes.observeScore(input.id, 80, 12)).toBe(true);
    expect(await votes.claimClose(input.id, true)).toBeNull();
    expect(await votes.observeScore(input.id, 88, 8)).toBe(true);
    expect((await votes.get(input.id))?.automation).toMatchObject({ highestScore: 88, maxStep: 12 });
    expect(await votes.claimClose(input.id, true)).toMatchObject({ state: "closing", counts: [1, 1], winner: 0 });
    expect(await votes.finish(input.id, "cancelled", "Not queued.", { outcome: "refused" })).toMatchObject({
      state: "cancelled",
      automation: { outcome: "refused", maxStep: 12 },
    });
  });
  it("patches automation only in allowed states and moves a ballot out of review once", async () => {
    const { input } = await scoreBallot();
    expect(await votes.patchAutomation(input.id, { outcome: "refused" }, ["closing"])).toBeNull();
    expect((await votes.patchAutomation(input.id, { maxStep: 4 }))?.automation).toMatchObject({ maxStep: 4 });
    expect(await votes.resolveReview(input.id, "cancelled", "Still open.", {})).toBeNull();
    await client.query("UPDATE map_votes SET state = 'needs_review', message_id = NULL WHERE id = $1", [input.id]);
    expect(await votes.needsReview()).toMatchObject([{ id: input.id }]);
    const resolved = await votes.resolveReview(
      input.id,
      "cancelled",
      "Published late.",
      { outcome: "unposted" },
      messageId,
    );
    expect(resolved).toMatchObject({ state: "cancelled", messageId, automation: { outcome: "unposted", maxStep: 4 } });
    expect(await votes.resolveReview(input.id, "queued", "Again.", {})).toBeNull();
    expect(await votes.needsReview()).toEqual([]);
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
      patreonMemberId: record.patreonMemberId!,
      displayName: null,
      patronStatus: "former_patron",
      lastChargeStatus: null,
      lastChargeAt: null,
      receivedAt: new Date(),
      trigger: "members:delete",
    };
    // A new observation reports the linked Discord account so its roles can be checked.
    expect(await supporters.ingest(observation)).toEqual({
      duplicate: false,
      memberId: record.id,
      discordId: staff.id,
    });
    expect(await supporters.ingest(observation)).toEqual({ duplicate: true });
    const saved = await supporters.get(record.id, campaign, policy);
    expect(saved).toMatchObject({
      patronStatus: "former_patron",
      founder,
      reviewState: "pending",
      version: record.version + 1,
    });
  });

  it("keeps a declined first webhook charge from blocking the later staff receipt", async () => {
    const created = await linked("declined-member", "76561198000000004");
    // Patreon signed the pledge after the first card attempt failed; the supporter paid the next day.
    expect(
      await supporters.ingest({
        hash: "e".repeat(64),
        campaignId: campaign,
        patreonMemberId: "declined-member",
        displayName: "Sample supporter",
        patronStatus: "active_patron",
        lastChargeStatus: "Declined",
        lastChargeAt: new Date("2026-09-30T12:00:00.000Z"),
        receivedAt: new Date("2026-09-30T12:00:05.000Z"),
        trigger: "members:pledge:create",
      }),
    ).toEqual({ duplicate: false, memberId: created.id, discordId: staff.id });
    let record = await payment(
      (await supporters.get(created.id, campaign, policy))!,
      "2026-10-01T12:00:00.000Z",
      "receipt-3001",
    );
    expect(
      (await client.query("SELECT count(*)::int AS count FROM supporter_payments WHERE member_id = $1", [record.id]))
        .rows,
    ).toEqual([{ count: 1 }]);
    const receipt = record.founderEligiblePayment!;
    expect(receipt).toMatchObject({ source: "manual_receipt", reference: "receipt-3001" });
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: receipt.id },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    expect(record.founder).toMatchObject({ paymentId: receipt.id });
  });

  it("imports Patreon API members idempotently and qualifies a first payment despite an earlier webhook row", async () => {
    // A webhook status row for the same charge, recorded a minute earlier, must not block the API payment.
    await supporters.ingest({
      hash: "d".repeat(64),
      campaignId: campaign,
      patreonMemberId: "api-member",
      displayName: "API supporter",
      patronStatus: "active_patron",
      lastChargeStatus: "Paid",
      lastChargeAt: new Date("2026-09-30T11:59:00.000Z"),
      receivedAt: new Date("2026-09-30T12:00:05.000Z"),
      trigger: "members:pledge:create",
    });
    const snapshot: PatreonMemberSnapshot = {
      patreonMemberId: "api-member",
      displayName: "API supporter",
      patronStatus: "active_patron",
      lastChargeStatus: "Paid",
      lastChargeAt: new Date("2026-09-30T12:00:00.000Z"),
      discordId: staff.id,
      discordKnown: true,
      events: [
        {
          id: "pledge_start:1001",
          date: new Date("2026-09-30T12:00:00.000Z"),
          amountCents: 500,
          currency: "USD",
          paymentStatus: "Paid",
          type: "pledge_start",
        },
      ],
      historyComplete: true,
    };
    expect(await supporters.importApiMember(campaign, snapshot, new Date())).toMatchObject({
      created: false,
      updated: true,
      payments: 1,
      discordLinked: true,
    });
    expect(await supporters.importApiMember(campaign, snapshot, new Date())).toMatchObject({
      updated: false,
      payments: 0,
      discordLinked: false,
    });
    let [record] = await supporters.list(campaign, policy, undefined, "api-member");
    expect(record).toMatchObject({
      discordId: staff.id,
      discordSource: "patreon",
      patreonDiscordId: staff.id,
      steamId: null,
      steamSource: null,
      identityState: "partial",
      reviewState: "pending",
      founderEligiblePayment: {
        source: "patreon_api",
        reference: "pledge_start:1001",
        verificationState: "verified",
        firstSuccessfulPaymentVerified: true,
        amountCents: 500,
      },
    });
    expect(
      (await client.query("SELECT count(*)::int AS count FROM supporter_payments WHERE member_id = $1", [record.id]))
        .rows,
    ).toEqual([{ count: 2 }]);
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "link", discordId: staff.id, steamId: "76561198000000002" },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    // Resending the Discord ID Patreon filled in keeps it a Patreon link; only the new SteamID is a staff link.
    expect(record).toMatchObject({ identityState: "patreon_linked", discordSource: "patreon", steamSource: "staff" });
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: record.founderEligiblePayment!.id },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    expect(record.founder).not.toBeNull();
    const refunded = { ...snapshot, events: [{ ...snapshot.events[0], paymentStatus: "Refunded" }] };
    expect(await supporters.importApiMember(campaign, refunded, new Date())).toMatchObject({ revoked: 1 });
    // The promise stands. The record notes that Patreon no longer shows its payment as paid; nothing is for staff.
    expect(await supporters.get(record.id, campaign, policy)).toMatchObject({
      founder: { ...record.founder, paymentVerified: false, paymentFirst: false },
      founderEligiblePayment: null,
    });
    const kinds = (
      await client.query<{ kind: string }>("SELECT kind FROM supporter_actions WHERE member_id = $1", [record.id])
    ).rows.map((row) => row.kind);
    expect(kinds.sort()).toEqual(["founder", "link", "patreon-discord-link", "patreon-payment-status"]);
  });

  it("keeps a staff receipt eligible beside the earlier imported copy of its charge and notes a refund of that copy", async () => {
    // The receipt's time was estimated from Patreon's date-only history; the real charge was earlier that morning.
    let record = await payment(
      await linked("receipt-member", "76561198000000003"),
      "2026-09-30T16:00:00.000Z",
      "receipt-2001",
    );
    const receipt = record.founderEligiblePayment!;
    expect(receipt).toMatchObject({ source: "manual_receipt", reference: "receipt-2001" });
    // The returned history fails the completeness check, so the import derives no first payment.
    const snapshot = apiMember("receipt-member", [charge("pledge_start:2001", "2026-09-30T13:42:00.000Z")], false);
    expect(await supporters.importApiMember(campaign, snapshot, new Date())).toMatchObject({ payments: 1 });
    record = (await supporters.get(record.id, campaign, policy))!;
    expect(record.latestPayment).toMatchObject({ source: "manual_receipt" });
    expect(record.founderEligiblePayment).toEqual(receipt);
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: receipt.id },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    expect(record.founder).toMatchObject({ paymentId: receipt.id, paymentVerified: true, paymentFirst: true });
    const refunded = apiMember(
      "receipt-member",
      [{ ...snapshot.events[0], paymentStatus: "Refunded" }],
      snapshot.historyComplete,
    );
    expect(await supporters.importApiMember(campaign, refunded, new Date())).toMatchObject({ revoked: 1 });
    // The promise is never changed, but the refunded charge no longer qualifies the receipt. The receipt is still
    // its first payment; Patreon no longer shows the charge behind it as paid.
    expect(await supporters.get(record.id, campaign, policy)).toMatchObject({
      founder: { ...record.founder, paymentVerified: false, paymentFirst: true },
      founderEligiblePayment: null,
    });
  });

  it("refuses a founder award on a staff receipt whose imported copy was refunded before the award", async () => {
    let record = await payment(
      await linked("refunded-member", "76561198000000004"),
      "2026-10-01T16:00:00.000Z",
      "receipt-5001",
    );
    const receiptId = record.latestPayment!.id;
    await supporters.importApiMember(
      campaign,
      apiMember("refunded-member", [charge("pledge_start:5001", "2026-10-01T18:30:00.000Z")], true),
      new Date(),
    );
    await supporters.importApiMember(
      campaign,
      apiMember(
        "refunded-member",
        [{ ...charge("pledge_start:5001", "2026-10-01T18:30:00.000Z"), paymentStatus: "Refunded" }],
        true,
      ),
      new Date(),
    );
    record = (await supporters.get(record.id, campaign, policy))!;
    expect(record.founderEligiblePayment).toBeNull();
    await expect(
      supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: receiptId },
        staff,
        campaign,
        policy,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await client.query("SELECT 1 FROM supporter_founders")).rowCount).toBe(0);
  });

  it("shows a staff receipt rather than an imported copy of the same charge with the same time", async () => {
    let record = await payment(await register("tie-member"), "2026-10-01T12:00:00.000Z", "receipt-4001");
    await supporters.importApiMember(
      campaign,
      apiMember("tie-member", [charge("pledge_start:4001", "2026-10-01T12:00:00.000Z")], true),
      new Date(),
    );
    record = (await supporters.get(record.id, campaign, policy))!;
    expect(record.founderEligiblePayment).toMatchObject({ source: "manual_receipt", reference: "receipt-4001" });
  });

  it("still blocks a staff receipt with a separate earlier imported charge inside the matching tolerance", async () => {
    // Joined on September 30 and charged again on October 1; staff recorded the second charge as the first.
    let record = await payment(
      await linked("renewal-member", "76561198000000005"),
      "2026-10-01T16:00:00.000Z",
      "receipt-3002",
    );
    const receiptId = record.latestPayment!.id;
    await supporters.importApiMember(
      campaign,
      apiMember(
        "renewal-member",
        [
          charge("pledge_start:3001", "2026-09-30T06:00:00.000Z"),
          charge("subscription:3002", "2026-10-01T05:00:00.000Z", "subscription"),
        ],
        true,
      ),
      new Date(),
    );
    record = (await supporters.get(record.id, campaign, policy))!;
    expect(record.founderEligiblePayment).toMatchObject({ source: "patreon_api", reference: "pledge_start:3001" });
    await expect(
      supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: receiptId },
        staff,
        campaign,
        policy,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each(["2026-09-30T03:59:59.999Z", "2026-10-15T04:00:00.000Z"])(
    "excludes payments outside the advertised window: %s",
    async (time) => {
      const record = await payment(await register(), time);
      expect(record.latestPayment).not.toBeNull();
      expect(record.founderEligiblePayment).toBeNull();
    },
  );

  it("awards a Patreon API founder on the Discord ID the import linked and gives them the Founder role basis", async () => {
    const patron = "678901234567890123";
    const snapshot: PatreonMemberSnapshot = {
      ...apiMember("sync-founder", [charge("pledge_start:7001", "2026-10-01T12:00:00.000Z")], true),
      discordId: patron,
    };
    expect(await supporters.importApiMember(campaign, snapshot, new Date())).toMatchObject({
      created: true,
      payments: 1,
      discordLinked: true,
    });
    let [record] = await supporters.list(campaign, policy, undefined, "sync-founder");
    // Patreon supplied the Discord ID; staff linked nothing. One linked identity is enough for every provider.
    expect(record).toMatchObject({
      discordId: patron,
      steamId: null,
      founderBlockedReason: null,
      founderEligiblePayment: {
        source: "patreon_api",
        reference: "pledge_start:7001",
        firstSuccessfulPaymentVerified: true,
        recordedBy: "system:patreon-sync",
      },
    });
    expect((await roles.desired([patron])).founder.size).toBe(0);
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: record.founderEligiblePayment!.id },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    expect(record).toMatchObject({ founder: { source: "patreon_api" }, needsDiscordLink: false });
    expect((await roles.desired([patron])).founder).toEqual(new Map([[patron, record.id]]));
    expect(await roles.foundersWithoutDiscord()).toEqual([]);
    expect(
      (
        await client.query<{ actor_id: string; kind: string }>(
          "SELECT actor_id, kind FROM supporter_actions WHERE member_id = $1 ORDER BY created_at",
          [record.id],
        )
      ).rows,
    ).toEqual([
      { actor_id: "system:patreon-sync", kind: "patreon-discord-link" },
      { actor_id: staff.id, kind: "founder" },
    ]);
  });

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

  const paypalDonor = "345678901234567890";
  const paypalInput = (overrides: Partial<PaypalInput> = {}): PaypalInput => ({
    id: randomUUID(),
    displayName: "Fictional PayPal donor",
    discordId: paypalDonor,
    paidAt: new Date("2026-10-01T16:00:00.000Z"),
    amountCents: 500,
    currency: "USD",
    transactionId: "8AB12345CD678901E",
    completedPaymentVerified: true,
    firstSuccessfulPaymentVerified: true,
    minimumConfirmed: false,
    awardFounder: false,
    reason: "Checked a fictional completed PayPal payment",
    ...overrides,
  });
  async function supporterCounts() {
    return (
      await client.query(`SELECT (SELECT count(*)::int FROM supporter_members) AS members,
        (SELECT count(*)::int FROM supporter_payments) AS payments,
        (SELECT count(*)::int FROM supporter_actions) AS actions,
        (SELECT count(*)::int FROM supporter_founders) AS founders`)
    ).rows[0];
  }

  it("records a PayPal founder with only a Discord link and lists PayPal rows without a Patreon campaign", async () => {
    const result = await supporters.recordPaypal(paypalInput({ awardFounder: true }), staff, null, policy);
    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      founder: { awarded: true, eligible: true, blockedReason: null },
      payment: {
        source: "paypal",
        reference: "8AB12345CD678901E",
        amountCents: 500,
        currency: "USD",
        verificationState: "verified",
        minimumConfirmed: false,
        recordedBy: staff.id,
      },
      supporter: {
        provider: "paypal",
        patreonMemberId: null,
        discordId: paypalDonor,
        steamId: null,
        reviewState: "verified",
        version: 1,
        founderBlockedReason: null,
        needsDiscordLink: false,
      },
    });
    expect(result.supporter.confirmKey).toBe(result.supporter.id);
    expect(result.supporter.founder).toMatchObject({ paymentId: result.payment.id, source: "paypal" });
    expect(result.supporter.payments).toMatchObject([{ id: result.payment.id, source: "paypal" }]);
    const patreonRecord = await register();
    expect((await supporters.list(null, policy)).map((record) => record.id)).toEqual([result.supporter.id]);
    expect((await supporters.list(campaign, policy)).map((record) => record.id).sort()).toEqual(
      [result.supporter.id, patreonRecord.id].sort(),
    );
    expect(await supporters.list(campaign, policy, undefined, "", "patreon")).toMatchObject([{ id: patreonRecord.id }]);
    expect(await supporters.list(null, policy, undefined, "8ab12345cd")).toMatchObject([{ id: result.supporter.id }]);
    expect(
      (
        await client.query(
          "SELECT details->>'founderAwarded' AS founder, details->>'createdMember' AS created FROM supporter_actions WHERE kind = 'paypal-payment'",
        )
      ).rows,
    ).toEqual([{ founder: "1", created: "1" }]);
  });

  it("attaches later PayPal payments to the same supporter and replays retries without writing again", async () => {
    const first = paypalInput();
    const created = await supporters.recordPaypal(first, staff, null, policy);
    expect(await supporters.recordPaypal(first, staff, null, policy)).toMatchObject({
      replayed: true,
      payment: { id: created.payment.id },
    });
    // Another reviewer recording the same transaction with matching details receives the existing records.
    expect(
      await supporters.recordPaypal(
        { ...first, id: randomUUID() },
        { ...staff, id: "234567890123456789" },
        null,
        policy,
      ),
    ).toMatchObject({ replayed: true, supporter: { id: created.supporter.id } });
    await expect(
      supporters.recordPaypal({ ...first, id: randomUUID(), amountCents: 600 }, staff, null, policy),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      supporters.recordPaypal({ ...first, reason: "Changed reason" }, staff, null, policy),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      supporters.recordPaypal({ ...first, id: randomUUID(), awardFounder: true }, staff, null, policy),
    ).rejects.toMatchObject({ status: 409, message: "Already recorded; use the founder action." });
    const second = await supporters.recordPaypal(
      paypalInput({
        transactionId: "9ZY98765XW432101V",
        displayName: "Renamed donor",
        paidAt: new Date("2026-11-01T16:00:00.000Z"),
        steamId: "76561198000000002",
        firstSuccessfulPaymentVerified: false,
      }),
      staff,
      null,
      policy,
    );
    expect(second.supporter).toMatchObject({
      id: created.supporter.id,
      version: 2,
      steamId: "76561198000000002",
      displayName: "Fictional PayPal donor",
    });
    expect(second.supporter.payments.map((item) => item.reference)).toEqual(["9ZY98765XW432101V", "8AB12345CD678901E"]);
    expect(second.founder).toEqual({ awarded: false, eligible: false, blockedReason: "not_first_payment" });
    // Attaching by record ID needs the current version, and never replaces a linked account.
    const attach = paypalInput({
      transactionId: "AAAA1111BBBB2222",
      discordId: undefined,
      memberId: created.supporter.id,
    });
    await expect(supporters.recordPaypal({ ...attach, version: 1 }, staff, null, policy)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      supporters.recordPaypal({ ...attach, version: 2, discordId: "456789012345678901" }, staff, null, policy),
    ).rejects.toMatchObject({ status: 409 });
    expect(await supporterCounts()).toEqual({ members: 1, payments: 2, actions: 2, founders: 0 });
  });

  it("records a non-USD founder only after staff confirm the minimum and rolls back a refused award", async () => {
    const input = paypalInput({
      currency: "CAD",
      amountCents: 700,
      awardFounder: true,
      discordId: undefined,
      steamId: "76561198000000003",
    });
    await expect(supporters.recordPaypal(input, staff, null, policy)).rejects.toMatchObject({
      status: 409,
      response: { blockedReason: "below_minimum" },
    });
    expect(await supporterCounts()).toEqual({ members: 0, payments: 0, actions: 0, founders: 0 });
    const confirmed = await supporters.recordPaypal(
      { ...input, id: randomUUID(), minimumConfirmed: true },
      staff,
      null,
      policy,
    );
    expect(confirmed).toMatchObject({
      founder: { awarded: true },
      payment: { currency: "CAD", amountCents: 700, minimumConfirmed: true },
      supporter: { discordId: null, steamId: "76561198000000003", needsDiscordLink: true },
    });
  });

  it("allows one founder per person across Patreon and PayPal records", async () => {
    let record = await register();
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "link", discordId: paypalDonor },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    expect(record).toMatchObject({ discordId: paypalDonor, steamId: null });
    record = await payment(record);
    expect(record.founderBlockedReason).toBeNull();
    record = (
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "founder", paymentId: record.founderEligiblePayment!.id },
        staff,
        campaign,
        policy,
      )
    ).supporter!;
    expect(record.founder).toMatchObject({ source: "manual_receipt" });
    await expect(
      supporters.recordPaypal(paypalInput({ awardFounder: true }), staff, null, policy),
    ).rejects.toMatchObject({
      status: 409,
      response: { blockedReason: "already_founder" },
    });
    const recorded = await supporters.recordPaypal(paypalInput(), staff, null, policy);
    expect(recorded.founder).toEqual({ awarded: false, eligible: false, blockedReason: "already_founder" });
    expect(recorded.supporter.founderBlockedReason).toBe("already_founder");
  });

  it("enforces each provider's record shape in the database", async () => {
    for (const values of [
      "'patreon', NULL, NULL",
      "'paypal', '999001', 'paypal-with-campaign'",
      "'stripe', NULL, NULL",
    ])
      await expect(
        client.query(
          `INSERT INTO supporter_members (id, provider, campaign_id, patreon_member_id, observed_at)
           VALUES (gen_random_uuid(), ${values}, now())`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    const { supporter } = await supporters.recordPaypal(paypalInput(), staff, null, policy);
    await expect(
      client.query(
        `INSERT INTO supporter_payments (id, member_id, campaign_id, paid_at, amount_cents, currency, source, reference,
           verification_state, recorded_at)
         VALUES (gen_random_uuid(), $1, NULL, now(), 500, 'USD', 'paypal', 'UNVERIFIED1234', 'unverified', now())`,
        [supporter.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `INSERT INTO supporter_payments (id, member_id, campaign_id, paid_at, amount_cents, currency, source, reference,
           verification_state, recorded_at)
         VALUES (gen_random_uuid(), $1, NULL, now(), 500, 'USD', 'paypal', '8AB12345CD678901E', 'verified', now())`,
        [supporter.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("serializes simultaneous copies of one PayPal transaction into one payment", async () => {
    const input = paypalInput();
    const save =
      (id: string) =>
      ({ supporters }: ReturnType<typeof worker>) =>
        supporters.recordPaypal({ ...input, id }, staff, null, policy);
    const results = await overlap("supporter_payments", save(randomUUID()), save(randomUUID()));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(values.map((value) => value.replayed).sort()).toEqual([false, true]);
    expect(values[0].payment.id).toBe(values[1].payment.id);
    expect(await supporterCounts()).toEqual({ members: 1, payments: 1, actions: 1, founders: 0 });
  });

  it("attaches simultaneous transactions from one donor to one PayPal supporter", async () => {
    const save =
      (transactionId: string) =>
      ({ supporters }: ReturnType<typeof worker>) =>
        supporters.recordPaypal(paypalInput({ transactionId }), staff, null, policy);
    const results = await overlap("supporter_members", save("8AB12345CD678901E"), save("9ZY98765XW432101V"));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(values[0].supporter.id).toBe(values[1].supporter.id);
    expect(await supporterCounts()).toEqual({ members: 1, payments: 2, actions: 2, founders: 0 });
  });

  it("allows only one PayPal supporter to link the same SteamID", async () => {
    const records = [
      (await supporters.recordPaypal(paypalInput(), staff, null, policy)).supporter,
      (
        await supporters.recordPaypal(
          paypalInput({ transactionId: "9ZY98765XW432101V", discordId: "456789012345678901" }),
          staff,
          null,
          policy,
        )
      ).supporter,
    ];
    const save =
      (index: number) =>
      ({ supporters }: ReturnType<typeof worker>) =>
        supporters.mutate(
          records[index].id,
          { ...review(records[index]), kind: "link", steamId: "76561198000000004" },
          staff,
          null,
          policy,
        );
    const results = await overlap("supporter_members", save(0), save(1));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { cause: { code: "23505" } },
    });
    expect((await supporters.list(null, policy)).filter((record) => record.steamId !== null)).toHaveLength(1);
  });

  const uncApplication = (serverId: string, discordUserId = "345678901234567890", steamId = "76561198000000011") => ({
    ...applicationInput(discordUserId, steamId),
    serverId,
    relationship: "unc_member" as const,
  });
  async function approve(id: string, serverId: string, grant: "granted" | "existing" = "granted") {
    const review = { id: randomUUID(), reason: "Reviewed fictional member" };
    expect((await applications.claim(id, review, "approve", { ...staff, serverId })).claimed).toBe(true);
    return applications.finishApproval(id, review.id, { state: "applied", message: "Confirmed" }, grant);
  }

  it("registers an existing whitelist entry, revokes it once and records each step", async () => {
    const created = (await applications.create(uncApplication("primary")))!;
    expect(await approve(created.id, "primary", "existing")).toMatchObject({
      status: "approved",
      whitelistGrant: "existing",
      accessIntent: "grant",
    });
    const actor = { ...staff, serverId: "primary" };
    const review = { id: randomUUID(), reason: "Left the fictional community" };
    const claim = await applications.claimRevoke(created.id, review, actor);
    expect(claim).toMatchObject({ claimed: true, application: { status: "revoking", accessIntent: "revoke" } });
    expect(
      (await applications.claimRevoke(created.id, { id: randomUUID(), reason: "Second reviewer" }, actor)).claimed,
    ).toBe(false);
    const revoked = await applications.finishRevoke(created.id, review.id, { state: "applied", message: "Removed" });
    expect(revoked).toMatchObject({ status: "revoked", accessIntent: "revoke", revokedAt: expect.any(Date) });
    await expect(
      applications.finishRevoke(created.id, review.id, { state: "applied", message: "Removed again" }),
    ).rejects.toThrow("no longer matches its original claim");
    expect(
      (
        await client.query(
          "SELECT kind, state FROM whitelist_application_reviews WHERE application_id = $1 ORDER BY created_at, kind",
          [created.id],
        )
      ).rows,
    ).toEqual([
      { kind: "approve", state: "applied" },
      { kind: "revoke", state: "applied" },
    ]);
  });

  it("restores approved access when the game refuses a revocation and allows a retry after an uncertain one", async () => {
    const created = (await applications.create(uncApplication("primary")))!;
    await approve(created.id, "primary");
    const actor = { ...staff, serverId: "primary" };
    const refused = { id: randomUUID(), reason: "First attempt" };
    await applications.claimRevoke(created.id, refused, actor);
    expect(
      await applications.finishRevoke(created.id, refused.id, { state: "failed", message: "Refused" }),
    ).toMatchObject({ status: "approved", accessIntent: "grant" });
    const uncertain = { id: randomUUID(), reason: "Second attempt" };
    await applications.claimRevoke(created.id, uncertain, actor);
    expect(
      await applications.finishRevoke(created.id, uncertain.id, { state: "unknown", message: "Lost response" }),
    ).toMatchObject({ status: "needs_review", accessIntent: "revoke" });
    expect((await applications.claimRevoke(created.id, { id: randomUUID(), reason: "Retry" }, actor)).claimed).toBe(
      true,
    );
  });

  it("revokes the approved application when its SteamID is removed on the Whitelist page, on that server only", async () => {
    const east = (await applications.create(uncApplication("east")))!;
    const central = (await applications.create(uncApplication("central")))!;
    await approve(east.id, "east");
    await approve(central.id, "central");
    const actionId = randomUUID();
    const revoked = await applications.recordExternalRevoke({
      serverId: "east",
      steamId: "76561198000000011",
      actionId,
      actorId: staff.id,
      actorName: staff.name,
      state: "applied",
    });
    expect(revoked.map((application) => application.id)).toEqual([east.id]);
    expect((await applications.get(central.id, "central"))?.status).toBe("approved");
    expect(
      (await client.query("SELECT actor_id, reason, state FROM whitelist_application_reviews WHERE kind = 'revoke'"))
        .rows,
    ).toEqual([
      { actor_id: staff.id, reason: `Removed from the Whitelist page (action ${actionId}).`, state: "applied" },
    ]);
    // The UNC role stays while another approved UNC application remains.
    expect((await roles.desired()).member.get("345678901234567890")).toBe(central.id);
    expect(await roles.revokedBasis()).toEqual(new Map());
    await applications.recordExternalRevoke({
      serverId: "central",
      steamId: "76561198000000011",
      actionId: randomUUID(),
      actorId: staff.id,
      actorName: staff.name,
      state: "pending",
    });
    expect((await roles.desired()).member.size).toBe(0);
    expect((await roles.revokedBasis()).has("345678901234567890")).toBe(true);
  });

  describe("automatic supporter matching", () => {
    const patron = "456789012345678901";
    const patronSteam = "76561198000000021";
    // No waiting period, so list() verdicts do not depend on when the suite runs.
    const automaticPolicy: FounderPolicy = { ...policy, automaticHoldHours: 0 };
    const options = (overrides: Partial<AutoMatchOptions> = {}): AutoMatchOptions => ({
      campaignId: campaign,
      policy: automaticPolicy,
      fillSteam: true,
      recordFounder: true,
      now: new Date(),
      ...overrides,
    });
    async function importPatron(
      patreonMemberId = "auto-patron",
      discordId: string | null = patron,
      event = charge(`pledge_start:${patreonMemberId}`, "2026-10-01T12:00:00.000Z"),
    ) {
      await supporters.importApiMember(
        campaign,
        { ...apiMember(patreonMemberId, [event], true), discordId },
        new Date(),
      );
      return (await supporters.list(campaign, automaticPolicy, undefined, patreonMemberId))[0];
    }
    async function application(discordUserId = patron, steamId = patronSteam, serverId = "primary") {
      return (await applications.create({ ...applicationInput(discordUserId, steamId), serverId }))!;
    }
    // The store's view has no steps: the service adds them, as the page receives them, with every switch on.
    const stepCodes = (view: SupporterView | null) =>
      supporterNextSteps(view!, { steamFill: true, founderAuto: true, importConfigured: true, holdHours: 0 }).map(
        (step) => step.code,
      );
    const kinds = async (memberId: string) =>
      (
        await client.query<{ actor_id: string; kind: string }>(
          "SELECT actor_id, kind FROM supporter_actions WHERE member_id = $1 ORDER BY created_at, kind",
          [memberId],
        )
      ).rows;

    it("labels older links by the action that made them, once, without touching versions", async () => {
      const fromPatreon = await importPatron("labelled-patreon");
      // An older dashboard resent the Patreon Discord ID with the SteamID; that Link did not change the account.
      await supporters.mutate(
        fromPatreon.id,
        { ...review(fromPatreon), kind: "link", discordId: patron, steamId: patronSteam },
        staff,
        campaign,
        policy,
      );
      const relinked = await importPatron("labelled-staff", "567890123456789012");
      await supporters.mutate(
        relinked.id,
        { ...review(relinked), kind: "link", discordId: "567890123456789013" },
        staff,
        campaign,
        policy,
      );
      // Patreon linked one account, staff moved the link to another and then back: the last Link set it, so staff.
      const returned = await importPatron("labelled-returned", "567890123456789014");
      const moved = (
        await supporters.mutate(
          returned.id,
          { ...review(returned), kind: "link", discordId: "567890123456789015" },
          staff,
          campaign,
          policy,
        )
      ).supporter!;
      await supporters.mutate(
        returned.id,
        { ...review(moved), kind: "link", discordId: "567890123456789014" },
        staff,
        campaign,
        policy,
      );
      await client.query(
        "UPDATE supporter_members SET discord_source = NULL, steam_source = NULL, steam_application_id = NULL",
      );
      const versions = async () => (await client.query("SELECT id, version FROM supporter_members ORDER BY id")).rows;
      const before = await versions();
      expect(await match.backfillSources()).toEqual({ discord: 3, steam: 1 });
      expect(
        (
          await client.query(
            "SELECT patreon_member_id, discord_source, steam_source FROM supporter_members ORDER BY patreon_member_id",
          )
        ).rows,
      ).toEqual([
        { patreon_member_id: "labelled-patreon", discord_source: "patreon", steam_source: "staff" },
        { patreon_member_id: "labelled-returned", discord_source: "staff", steam_source: null },
        { patreon_member_id: "labelled-staff", discord_source: "staff", steam_source: null },
      ]);
      expect(await match.backfillSources()).toEqual({ discord: 0, steam: 0 });
      expect(await versions()).toEqual(before);
    });

    it("copies the approved SteamID and records an automatic founder with its Founder role basis, once", async () => {
      const record = await importPatron();
      expect(record).toMatchObject({ identityState: "partial", discordSource: "patreon", patreonDiscordId: patron });
      const created = await application();
      expect(await approve(created.id, "primary")).toMatchObject({ whitelistGrant: "granted" });
      // No SteamID is linked yet, and the automatic founder does not wait for one.
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.automaticBlockedReason).toBeNull();
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: true,
        founderRecorded: true,
        blocked: [],
      });
      const view = (await supporters.get(record.id, campaign, automaticPolicy))!;
      expect(view).toMatchObject({
        steamId: patronSteam,
        steamSource: "application",
        steamApplicationId: created.id,
        identityState: "patreon_linked",
        version: record.version + 1,
        founder: { automatic: true, source: "patreon_api" },
        match: { sourceApplication: { id: created.id, serverId: "primary", status: "approved" } },
      });
      expect(await kinds(record.id)).toEqual([
        { actor_id: "system:patreon-sync", kind: "patreon-discord-link" },
        { actor_id: "system:supporter-match", kind: "application-steam-link" },
        { actor_id: "system:supporter-match", kind: "founder" },
      ]);
      expect((await roles.desired([patron])).founder).toEqual(new Map([[patron, record.id]]));
      // A second run, from any trigger, writes nothing.
      expect(await match.autoMatch(record.id, options())).toMatchObject({ steamFilled: false, founderRecorded: false });
      expect(await kinds(record.id)).toHaveLength(3);
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.version).toBe(view.version);
      expect(
        await match.candidates(campaign, automaticPolicy, { fillSteam: true, recordFounder: true }, null, 10),
      ).toEqual([]);
      // After a refund the record notes it, and the promise itself is untouched.
      await supporters.importApiMember(
        campaign,
        {
          ...apiMember(
            "auto-patron",
            [{ ...charge("pledge_start:auto-patron", "2026-10-01T12:00:00.000Z"), paymentStatus: "Refunded" }],
            true,
          ),
          discordId: patron,
        },
        new Date(),
      );
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        founder: { automatic: true, paymentId: view.founder!.paymentId, paymentVerified: false, paymentFirst: false },
      });
      expect((await roles.desired([patron])).founder).toEqual(new Map([[patron, record.id]]));
    });

    it("records an automatic founder with only a Discord account and copies the SteamID once it is approved", async () => {
      const record = await importPatron();
      expect(record).toMatchObject({
        identityState: "partial",
        steamId: null,
        founderBlockedReason: null,
        automaticBlockedReason: null,
      });
      const steps = { fillSteam: true, recordFounder: true };
      expect(await match.candidates(campaign, automaticPolicy, steps, null, 10)).toEqual([record.id]);
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: false,
        founderRecorded: true,
        blocked: ["no_application"],
      });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        steamId: null,
        identityState: "partial",
        version: record.version + 1,
        founder: { automatic: true, source: "patreon_api" },
        needsDiscordLink: false,
        automaticBlockedReason: null,
      });
      expect((await roles.desired([patron])).founder).toEqual(new Map([[patron, record.id]]));
      expect((await kinds(record.id)).map((row) => row.kind).sort()).toEqual(["founder", "patreon-discord-link"]);
      expect(
        (
          await client.query(
            "SELECT details->>'discordId' AS discord, details->>'steamId' AS steam FROM supporter_actions WHERE member_id = $1 AND kind = 'founder'",
            [record.id],
          )
        ).rows,
      ).toEqual([{ discord: patron, steam: null }]);
      // Nothing is left for automation until an application is approved.
      expect(await match.candidates(campaign, automaticPolicy, steps, null, 10)).toEqual([]);
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: false,
        founderRecorded: false,
        blocked: ["no_application"],
      });
      await approve((await application()).id, "primary");
      expect(await match.candidates(campaign, automaticPolicy, steps, null, 10)).toEqual([record.id]);
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: true,
        founderRecorded: false,
        blocked: [],
      });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        steamId: patronSteam,
        steamSource: "application",
        identityState: "patreon_linked",
        version: record.version + 2,
        founder: { automatic: true },
      });
      expect((await client.query("SELECT count(*)::int AS count FROM supporter_founders")).rows).toEqual([
        { count: 1 },
      ]);
    });

    it("leaves an approval without a recorded grant for staff, showing the SteamID to check", async () => {
      const record = await importPatron();
      const created = await application();
      const reviewed = { id: randomUUID(), reason: "Approved before grants were recorded" };
      await applications.claim(created.id, reviewed, "approve", { ...staff, serverId: "primary" });
      await applications.finishApproval(created.id, reviewed.id, { state: "applied", message: "Confirmed" }, null);
      expect(await match.autoMatch(record.id, options({ recordFounder: false }))).toMatchObject({
        steamFilled: false,
        blocked: ["application_not_confirmed"],
      });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        steamId: null,
        match: { steam: { reason: "application_not_confirmed", steamId: patronSteam, applicationId: created.id } },
      });
    });

    it("lets staff win for both identities and keeps what Patreon reports later", async () => {
      let record = await importPatron();
      await approve((await application()).id, "primary");
      record = (
        await supporters.mutate(
          record.id,
          { ...review(record), kind: "link", discordId: "567890123456789018", steamId: "76561198000000022" },
          staff,
          campaign,
          policy,
        )
      ).supporter!;
      expect(await match.autoMatch(record.id, options({ recordFounder: false }))).toMatchObject({ steamFilled: false });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        discordId: "567890123456789018",
        discordSource: "staff",
        steamId: "76561198000000022",
        steamSource: "staff",
      });
      expect(
        await supporters.importApiMember(
          campaign,
          {
            ...apiMember("auto-patron", [charge("pledge_start:auto-patron", "2026-10-01T12:00:00.000Z")], true),
            discordId: "567890123456789014",
          },
          new Date(),
        ),
      ).toMatchObject({ discordLinked: false, conflict: "discord-differs" });
      const differs = await supporters.get(record.id, campaign, automaticPolicy);
      expect(differs).toMatchObject({
        discordId: "567890123456789018",
        discordSource: "staff",
        patreonDiscordId: "567890123456789014",
        automaticBlockedReason: "discord_not_from_patreon",
      });
      expect(stepCodes(differs)).toContain("discord_differs");
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        founderRecorded: false,
        blocked: ["discord_not_from_patreon"],
      });
    });

    it("follows the account Patreon reports for a Patreon link, and confirms a staff link Patreon reports", async () => {
      const record = await importPatron("following-patron");
      const report = (discordId: string | null) =>
        supporters.importApiMember(
          campaign,
          {
            ...apiMember(
              "following-patron",
              [charge("pledge_start:following-patron", "2026-10-01T12:00:00.000Z")],
              true,
            ),
            discordId,
          },
          new Date(),
        );
      // Patreon no longer reports any account: the link is kept.
      expect(await report(null)).toMatchObject({ discordLinked: false, patreonDiscordChanged: true });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        discordId: patron,
        discordSource: "patreon",
        patreonDiscordId: null,
        automaticBlockedReason: null,
      });
      // Patreon reports another account: the Patreon link follows it.
      expect(await report("567890123456789019")).toMatchObject({
        discordLinked: true,
        discordId: "567890123456789019",
        releasedDiscordIds: [patron],
      });
      let view = (await supporters.get(record.id, campaign, automaticPolicy))!;
      expect(view).toMatchObject({ discordId: "567890123456789019", discordSource: "patreon" });
      // Staff link another account, and Patreon later reports exactly that one: it becomes a Patreon link.
      view = (
        await supporters.mutate(
          record.id,
          { ...review(view), kind: "link", discordId: "567890123456789020" },
          staff,
          campaign,
          policy,
        )
      ).supporter!;
      expect(view.discordSource).toBe("staff");
      expect(await report("567890123456789020")).toMatchObject({ discordConfirmed: true, conflict: null });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        discordId: "567890123456789020",
        discordSource: "patreon",
      });
      expect((await kinds(record.id)).map((row) => row.kind)).toEqual([
        "patreon-discord-link",
        "patreon-discord-link",
        "link",
        "patreon-discord-confirmed",
      ]);
    });

    it("moves an account to the patron Patreon now reports it for, from a record Patreon no longer reports it for", async () => {
      const earlier = await importPatron("earlier-patron");
      // Patreon stops reporting the account for the first patron, then reports it for a second one.
      await supporters.importApiMember(
        campaign,
        {
          ...apiMember("earlier-patron", [charge("pledge_start:earlier-patron", "2026-10-01T12:00:00.000Z")], true),
          discordId: null,
        },
        new Date(),
      );
      const later = await importPatron("later-patron");
      expect(later).toMatchObject({ discordId: patron, discordSource: "patreon", patreonDiscordId: patron });
      expect(await supporters.get(earlier.id, campaign, automaticPolicy)).toMatchObject({
        discordId: null,
        discordSource: null,
      });
      expect((await kinds(earlier.id)).map((row) => row.kind)).toEqual([
        "patreon-discord-link",
        "patreon-discord-moved",
      ]);
      // Once that patron is a founder, the account stays where it is.
      const founder = await importPatron("founder-patron", "567890123456789021");
      await match.autoMatch(founder.id, options({ fillSteam: false }));
      await supporters.importApiMember(
        campaign,
        {
          ...apiMember("founder-patron", [charge("pledge_start:founder-patron", "2026-10-01T12:00:00.000Z")], true),
          discordId: null,
        },
        new Date(),
      );
      const kept = await importPatron("kept-patron", "567890123456789021");
      expect(kept).toMatchObject({ discordId: null, patreonDiscordId: "567890123456789021" });
      expect(await supporters.get(founder.id, campaign, automaticPolicy)).toMatchObject({
        discordId: "567890123456789021",
        founder: { automatic: true },
      });
    });

    it("still sees the earlier payment on a record Patreon took the Discord account from", async () => {
      const beforeWindow = (id: string) => charge(`pledge_start:${id}`, "2026-09-01T12:00:00.000Z");
      const report = (id: string, discordId: string | null) =>
        supporters.importApiMember(campaign, { ...apiMember(id, [beforeWindow(id)], true), discordId }, new Date());
      // The person paid before the window on one Patreon account, then connected Discord to a second one instead
      // and paid in the window there. Patreon moves the account to the second record.
      const moved = "567890123456789024";
      const first = await importPatron("paid-before-patron", moved, beforeWindow("paid-before-patron"));
      await report("paid-before-patron", null);
      const second = await importPatron("paid-in-window-patron", moved);
      expect(await supporters.get(first.id, campaign, automaticPolicy)).toMatchObject({ discordId: null });
      expect(second).toMatchObject({
        discordId: moved,
        discordSource: "patreon",
        founderBlockedReason: null,
        automaticBlockedReason: "earlier_payment_other_record",
      });
      // A note, not a task: Gramps decided they are not a founder. The SteamID step is for the whitelist later.
      expect(stepCodes(second)).toEqual(["no_whitelist_application", "founder_earlier_payment_other_record"]);
      expect(await match.autoMatch(second.id, options({ fillSteam: false }))).toMatchObject({
        founderRecorded: false,
        blocked: ["earlier_payment_other_record"],
      });
      // The same when a Patreon link followed another account and the account it gave up turns up elsewhere.
      const released = "567890123456789025";
      const relinked = await importPatron("relinked-patron", released, beforeWindow("relinked-patron"));
      await report("relinked-patron", "567890123456789026");
      expect(await supporters.get(relinked.id, campaign, automaticPolicy)).toMatchObject({
        discordId: "567890123456789026",
      });
      const later = await importPatron("released-to-patron", released);
      expect(later).toMatchObject({ discordId: released, automaticBlockedReason: "earlier_payment_other_record" });
      expect(await match.autoMatch(later.id, options({ fillSteam: false }))).toMatchObject({ founderRecorded: false });
      expect((await client.query("SELECT count(*)::int AS count FROM supporter_founders")).rows).toEqual([
        { count: 0 },
      ]);
    });

    it("knows a payment in another currency on a tier under US$5 is not worth it, so nothing waits", async () => {
      const cheap = {
        ...charge("pledge_start:cheap-tier-patron", "2026-10-01T12:00:00.000Z"),
        amountCents: 400,
        currency: "CAD",
        tierId: "222",
        tierAmountCents: 300,
      };
      const record = await importPatron("cheap-tier-patron", patron, cheap);
      expect(record).toMatchObject({
        founderBlockedReason: "below_minimum",
        founderTierBelowMinimum: true,
        founderBlockedMessage: "Their tier costs less than US$5.",
        automaticBlockedReason: "below_minimum",
      });
      expect(
        supporterNextSteps(record, { steamFill: true, founderAuto: true, importConfigured: true, holdHours: 0 }),
      ).toEqual([{ code: "founder_below_minimum", area: "info", message: "Their tier costs less than US$5." }]);
      // The next sync at the same price writes nothing.
      expect(
        await supporters.importApiMember(
          campaign,
          { ...apiMember("cheap-tier-patron", [cheap], true), discordId: patron },
          new Date(),
        ),
      ).toMatchObject({ updated: false, tierUnconfirmed: 1 });
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.version).toBe(record.version);
      expect(
        (
          await client.query(
            "SELECT actor_id, details FROM supporter_actions WHERE member_id = $1 AND kind = 'patreon-payment-below-minimum'",
            [record.id],
          )
        ).rows,
      ).toEqual([
        {
          actor_id: "system:patreon-sync",
          details: expect.objectContaining({ reference: "pledge_start:cheap-tier-patron", tierAmountCents: 300 }),
        },
      ]);
    });

    it("records an automatic founder on a history that starts with a renewal, once the refund wait is over", async () => {
      // Patreon returned the patron's whole history, which starts with a renewal rather than the pledge start.
      const record = await importPatron(
        "renewal-patron",
        patron,
        charge("subscription:renewal-patron", "2026-10-01T12:00:00.000Z", "subscription"),
      );
      expect(record).toMatchObject({
        founderBlockedReason: null,
        founderFirstPaymentWaiting: false,
        founderEligiblePayment: { reference: "subscription:renewal-patron", firstSuccessfulPaymentVerified: true },
      });
      const waiting = { ...policy, automaticHoldHours: 72 };
      expect(
        await match.autoMatch(
          record.id,
          options({ policy: waiting, fillSteam: false, now: new Date("2026-10-02T12:00:00.000Z") }),
        ),
      ).toMatchObject({ founderRecorded: false, blocked: ["payment_too_recent"] });
      expect(
        await match.autoMatch(
          record.id,
          options({ policy: waiting, fillSteam: false, now: new Date("2026-10-04T12:00:00.000Z") }),
        ),
      ).toMatchObject({ founderRecorded: true, blocked: [] });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        founder: { automatic: true, paymentVerified: true, paymentFirst: true },
      });
    });

    it("asks staff to confirm the previous Discord account's SteamID before it follows a new account", async () => {
      const record = await importPatron();
      await application();
      const moved = { ...review(record), kind: "link" as const, discordId: "567890123456789017", steamId: patronSteam };
      await expect(supporters.mutate(record.id, moved, staff, campaign, policy)).rejects.toMatchObject({
        status: 409,
        response: { blockedReason: "steam_from_application" },
      });
      expect(
        (
          await supporters.mutate(
            record.id,
            { ...moved, id: randomUUID(), steamConfirmed: true },
            staff,
            campaign,
            policy,
          )
        ).supporter,
      ).toMatchObject({ discordId: "567890123456789017", steamId: patronSteam, steamSource: "staff" });
    });

    it("records an automatic founder on a staff SteamID another Discord account applied with, and keeps the alert", async () => {
      const record = await importPatron();
      await supporters.mutate(
        record.id,
        { ...review(record), kind: "link", steamId: patronSteam },
        staff,
        campaign,
        policy,
      );
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        steamSource: "staff",
        match: { linkedSteamShared: false },
        automaticBlockedReason: null,
      });
      await application("567890123456789016", patronSteam);
      // A founder needs no SteamID. The alert matters for the whitelist promise later.
      const shared = await supporters.get(record.id, campaign, automaticPolicy);
      expect(shared).toMatchObject({ match: { linkedSteamShared: true }, automaticBlockedReason: null });
      expect(stepCodes(shared)).toContain("linked_steam_shared");
      expect(await match.autoMatch(record.id, options())).toMatchObject({ founderRecorded: true, blocked: [] });
    });

    it("shows a Discord account Patreon reports for one record while another links it", async () => {
      const linked = await register("linked-by-staff");
      await supporters.mutate(
        linked.id,
        { ...review(linked), kind: "link", discordId: patron },
        staff,
        campaign,
        policy,
      );
      const reported = await importPatron("reported-by-patreon");
      expect(reported).toMatchObject({
        discordId: null,
        patreonDiscordId: patron,
        match: { patreonDiscordElsewhere: true },
      });
      expect(await supporters.get(linked.id, campaign, automaticPolicy)).toMatchObject({
        discordSource: "staff",
        match: { discordReportedForOtherPatron: true },
        automaticBlockedReason: "discord_not_from_patreon",
      });
    });

    it("keeps a copied SteamID when its application is revoked, flags it, and copies nothing during a review", async () => {
      const record = await importPatron();
      const created = await application();
      await approve(created.id, "primary");
      expect(await match.autoMatch(record.id, options({ recordFounder: false }))).toMatchObject({ steamFilled: true });
      const actor = { ...staff, serverId: "primary" };
      const revocation = { id: randomUUID(), reason: "Left the fictional community" };
      await applications.claimRevoke(created.id, revocation, actor);
      // A founder needs no SteamID, so the revocation never stops one.
      expect(await match.autoMatch(record.id, options())).toMatchObject({ founderRecorded: true, blocked: [] });
      await applications.finishRevoke(created.id, revocation.id, { state: "applied", message: "Removed" });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        steamId: patronSteam,
        steamSource: "application",
        match: { sourceApplicationRevoked: true, steam: { reason: "no_approved_application" } },
      });
      const other = await importPatron("reviewing-patron", "567890123456789015");
      const pending = await application("567890123456789015", "76561198000000023");
      await applications.claim(pending.id, { id: randomUUID(), reason: "Approving" }, "approve", actor);
      expect(await match.autoMatch(other.id, options({ recordFounder: false }))).toMatchObject({
        steamFilled: false,
        blocked: ["application_in_progress"],
      });
    });

    it("makes a revocation claim wait for a SteamID copy that holds the application", async () => {
      const created = await application();
      await approve(created.id, "primary");
      const holder = await client.connect();
      let claim: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        // The lock automatic matching takes before reading the applications.
        await holder.query("SELECT id FROM whitelist_applications WHERE discord_user_id = $1 ORDER BY id FOR SHARE", [
          patron,
        ]);
        claim = workers[0].applications.claimRevoke(
          created.id,
          { id: randomUUID(), reason: "Left the fictional community" },
          { ...staff, serverId: "primary" },
        );
        await waitForBlockedWorkers(1);
      } finally {
        await holder.query("COMMIT");
        holder.release();
      }
      await expect(claim).resolves.toMatchObject({ claimed: true });
    });

    it("refuses to copy a SteamID that another record links while the copy waits for its lock", async () => {
      const record = await importPatron();
      await approve((await application()).id, "primary");
      const holder = await client.connect();
      let fill: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        // The lock a staff Link or a PayPal record takes before it writes this SteamID.
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`supporter:steam:${patronSteam}`]);
        fill = workers[0].match.autoMatch(record.id, options({ recordFounder: false }));
        await waitForBlockedWorkers(1);
        await holder.query(
          "INSERT INTO supporter_members (id, provider, observed_at, steam_id, steam_source) VALUES ($1, 'paypal', now(), $2, 'staff')",
          [randomUUID(), patronSteam],
        );
      } finally {
        await holder.query("COMMIT");
        holder.release();
      }
      await expect(fill).resolves.toMatchObject({ steamFilled: false, blocked: ["steam_on_another_record"] });
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.steamId).toBeNull();
    });

    it("fills the SteamID and records the founder once when two matches overlap", async () => {
      const record = await importPatron();
      await approve((await application()).id, "primary");
      const results = await overlap(
        "supporter_members",
        ({ match }) => match.autoMatch(record.id, options()),
        ({ match }) => match.autoMatch(record.id, options()),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const values = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      expect(values.filter((value) => value.steamFilled)).toHaveLength(1);
      expect(values.filter((value) => value.founderRecorded)).toHaveLength(1);
      expect((await kinds(record.id)).map((row) => row.kind)).toEqual([
        "patreon-discord-link",
        "application-steam-link",
        "founder",
      ]);
    });

    it("records one founder when an automatic match and a PayPal founder award for the same person overlap", async () => {
      const record = await importPatron();
      await approve((await application()).id, "primary");
      const results = await overlap<unknown>(
        "supporter_members",
        ({ match }) => match.autoMatch(record.id, options()),
        ({ supporters }) =>
          supporters.recordPaypal(
            paypalInput({ discordId: patron, paidAt: new Date("2026-10-02T12:00:00.000Z"), awardFounder: true }),
            staff,
            null,
            policy,
          ),
      );
      expect((await client.query("SELECT count(*)::int AS count FROM supporter_founders")).rows).toEqual([
        { count: 1 },
      ]);
      const automatic = results[0] as PromiseSettledResult<AutoMatchResult>;
      const paypal = results[1];
      if (automatic.status === "fulfilled" && automatic.value.founderRecorded)
        expect(paypal).toMatchObject({
          status: "rejected",
          reason: { response: { blockedReason: "already_founder" } },
        });
      else {
        expect(paypal.status).toBe("fulfilled");
        expect(automatic).toMatchObject({ status: "fulfilled", value: { founderRecorded: false } });
      }
    });

    it("leaves no partial records when a staff link takes the same SteamID first", async () => {
      const record = await importPatron();
      await approve((await application()).id, "primary");
      const other = await register("staff-linked");
      const results = await overlap<unknown>(
        "supporter_members",
        ({ match }) => match.autoMatch(record.id, options()),
        ({ supporters }) =>
          supporters.mutate(
            other.id,
            { ...review(other), kind: "link", steamId: patronSteam },
            staff,
            campaign,
            policy,
          ),
      );
      const holders = (
        await client.query<{ id: string }>("SELECT id FROM supporter_members WHERE steam_id = $1", [patronSteam])
      ).rows;
      expect(holders).toHaveLength(1);
      if (holders[0].id === other.id) {
        // Both writes take the SteamID lock first, so the match waits, sees the staff link and fills nothing. The
        // record that took the SteamID may be the same person's, so no founder is recorded either.
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: { steamFilled: false, founderRecorded: false, blocked: ["steam_on_another_record"] },
        });
        expect((await kinds(record.id)).map((row) => row.kind)).toEqual(["patreon-discord-link"]);
        expect((await client.query("SELECT count(*)::int AS count FROM supporter_founders")).rows).toEqual([
          { count: 0 },
        ]);
      } else expect(results[1].status).toBe("rejected");
    });

    it("records no second founder for a person another record already knows by their SteamID", async () => {
      // A PayPal founder recorded with a SteamID and no Discord account.
      const paypal = await supporters.recordPaypal(
        paypalInput({ discordId: undefined, steamId: patronSteam, awardFounder: true }),
        staff,
        null,
        policy,
      );
      expect(paypal).toMatchObject({
        founder: { awarded: true },
        supporter: { discordId: null, steamId: patronSteam },
      });
      // The same person joins Patreon, connects Discord and applies with that SteamID.
      const record = await importPatron();
      await approve((await application()).id, "primary");
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        steamId: null,
        automaticBlockedReason: "steam_on_another_record",
        match: { steam: { reason: "steam_on_another_record", steamId: patronSteam } },
      });
      for (const fillSteam of [true, false])
        expect(await match.autoMatch(record.id, options({ fillSteam }))).toMatchObject({
          steamFilled: false,
          founderRecorded: false,
          blocked: ["steam_on_another_record"],
        });
      expect((await client.query<{ member_id: string }>("SELECT member_id FROM supporter_founders")).rows).toEqual([
        { member_id: paypal.supporter.id },
      ]);
      expect((await kinds(record.id)).map((row) => row.kind)).toEqual(["patreon-discord-link"]);
    });

    it("refuses a founder by SteamID for a person already recorded on the Discord account that applied with it", async () => {
      // Patreon first: the patron connected Discord and applied, and no SteamID is linked to the record.
      const record = await importPatron();
      await approve((await application()).id, "primary");
      expect(await match.autoMatch(record.id, options({ fillSteam: false }))).toMatchObject({
        steamFilled: false,
        founderRecorded: true,
        blocked: [],
      });
      // Staff then record the same person's PayPal payment by SteamID alone and ask for a founder promise.
      const award = paypalInput({ discordId: undefined, steamId: patronSteam, awardFounder: true });
      await expect(supporters.recordPaypal(award, staff, null, policy)).rejects.toMatchObject({
        status: 409,
        response: { blockedReason: "steam_applied_by_founder" },
      });
      expect(await supporterCounts()).toMatchObject({ members: 1, payments: 1, founders: 1 });
      // The payment alone is recorded, and its record says why no founder promise can be recorded on it.
      const paypal = await supporters.recordPaypal(
        { ...award, id: randomUUID(), awardFounder: false },
        staff,
        null,
        policy,
      );
      expect(paypal).toMatchObject({
        founder: { awarded: false, eligible: false, blockedReason: "steam_applied_by_founder" },
        supporter: { discordId: null, steamId: patronSteam, founderBlockedReason: "steam_applied_by_founder" },
      });
      await expect(
        supporters.mutate(
          paypal.supporter.id,
          { ...review(paypal.supporter), kind: "founder", paymentId: paypal.payment.id },
          staff,
          null,
          policy,
        ),
      ).rejects.toMatchObject({ status: 409, response: { blockedReason: "steam_applied_by_founder" } });
      // Staff link the SteamID on the founder's record. Both records then hold it, and the plain rule applies.
      const founder = (await supporters.get(record.id, campaign, automaticPolicy))!;
      expect(founder).toMatchObject({
        steamId: null,
        founder: { automatic: true },
        match: { steam: { reason: "steam_on_another_record", steamId: patronSteam } },
      });
      expect(
        (
          await supporters.mutate(
            record.id,
            { ...review(founder), kind: "link", steamId: patronSteam },
            staff,
            campaign,
            policy,
          )
        ).supporter,
      ).toMatchObject({ steamId: patronSteam, steamSource: "staff", founder: { automatic: true } });
      expect((await supporters.get(paypal.supporter.id, null, policy))?.founderBlockedReason).toBe("already_founder");
      expect((await client.query<{ member_id: string }>("SELECT member_id FROM supporter_founders")).rows).toEqual([
        { member_id: record.id },
      ]);
    });

    it("records one founder when a match on a Discord account and a PayPal founder award for its SteamID overlap", async () => {
      const record = await importPatron();
      await approve((await application()).id, "primary");
      const results = await overlap<unknown>(
        "supporter_members",
        // No SteamID is linked, so the match records the founder on the Discord account alone.
        ({ match }) => match.autoMatch(record.id, options({ fillSteam: false })),
        ({ supporters }) =>
          supporters.recordPaypal(
            paypalInput({ discordId: undefined, steamId: patronSteam, awardFounder: true }),
            staff,
            null,
            policy,
          ),
      );
      expect((await client.query("SELECT count(*)::int AS count FROM supporter_founders")).rows).toEqual([
        { count: 1 },
      ]);
      const automatic = results[0] as PromiseSettledResult<AutoMatchResult>;
      const paypal = results[1];
      if (automatic.status === "fulfilled" && automatic.value.founderRecorded)
        // The award waited for the SteamID lock, then found the founder through the whitelist application.
        expect(paypal).toMatchObject({
          status: "rejected",
          reason: { response: { blockedReason: "steam_applied_by_founder" } },
        });
      else {
        // The match waited for the SteamID lock, then found the PayPal record that holds the SteamID.
        expect(paypal.status).toBe("fulfilled");
        expect(automatic).toMatchObject({
          status: "fulfilled",
          value: { steamFilled: false, founderRecorded: false, blocked: ["steam_on_another_record"] },
        });
      }
    });

    it("leaves the founder to staff, with the SteamID fill on or off, while another record holds a second SteamID the account applied with", async () => {
      // The patron's approved application is clean. On another server they applied with a second SteamID, and a
      // PayPal founder record holds that one.
      const secondSteam = "76561198000000024";
      const paypal = await supporters.recordPaypal(
        paypalInput({ discordId: undefined, steamId: secondSteam, awardFounder: true }),
        staff,
        null,
        policy,
      );
      const record = await importPatron();
      await approve((await application()).id, "primary");
      await application(patron, secondSteam, "east");
      const blocked = { automaticBlockedReason: "steam_on_another_record", founder: null, founderBlockedReason: null };
      // Before the fill: the approved SteamID can be copied, and the page already says the founder is not automatic.
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        ...blocked,
        steamId: null,
        match: { steam: { reason: null, steamId: patronSteam } },
      });
      expect(await match.autoMatch(record.id, options({ fillSteam: false }))).toMatchObject({
        steamFilled: false,
        founderRecorded: false,
        blocked: ["steam_on_another_record"],
      });
      // The fill copies the approved SteamID and changes nothing about the founder, in that run or the next.
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: true,
        founderRecorded: false,
        blocked: ["steam_on_another_record"],
      });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        ...blocked,
        steamId: patronSteam,
        steamSource: "application",
      });
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: false,
        founderRecorded: false,
        blocked: ["steam_on_another_record"],
      });
      expect((await client.query<{ member_id: string }>("SELECT member_id FROM supporter_founders")).rows).toEqual([
        { member_id: paypal.supporter.id },
      ]);
      expect((await kinds(record.id)).map((row) => row.kind).sort()).toEqual([
        "application-steam-link",
        "patreon-discord-link",
      ]);
    });

    it("records no automatic founder on a first payment in another currency", async () => {
      const record = await importPatron("euro-patron", patron, {
        ...charge("pledge_start:euro-patron", "2026-10-01T12:00:00.000Z"),
        currency: "EUR",
      });
      await approve((await application()).id, "primary");
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: true,
        founderRecorded: false,
        blocked: ["below_minimum"],
      });
    });

    it("confirms an earlier payment in another currency by its tier's price, then records the founder", async () => {
      const cad = {
        ...charge("pledge_start:cad-patron", "2026-10-01T12:00:00.000Z"),
        amountCents: 750,
        currency: "CAD",
      };
      // Imported before tier prices were read: the payment is verified, but not confirmed as US$5 or more.
      const record = await importPatron("cad-patron", patron, cad);
      expect(record).toMatchObject({
        founderEligiblePayment: null,
        founderBlockedReason: "below_minimum",
        // No tier price was read, so Gramps still waits for one.
        founderTierBelowMinimum: false,
        automaticBlockedReason: "below_minimum",
        latestPayment: { amountCents: 750, currency: "CAD", minimumConfirmed: false },
      });
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        founderRecorded: false,
        blocked: ["no_application", "below_minimum"],
      });
      // The next sync learns that the tier costs US$5. The member is otherwise unchanged.
      const priced = {
        ...apiMember("cad-patron", [{ ...cad, tierId: "111", tierAmountCents: 500 }], true),
        discordId: patron,
      };
      expect(await supporters.importApiMember(campaign, priced, new Date())).toMatchObject({
        created: false,
        updated: false,
        payments: 0,
        tierConfirmed: 1,
        tierConfirmedNew: 1,
        tierUnconfirmed: 0,
      });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        version: record.version + 1,
        founderBlockedReason: null,
        automaticBlockedReason: null,
        founderEligiblePayment: {
          source: "patreon_api",
          amountCents: 750,
          currency: "CAD",
          minimumConfirmed: true,
          firstSuccessfulPaymentVerified: true,
        },
      });
      // A later sync without the tier, or with a cheaper one, never takes the confirmation back.
      for (const event of [cad, { ...cad, tierId: "111", tierAmountCents: 100 }])
        expect(
          await supporters.importApiMember(
            campaign,
            { ...apiMember("cad-patron", [event], true), discordId: patron },
            new Date(),
          ),
        ).toMatchObject({ updated: false, tierConfirmed: 1, tierConfirmedNew: 0, tierUnconfirmed: 0 });
      expect(
        (await client.query("SELECT minimum_confirmed FROM supporter_payments WHERE member_id = $1", [record.id])).rows,
      ).toEqual([{ minimum_confirmed: true }]);
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.version).toBe(record.version + 1);
      expect(
        (
          await client.query(
            "SELECT actor_id, details FROM supporter_actions WHERE member_id = $1 AND kind = 'patreon-payment-minimum'",
            [record.id],
          )
        ).rows,
      ).toEqual([
        {
          actor_id: "system:patreon-sync",
          details: expect.objectContaining({
            reference: "pledge_start:cad-patron",
            amountCents: 750,
            currency: "CAD",
            tierId: "111",
            tierAmountCents: 500,
            minimumConfirmed: 1,
          }),
        },
      ]);
      expect(await match.autoMatch(record.id, options())).toMatchObject({
        steamFilled: false,
        founderRecorded: true,
        blocked: ["no_application"],
      });
      expect((await roles.desired([patron])).founder).toEqual(new Map([[patron, record.id]]));
    });

    it("waits out the hold after the first payment", async () => {
      const record = await importPatron();
      await approve((await application()).id, "primary");
      expect(
        await match.autoMatch(
          record.id,
          options({ policy: { ...policy, automaticHoldHours: 72 }, now: new Date("2026-10-02T12:00:00.000Z") }),
        ),
      ).toMatchObject({ steamFilled: true, founderRecorded: false, blocked: ["payment_too_recent"] });
    });
  });

  describe("Link Patreon sign-ins", () => {
    const patron = "456789012345678911";
    const otherAccount = "456789012345678912";
    const automaticPolicy: FounderPolicy = { ...policy, automaticHoldHours: 0 };
    const signIn = (patreonMemberId: string, discordId = patron, now = new Date()) => ({
      campaignId: campaign,
      patreonMemberId,
      discordId,
      now,
    });
    async function importPatron(patreonMemberId: string, discordId: string | null = null) {
      await supporters.importApiMember(
        campaign,
        {
          ...apiMember(patreonMemberId, [charge(`pledge_start:${patreonMemberId}`, "2026-10-01T12:00:00.000Z")], true),
          discordId,
        },
        new Date(),
      );
      return (await supporters.list(campaign, automaticPolicy, undefined, patreonMemberId))[0];
    }
    const actions = async (memberId: string) =>
      (
        await client.query<{ actor_id: string; kind: string; details: Record<string, unknown> }>(
          "SELECT actor_id, kind, details FROM supporter_actions WHERE member_id = $1 ORDER BY created_at, kind",
          [memberId],
        )
      ).rows;
    const refusals = async () =>
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM supporter_actions WHERE kind = 'patron-link-conflict'",
        )
      ).rows[0].count;

    it("fills the empty link as the patron's own, bumps the version once and audits it, then writes nothing again", async () => {
      const record = await importPatron("self-linked");
      expect(record).toMatchObject({ discordId: null, identityState: "unlinked" });
      expect(await patronLink.linked(campaign, patron)).toBe(false);
      expect(await patronLink.link(signIn("self-linked"))).toEqual({ outcome: "linked", memberId: record.id });
      const view = (await supporters.get(record.id, campaign, automaticPolicy))!;
      expect(view).toMatchObject({
        discordId: patron,
        discordSource: "patron_signin",
        identityState: "partial",
        version: record.version + 1,
        patronLinkConflict: null,
      });
      expect(await actions(record.id)).toEqual([
        {
          actor_id: PATRON_LINK_ACTOR.id,
          kind: "patron-discord-link",
          details: {
            discordId: patron,
            previousDiscordId: null,
            patreonMemberId: "self-linked",
            patreonDiscordId: null,
            memberCreated: 0,
          },
        },
      ]);
      expect(await patronLink.linked(campaign, patron)).toBe(true);
      // Signing in again for the same link changes nothing.
      expect(await patronLink.link(signIn("self-linked"))).toEqual({ outcome: "already", memberId: record.id });
      expect(await actions(record.id)).toHaveLength(1);
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.version).toBe(view.version);
      // The next import keeps the patron's link, even when Patreon reports no Discord account.
      await importPatron("self-linked");
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        discordId: patron,
        discordSource: "patron_signin",
      });
    });

    it("creates the import's minimal record for a membership the import has not seen, pending until a payment", async () => {
      const result = await patronLink.link(signIn("not-imported-yet"));
      expect(result).toMatchObject({ outcome: "pending" });
      expect(
        (
          await client.query(
            `SELECT provider, campaign_id, patreon_member_id, display_name, review_state, discord_id, discord_source,
              version FROM supporter_members WHERE id = $1`,
            [result.memberId],
          )
        ).rows,
      ).toEqual([
        {
          provider: "patreon",
          campaign_id: campaign,
          patreon_member_id: "not-imported-yet",
          display_name: null,
          review_state: "pending",
          discord_id: patron,
          discord_source: "patron_signin",
          version: 2,
        },
      ]);
      expect((await actions(result.memberId)).map(({ details }) => details.memberCreated)).toEqual([1]);
      // The import then fills in the membership and its payment around the patron's link.
      expect(await importPatron("not-imported-yet")).toMatchObject({
        id: result.memberId,
        discordId: patron,
        discordSource: "patron_signin",
        latestPayment: { source: "patreon_api" },
      });
    });

    it("never replaces a link, and shows the refusal to staff once a day until a review settles it", async () => {
      const record = await importPatron("linked-elsewhere", patron);
      // Patreon linked the account three days ago, before any sign-in.
      await client.query(
        "UPDATE supporter_actions SET created_at = created_at - interval '3 days' WHERE member_id = $1",
        [record.id],
      );
      const day = 24 * 3_600_000;
      const firstAt = new Date(Date.now() - 2 * day);
      expect(await patronLink.link(signIn("linked-elsewhere", otherAccount, firstAt))).toEqual({
        outcome: "conflict",
        conflict: "membership_linked",
        memberId: record.id,
      });
      let view = (await supporters.get(record.id, campaign, automaticPolicy))!;
      expect(view).toMatchObject({
        discordId: patron,
        discordSource: "patreon",
        version: record.version,
        patronLinkConflict: { discordId: otherAccount, conflict: "membership_linked", linkedDiscordId: patron },
      });
      expect((await actions(record.id)).at(-1)).toEqual({
        actor_id: PATRON_LINK_ACTOR.id,
        kind: "patron-link-conflict",
        details: {
          discordId: otherAccount,
          conflict: "membership_linked",
          linkedDiscordId: patron,
          patreonMemberId: "linked-elsewhere",
        },
      });
      // The same refusal within a day is recorded once. A day later it is recorded again.
      await patronLink.link(signIn("linked-elsewhere", otherAccount, new Date(firstAt.getTime() + 3_600_000)));
      expect(await refusals()).toBe(1);
      await patronLink.link(signIn("linked-elsewhere", otherAccount, new Date(firstAt.getTime() + day + 3_600_000)));
      expect(await refusals()).toBe(2);
      // A staff review settles every earlier refusal.
      await supporters.mutate(record.id, { ...review(view), kind: "review" }, staff, campaign, policy);
      view = (await supporters.get(record.id, campaign, automaticPolicy))!;
      expect(view.patronLinkConflict).toBeNull();
      // A sign-in after the review is a new refusal, even within the day.
      await patronLink.link(signIn("linked-elsewhere", otherAccount));
      expect(await refusals()).toBe(3);
      expect((await supporters.get(record.id, campaign, automaticPolicy))?.patronLinkConflict).toMatchObject({
        discordId: otherAccount,
      });
    });

    it("never takes an account another Patreon record links, a PayPal record does not block, and a link clears the refusal", async () => {
      await importPatron("holder", patron);
      const record = await importPatron("taker");
      expect(await patronLink.link(signIn("taker", patron, new Date(Date.now() - 60_000)))).toEqual({
        outcome: "conflict",
        conflict: "discord_linked",
        memberId: record.id,
      });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        discordId: null,
        version: record.version,
        patronLinkConflict: { discordId: patron, conflict: "discord_linked", linkedDiscordId: null },
      });
      await supporters.recordPaypal(paypalInput({ discordId: otherAccount }), staff, null, policy);
      expect(await patronLink.link(signIn("taker", otherAccount))).toEqual({ outcome: "linked", memberId: record.id });
      expect(await supporters.get(record.id, campaign, automaticPolicy)).toMatchObject({
        discordId: otherAccount,
        discordSource: "patron_signin",
        patronLinkConflict: null,
      });
    });

    it("gives a founder record no Discord account another founder holds", async () => {
      await supporters.recordPaypal(paypalInput({ discordId: otherAccount, awardFounder: true }), staff, null, policy);
      let record = await register("steam-only-founder");
      record = (
        await supporters.mutate(
          record.id,
          { ...review(record), kind: "link", steamId: "76561198000000041" },
          staff,
          campaign,
          policy,
        )
      ).supporter!;
      record = await payment(record);
      record = (
        await supporters.mutate(
          record.id,
          { ...review(record), kind: "founder", paymentId: record.founderEligiblePayment!.id },
          staff,
          campaign,
          policy,
        )
      ).supporter!;
      expect(record.founder).not.toBeNull();
      expect(await patronLink.link(signIn("steam-only-founder", otherAccount))).toEqual({
        outcome: "conflict",
        conflict: "founder_tie",
        memberId: record.id,
      });
      expect(await supporters.get(record.id, campaign, policy)).toMatchObject({ discordId: null });
      // An account no founder holds is fine.
      expect(await patronLink.link(signIn("steam-only-founder", patron))).toMatchObject({ memberId: record.id });
      expect(await supporters.get(record.id, campaign, policy)).toMatchObject({
        discordId: patron,
        discordSource: "patron_signin",
      });
    });

    it("links one of two Discord accounts that sign in for the same membership at once", async () => {
      const record = await importPatron("raced-membership");
      // One clock for both: a refusal stays shown until a link made after it.
      const at = new Date();
      const results = await overlap(
        "supporter_members",
        ({ patronLink }) => patronLink.link(signIn("raced-membership", patron, at)),
        ({ patronLink }) => patronLink.link(signIn("raced-membership", otherAccount, at)),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const outcomes = results.map((result) => (result as PromiseFulfilledResult<PatronLinkResult>).value);
      expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["conflict", "linked"]);
      expect(outcomes.find(({ outcome }) => outcome === "conflict")).toMatchObject({ conflict: "membership_linked" });
      const view = (await supporters.get(record.id, campaign, automaticPolicy))!;
      const loser = view.discordId === patron ? otherAccount : patron;
      expect(view).toMatchObject({ discordSource: "patron_signin", version: record.version + 1 });
      expect(view.patronLinkConflict).toEqual({
        discordId: loser,
        conflict: "membership_linked",
        linkedDiscordId: view.discordId,
      });
      expect((await actions(record.id)).map(({ kind }) => kind).sort()).toEqual([
        "patron-discord-link",
        "patron-link-conflict",
      ]);
    });

    it("links one of two memberships that sign in with the same Discord account at once", async () => {
      const records = [await importPatron("raced-one"), await importPatron("raced-two")];
      const results = await overlap(
        "supporter_members",
        ({ patronLink }) => patronLink.link(signIn("raced-one")),
        ({ patronLink }) => patronLink.link(signIn("raced-two")),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const outcomes = results.map((result) => (result as PromiseFulfilledResult<PatronLinkResult>).value);
      expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["conflict", "linked"]);
      const lost = outcomes.find(({ outcome }) => outcome === "conflict")!;
      expect(lost).toMatchObject({ conflict: "discord_linked" });
      const won = outcomes.find(({ outcome }) => outcome === "linked")!;
      expect(await supporters.get(won.memberId, campaign, automaticPolicy)).toMatchObject({
        discordId: patron,
        discordSource: "patron_signin",
      });
      // The losing record is unchanged apart from the refusal staff see.
      expect(await supporters.get(lost.memberId, campaign, automaticPolicy)).toMatchObject({
        discordId: null,
        version: records.find(({ id }) => id === lost.memberId)!.version,
        patronLinkConflict: { discordId: patron, conflict: "discord_linked", linkedDiscordId: null },
      });
      expect((await actions(lost.memberId)).map(({ kind }) => kind)).toEqual(["patron-link-conflict"]);
    });

    it("records an automatic founder on a new patron link once the first payment has passed its refund wait, with its own reason", async () => {
      const record = await importPatron("own-link");
      const linkedAt = new Date("2026-10-08T12:00:00.000Z");
      expect(await patronLink.link(signIn("own-link", patron, linkedAt))).toEqual({
        outcome: "linked",
        memberId: record.id,
      });
      const held = { ...policy, automaticHoldHours: 72 };
      const options = (now: string): AutoMatchOptions => ({
        campaignId: campaign,
        policy: held,
        fillSteam: true,
        recordFounder: true,
        now: new Date(now),
      });
      // The first payment, from October 1 at 12:00 UTC, waits out Patreon's refund window whoever linked the account.
      expect(await match.autoMatch(record.id, options("2026-10-04T11:59:59.999Z"))).toMatchObject({
        founderRecorded: false,
        blocked: expect.arrayContaining(["payment_too_recent"]),
      });
      expect(await supporters.get(record.id, campaign, held)).toMatchObject({ founder: null });
      // The link itself waits for nothing: a moment after it, the founder is recorded.
      expect(await match.autoMatch(record.id, options("2026-10-08T12:00:00.001Z"))).toMatchObject({
        founderRecorded: true,
      });
      expect(await supporters.get(record.id, campaign, held)).toMatchObject({ founder: { automatic: true } });
      expect(
        (await client.query("SELECT reason FROM supporter_founders WHERE member_id = $1", [record.id])).rows,
      ).toEqual([{ reason: PATRON_LINK_FOUNDER_REASON }]);
      expect((await actions(record.id)).map(({ actor_id, kind }) => ({ actor_id, kind }))).toEqual([
        { actor_id: PATRON_LINK_ACTOR.id, kind: "patron-discord-link" },
        { actor_id: "system:supporter-match", kind: "founder" },
      ]);
      expect(
        (
          await client.query("SELECT reason FROM supporter_actions WHERE member_id = $1 AND kind = 'founder'", [
            record.id,
          ])
        ).rows,
      ).toEqual([{ reason: PATRON_LINK_FOUNDER_REASON }]);
    });
  });

  it("reads who should hold each role and keeps an ordered role ledger", async () => {
    const member = (await applications.create(uncApplication("primary")))!;
    await approve(member.id, "primary");
    const friend = (await applications.create({
      ...applicationInput("456789012345678901", "76561198000000012"),
      relationship: "friend_regular" as const,
    }))!;
    await approve(friend.id, "primary");
    const founder = await supporters.recordPaypal(
      {
        id: randomUUID(),
        displayName: "Fictional founder",
        discordId: "567890123456789012",
        paidAt: new Date("2026-10-01T16:00:00.000Z"),
        amountCents: 500,
        currency: "USD",
        transactionId: "8AB12345CD678901E",
        completedPaymentVerified: true,
        firstSuccessfulPaymentVerified: true,
        minimumConfirmed: false,
        awardFounder: true,
        reason: "Checked a fictional completed PayPal payment",
      },
      staff,
      null,
      policy,
    );
    await supporters.recordPaypal(
      {
        id: randomUUID(),
        displayName: "Fictional unlinked founder",
        steamId: "76561198000000013",
        paidAt: new Date("2026-10-02T16:00:00.000Z"),
        amountCents: 500,
        currency: "USD",
        transactionId: "9ZY98765XW432101V",
        completedPaymentVerified: true,
        firstSuccessfulPaymentVerified: true,
        minimumConfirmed: false,
        awardFounder: true,
        reason: "Checked a fictional completed PayPal payment",
      },
      staff,
      null,
      policy,
    );
    const desired = await roles.desired();
    expect(desired.member).toEqual(new Map([["345678901234567890", member.id]]));
    expect(desired.founder).toEqual(new Map([["567890123456789012", founder.supporter.id]]));
    expect((await roles.desired(["567890123456789012"])).member.size).toBe(0);
    expect(await roles.foundersWithoutDiscord()).toMatchObject([
      { displayName: "Fictional unlinked founder", provider: "paypal" },
    ]);
    expect(await roles.summary()).toEqual({ memberEligible: 1, founders: 2, foundersWithoutDiscord: 1 });
    const base = {
      trigger: "event" as const,
      requestedBy: null,
      guildId: "678901234567890123",
      discordUserId: "345678901234567890",
      roleKind: "member" as const,
      roleId: "789012345678901234",
      basisType: "application" as const,
      basisId: member.id,
    };
    const last = (roleKind: "member" | "founder" = "member", roleId = base.roleId) =>
      roles.lastEffective(base.guildId, base.discordUserId, roleKind, roleId);
    const added = await roles.begin({ ...base, operation: "add" });
    expect(await last()).toMatchObject({ id: added, state: "started" });
    // History recorded for another role ID (a recreated role or a corrected setting) does not count.
    expect(await last("member", "789012345678901299")).toBeNull();
    await roles.finish(added, "unknown", false, "Lost response");
    // Confirming it as the wrong operation changes nothing.
    await roles.confirm(added, "remove");
    expect(await last()).toMatchObject({ id: added, state: "unknown" });
    await roles.confirm(added, "add");
    expect(await last()).toMatchObject({ id: added, state: "applied", changed: true });
    const failed = await roles.begin({ ...base, operation: "remove" });
    await roles.finish(failed, "failed", false, "Refused");
    // A failed attempt never replaces the latest effective change.
    expect((await last())?.id).toBe(added);
    await roles.note({ ...base, roleKind: "founder" });
    expect(await last("founder")).toMatchObject({
      operation: "note",
      changed: false,
      state: "applied",
    });
    expect((await roles.recent(25)).map((row) => row.actorId)).toEqual([
      "system:discord-roles",
      "system:discord-roles",
      "system:discord-roles",
    ]);
  });

  it("reads who supports right now for the Supporter role and which Supporter roles Gramps still holds", async () => {
    const donor = "567890123456789013";
    const patron = "567890123456789014";
    const paypal = await supporters.recordPaypal(
      {
        id: randomUUID(),
        displayName: "Fictional PayPal supporter",
        discordId: donor,
        paidAt: new Date("2026-11-01T12:00:00.000Z"),
        amountCents: 500,
        currency: "USD",
        transactionId: "7AB12345CD678901E",
        completedPaymentVerified: true,
        firstSuccessfulPaymentVerified: true,
        minimumConfirmed: false,
        awardFounder: false,
        reason: "Checked a fictional completed PayPal payment",
      },
      staff,
      null,
      policy,
    );
    const imported = await supporters.importApiMember(
      campaign,
      {
        ...apiMember("supporter-sync", [charge("pledge_start:9001", "2026-11-02T12:00:00.000Z")], true),
        discordId: patron,
      },
      new Date("2026-11-02T13:00:00.000Z"),
    );
    expect(imported).toMatchObject({ discordLinked: true, discordId: patron });
    const within = new Date("2026-11-20T00:00:00.000Z");
    expect(await roles.supporterDesired(undefined, campaign, within)).toEqual(
      new Map([
        [donor, paypal.supporter.id],
        [patron, imported.memberId],
      ]),
    );
    expect(await roles.supporterDesired([patron], campaign, within)).toEqual(new Map([[patron, imported.memberId]]));
    // Patreon records count only for the configured campaign; with Patreon off only PayPal records count.
    for (const other of [null, "999999"])
      expect(await roles.supporterDesired(undefined, other, within)).toEqual(new Map([[donor, paypal.supporter.id]]));
    // 31 days after the PayPal payment it no longer counts; the active patron still does.
    expect(await roles.supporterDesired(undefined, campaign, new Date("2026-12-02T12:00:00.000Z"))).toEqual(
      new Map([[patron, imported.memberId]]),
    );
    const base = {
      trigger: "event" as const,
      requestedBy: null,
      guildId: "678901234567890123",
      discordUserId: donor,
      roleKind: "supporter" as const,
      roleId: "789012345678901235",
      basisType: "supporter" as const,
      basisId: paypal.supporter.id,
    };
    const held = (roleId = base.roleId) => roles.heldBasis(base.guildId, "supporter", roleId);
    expect(await held()).toEqual(new Map());
    await roles.note({ ...base, discordUserId: patron, basisId: imported.memberId });
    const added = await roles.begin({ ...base, operation: "add" });
    await roles.finish(added, "applied", true, "Role added.");
    // A noted role is never Gramps' own; history for another role ID does not count.
    expect(await held()).toEqual(new Map([[donor, paypal.supporter.id]]));
    expect(await held("789012345678901299")).toEqual(new Map());
    const removal = await roles.begin({ ...base, operation: "remove" });
    await roles.finish(removal, "unknown", false, "Lost response");
    expect(await held()).toEqual(new Map([[donor, paypal.supporter.id]]));
    await roles.confirm(removal, "remove");
    expect(await held()).toEqual(new Map());
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
