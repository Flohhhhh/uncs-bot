import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../database/database.types";
import * as schema from "../database/schema";
import { ApplicationsStore } from "../applications/applications.store";
import { SupportersStore } from "../supporters/supporters.store";
import type {
  FounderPolicy,
  ManualMemberInput,
  SupporterMutation,
  SupporterView,
} from "../supporters/supporters.types";
import { AdminStore } from "./admin.store";
import type { Staff } from "./admin.types";

// Execute the checked-in SQL and production stores against disposable PostgreSQL
// in memory. Never load application configuration, open a socket or use DATABASE_URL.
// PGlite has one connection: these checks do not certify multi-connection locking.
describe("launch storage with PostgreSQL semantics", () => {
  let client: PGlite;
  let supporters: SupportersStore;
  let applications: ApplicationsStore;
  let admin: AdminStore;
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
    client = new PGlite("memory://");
    const directory = join(__dirname, "../../drizzle");
    for (const file of (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      await client.exec(await readFile(join(directory, file), "utf8"));
    }
    const db = drizzle({ client, schema }) as unknown as Database;
    supporters = new SupportersStore(db);
    applications = new ApplicationsStore(db);
    admin = new AdminStore(db);
  }, 30_000);
  beforeEach(async () => {
    await client.exec(
      "TRUNCATE supporter_actions, supporter_founders, supporter_payments, supporter_observations, supporter_members, whitelist_application_reviews, whitelist_applications, admin_actions, admin_sessions CASCADE",
    );
  });
  afterAll(async () => {
    await client?.close();
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
    await client.exec(`INSERT INTO supporter_members (id, campaign_id, patreon_member_id, display_name, observed_at)
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
    admin = new AdminStore(drizzle({ client, schema }) as unknown as Database);
    expect(await admin.begin(staff, action, "test-fingerprint")).toMatchObject({
      created: false,
      record: { state: "unknown" },
    });
    expect(await admin.receipt(id)).toMatchObject({ id, state: "unknown" });
  });
});
