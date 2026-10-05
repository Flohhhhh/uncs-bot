import { createHash, randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { supporterActions, supporterMembers, supporterPayments } from "../database/supporters.schema";
import { SupportersStore } from "./supporters.store";
import type {
  FounderPolicy,
  ManualMemberInput,
  PatreonObservation,
  PaypalInput,
  SupporterMutation,
} from "./supporters.types";
import type { Staff } from "../admin/admin.types";

const id = randomUUID();
const staff: Staff = { id: "123456789012345678", name: "Admin", role: "admin", csrf: "csrf" };
const policy: FounderPolicy = {
  configured: true,
  amountCents: 500,
  currency: "USD",
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: "2026-09-16T00:00:00Z",
  source: "SUPPORTER_FOUNDER",
};
const observation: PatreonObservation = {
  hash: "a".repeat(64),
  campaignId: "123",
  patreonMemberId: "member-123",
  displayName: "Supporter",
  patronStatus: "active_patron",
  lastChargeStatus: "Paid",
  lastChargeAt: new Date("2026-09-02T00:00:00Z"),
  receivedAt: new Date("2026-09-30T00:00:00Z"),
  trigger: "members:update",
};
function row(table: PgTable, value: Record<string, unknown>) {
  return Object.keys(getTableColumns(table)).map((key) =>
    value[key] instanceof Date ? (value[key] as Date).toISOString() : (value[key] ?? null),
  );
}
function fixture() {
  const member: Record<string, unknown> = {
    id,
    provider: "patreon",
    campaignId: "123",
    patreonMemberId: "member-123",
    displayName: "Supporter",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: new Date("2026-09-10T00:00:00Z"),
    observedAt: new Date(),
    reviewState: "verified",
    discordId: staff.id,
    discordSource: "patreon",
    patreonDiscordId: staff.id,
    steamId: "76561198000000001",
    steamSource: "staff",
    steamApplicationId: null,
    version: 3,
  };
  const payment: Record<string, unknown> & { id: string } = {
    id: randomUUID(),
    memberId: id,
    campaignId: "123",
    paidAt: new Date("2026-09-01T00:00:00Z"),
    amountCents: 500,
    currency: "USD",
    source: "manual_receipt",
    reference: "receipt-123",
    verificationState: "verified",
    firstSuccessfulPaymentVerified: true,
    recordedAt: new Date(),
    verifiedBy: staff.id,
  };
  const state: {
    duplicate: boolean;
    manualDuplicate: boolean;
    earlier: boolean;
    otherFounder: boolean;
    /** A founder with no SteamID linked whose Discord account applied with the SteamID being checked. */
    appliedFounder: boolean;
    founder: boolean;
    /** No payment with the requested ID is on this record. */
    missingPayment: boolean;
    action: Record<string, unknown> | null;
    /** The record's current Discord account applied with the SteamID being linked. */
    previousApplication: boolean;
  } = {
    duplicate: false,
    manualDuplicate: false,
    earlier: false,
    otherFounder: false,
    appliedFounder: false,
    founder: false,
    missingPayment: false,
    action: null,
    previousApplication: false,
  };
  const query = jest.fn(async (config: { text: string }, _params: unknown[]) => {
    if (config.text.startsWith("SELECT 1 FROM whitelist_applications"))
      return { rows: state.previousApplication ? [{ "?column?": 1 }] : [] };
    if (config.text.startsWith('insert into "supporter_members"') && config.text.includes("returning"))
      return { rows: state.manualDuplicate ? [] : [[id]] };
    if (config.text.includes('from "supporter_members"') && config.text.endsWith("for update"))
      return { rows: [row(supporterMembers, member)] };
    if (config.text.includes('from "supporter_actions"'))
      return { rows: state.action ? [row(supporterActions, state.action)] : [] };
    if (config.text.includes('from "supporter_founders" inner join'))
      return { rows: state.otherFounder ? [[randomUUID()]] : [] };
    if (config.text.startsWith("SELECT EXISTS (SELECT 1 FROM supporter_founders applied_founder"))
      return { rows: [{ applied: state.appliedFounder }] };
    if (config.text.startsWith('select "member_id" from "supporter_founders" where'))
      return { rows: state.founder ? [[id]] : [] };
    if (config.text.startsWith('select "id" from "supporter_payments"'))
      return { rows: state.earlier ? [[randomUUID()]] : [] };
    if (config.text.includes('from "supporter_payments"'))
      return { rows: state.missingPayment ? [] : [row(supporterPayments, payment)] };
    if (config.text.startsWith('insert into "supporter_observations"'))
      return { rows: state.duplicate ? [] : [[observation.hash]] };
    return { rows: [] };
  });
  return {
    store: new SupportersStore(drizzle({ query } as unknown as Client) as Database),
    query,
    member,
    payment,
    state,
  };
}
describe("supporter persistence and founder eligibility", () => {
  it("searches the campaign's full ledger before the result cap using literal bound parameters", async () => {
    const { store, query } = fixture();
    const search = "old%_member';--";
    await store.list("123", policy, undefined, search);
    const [statement, values] = query.mock.calls[0];
    expect(statement.text).not.toContain(search);
    expect(values).toContain(search);
    expect(values).toContain("123");
    expect(statement.text).toContain("WHERE (m.provider = 'paypal' OR (m.provider = 'patreon' AND m.campaign_id =");
    expect(statement.text).toContain("strpos(lower(coalesce(m.display_name, ''))");
    expect(statement.text).toContain("strpos(lower(coalesce(m.patreon_member_id, ''))");
    expect(statement.text).toContain("paypal_payment.source = 'paypal' AND strpos(lower(paypal_payment.reference)");
    expect(statement.text).toContain("strpos(coalesce(m.discord_id, '')");
    expect(statement.text).toContain("strpos(coalesce(m.steam_id, '')");
    expect(statement.text.indexOf("strpos(")).toBeLessThan(statement.text.indexOf("LIMIT 100"));
  });
  it("lists only the PayPal ledger when Patreon is not configured, and filters by provider", async () => {
    const { store, query } = fixture();
    await store.list(null, policy, undefined, "", "paypal");
    const [statement, values] = query.mock.calls[0];
    expect(values).toContain(null);
    expect(values).toContain("paypal");
    expect(statement.text).toContain("AND m.provider =");
    // Every qualifying source is a bound parameter in the founder check and the latest-payment ordering.
    expect(values).toEqual(expect.arrayContaining(["manual_receipt", "patreon_api", "paypal"]));
    expect(statement.text).toContain("'confirmKey', coalesce(m.patreon_member_id, m.id::text)");
  });
  const manualInput = (): ManualMemberInput => ({
    id: randomUUID(),
    patreonMemberId: "member-123",
    displayName: "Member checked by staff",
    campaignMembershipVerified: true,
    reason: "Checked this membership on the UNC creator page",
  });
  it("atomically records a manual member and durable audit without inventing signed or payment evidence", async () => {
    const { store, query } = fixture();
    const input = manualInput();
    await expect(store.register(input, staff, "123", policy)).resolves.toMatchObject({ ok: true, replayed: false });
    const [insert, values] = query.mock.calls.find(([config]) =>
      config.text.startsWith('insert into "supporter_members"'),
    )!;
    expect(insert.text).toContain('on conflict ("campaign_id","patreon_member_id") do nothing');
    expect(values).toContain("unverified");
    expect(values).not.toContain("Paid");
    expect(values).not.toContain("active_patron");
    const [, audit] = query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_actions"'))!;
    expect(audit).toEqual(expect.arrayContaining([input.id, staff.id, "manual-member", input.reason]));
    expect(audit).toContain(JSON.stringify({ patreonMemberId: input.patreonMemberId, campaignMembershipVerified: 1 }));
    expect(
      query.mock.calls.some(([config]) =>
        /insert into "supporter_(payments|founders|observations)"|^update /.test(config.text),
      ),
    ).toBe(false);
    expect(query.mock.calls[0][0].text).toBe("begin");
    expect(query.mock.calls.some(([config]) => config.text === "commit")).toBe(true);
  });
  it("does not overwrite a provider member already created by a webhook or another staff request", async () => {
    const { store, query, state } = fixture();
    state.manualDuplicate = true;
    await expect(store.register(manualInput(), staff, "123", policy)).rejects.toMatchObject({ status: 409 });
    expect(
      query.mock.calls.some(
        ([config]) => config.text.startsWith("update") || config.text.startsWith('insert into "supporter_actions"'),
      ),
    ).toBe(false);
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
  });
  it("replays manual registration only for its original actor, campaign and exact payload", async () => {
    const { store, state } = fixture();
    const input = manualInput();
    state.manualDuplicate = true;
    state.action = {
      id: input.id,
      memberId: id,
      actorId: staff.id,
      actorName: staff.name,
      kind: "manual-member",
      reason: input.reason,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ kind: "manual-member", campaignId: "123", ...input }))
        .digest("hex"),
      details: {},
      createdAt: new Date(),
    };
    await expect(store.register(input, staff, "123", policy)).resolves.toMatchObject({ replayed: true });
    await expect(
      store.register({ ...input, reason: "Different evidence" }, staff, "123", policy),
    ).rejects.toMatchObject({ status: 409 });
    await expect(store.register(input, { ...staff, id: "999999999999999999" }, "123", policy)).rejects.toMatchObject({
      status: 409,
    });
    await expect(store.register(input, staff, "456", policy)).rejects.toMatchObject({ status: 409 });
  });
  it("deduplicates before changing member state and commits signed receipt processing atomically", async () => {
    const { store, query, state } = fixture();
    state.duplicate = true;
    await expect(store.ingest(observation)).resolves.toEqual({ duplicate: true });
    expect(query.mock.calls.some(([config]) => config.text.startsWith("update"))).toBe(false);
    expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_payments"'))).toBe(false);
    expect(query.mock.calls[0][0].text).toBe("begin");
    expect(query.mock.calls.at(-1)![0].text).toBe("commit");
    expect(
      query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_observations"'))![0].text,
    ).toContain("on conflict do nothing");
  });
  it("reports the record's Discord account for a new observation so its roles can be checked", async () => {
    const { store } = fixture();
    await expect(store.ingest(observation)).resolves.toEqual({ duplicate: false, memberId: id, discordId: staff.id });
  });
  it("keeps an older charge from replacing newer state", async () => {
    const { store, query } = fixture();
    await store.ingest(observation);
    const [update, params] = query.mock.calls.find(([config]) => config.text.startsWith("update"))!;
    expect(update.text).not.toContain('"last_charge_at" =');
    expect(update.text).not.toContain('"patron_status" =');
    expect(params).toContain("pending");
  });
  it("preserves the charge high-water mark through an undated cancellation without touching permanent benefits", async () => {
    const { store, query } = fixture();
    await store.ingest({
      ...observation,
      lastChargeAt: null,
      lastChargeStatus: null,
      patronStatus: "former_patron",
      trigger: "members:delete",
    });
    const [update, params] = query.mock.calls.find(([config]) => config.text.startsWith("update"))!;
    expect(update.text).not.toContain('"last_charge_at" =');
    expect(update.text).not.toContain('"last_charge_status" =');
    expect(params).toContain("former_patron");
    expect(query.mock.calls.map(([config]) => config.text).join("\n")).not.toMatch(
      /supporter_founders|whitelist|seed|legacy/,
    );
    expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_payments"'))).toBe(false);
  });
  it("records a dated charge as payment evidence only when Patreon reports it paid", async () => {
    const paid = fixture();
    await paid.store.ingest(observation);
    expect(paid.query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_payments"'))).toBe(
      true,
    );
    // A declined first charge would otherwise count as an earlier payment against the receipt staff record later.
    for (const lastChargeStatus of ["Declined", "Pending", "Refunded"]) {
      const { store, query } = fixture();
      await store.ingest({ ...observation, lastChargeStatus });
      expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_payments"'))).toBe(
        false,
      );
    }
  });
  it.each([
    ["low", "below_minimum"],
    ["non-usd-unconfirmed", "below_minimum"],
    ["end", "outside_window"],
    ["before", "outside_window"],
    ["signed", "source_not_qualifying"],
    ["unverified", "not_verified"],
    ["not-first", "not_first_payment"],
    ["unlinked", "no_identity"],
    ["invalid-steam", "no_identity"],
    ["earlier", "earlier_payment"],
    ["other-founder", "already_founder"],
    ["applied-founder", "steam_applied_by_founder"],
    ["other-and-applied-founder", "already_founder"],
  ])("rejects founder award for %s evidence (%s)", async (caseName, blockedReason) => {
    const { store, query, payment, member, state } = fixture();
    if (caseName === "low") payment.amountCents = 499;
    if (caseName === "non-usd-unconfirmed") Object.assign(payment, { currency: "CAD", amountCents: 900 });
    if (caseName === "end") payment.paidAt = new Date(policy.endsAt!);
    if (caseName === "before") payment.paidAt = new Date("2026-08-31T23:59:59Z");
    if (caseName === "signed") payment.source = "signed_status";
    if (caseName === "unverified") payment.verificationState = "unverified";
    if (caseName === "not-first") payment.firstSuccessfulPaymentVerified = false;
    // Either identity is enough now, so "unlinked" means neither is set.
    if (caseName === "unlinked") Object.assign(member, { discordId: null, steamId: null });
    if (caseName === "invalid-steam") member.steamId = "76561190000000001";
    if (caseName === "earlier") state.earlier = true;
    if (caseName.startsWith("other-")) state.otherFounder = true;
    if (caseName.endsWith("applied-founder")) state.appliedFounder = true;
    await expect(
      store.mutate(
        id,
        {
          kind: "founder",
          id: randomUUID(),
          version: 3,
          confirm: "member-123",
          reason: "Reviewed receipt",
          paymentId: payment.id,
        },
        staff,
        "123",
        policy,
      ),
    ).rejects.toMatchObject({ status: 409, response: { blockedReason } });
    expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_founders"'))).toBe(false);
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
  });
  it.each([
    ["Discord only", { steamId: null }, {}],
    ["SteamID only", { discordId: null }, {}],
    ["a staff-confirmed non-USD minimum", {}, { currency: "EUR", amountCents: 450, minimumConfirmed: true }],
    ["a Patreon API payment", {}, { source: "patreon_api" }],
    ["a PayPal payment", {}, { source: "paypal" }],
  ])("accepts a founder with %s", async (_label, memberChange, paymentChange) => {
    const { store, query, payment, member } = fixture();
    Object.assign(member, memberChange);
    Object.assign(payment, paymentChange);
    await expect(
      store.mutate(
        id,
        {
          kind: "founder",
          id: randomUUID(),
          version: 3,
          confirm: "member-123",
          reason: "Reviewed",
          paymentId: payment.id,
        },
        staff,
        "123",
        policy,
      ),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_founders"'))).toBe(true);
    // The award serializes on the identity before the cross-record founder check.
    const lock = query.mock.calls.findIndex(([config]) => config.text.includes("pg_advisory_xact_lock"));
    const check = query.mock.calls.findIndex(([config]) =>
      config.text.includes('from "supporter_founders" inner join'),
    );
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(check);
  });
  it("looks for a founder who applied with the SteamID only for a record that has one, after the plain comparison", async () => {
    const award = (paymentId: string): SupporterMutation => ({
      kind: "founder",
      id: randomUUID(),
      version: 3,
      confirm: "member-123",
      reason: "Reviewed receipt",
      paymentId,
    });
    // The list read that follows a save selects the same expression, so only the check's own statement counts.
    const applied = (query: jest.Mock) =>
      query.mock.calls.filter(([config]) => (config as { text: string }).text.startsWith("SELECT EXISTS (SELECT 1"));
    const withSteam = fixture();
    await withSteam.store.mutate(id, award(withSteam.payment.id), staff, "123", policy);
    const [[statement, params]] = applied(withSteam.query);
    expect(statement.text).toContain("JOIN whitelist_applications applied ON applied.discord_user_id");
    expect(statement.text).toContain(
      "WHERE applied_member.id <> $1 AND applied_member.steam_id IS NULL AND applied.steam_id = $2",
    );
    expect(statement.text).toContain("applied.status NOT IN ('declined', 'revoked')");
    expect(params).toEqual([id, "76561198000000001"]);
    const texts = withSteam.query.mock.calls.map(([config]) => config.text);
    const plain = texts.findIndex((text) => text.includes('from "supporter_founders" inner join'));
    const lock = texts.findIndex((text) => text.includes("pg_advisory_xact_lock"));
    const check = texts.findIndex((text) => text.startsWith("SELECT EXISTS (SELECT 1"));
    expect([lock < plain, plain < check]).toEqual([true, true]);
    // A record with only a Discord account has no SteamID to look for, and a founder found already ends the check.
    const discordOnly = fixture();
    Object.assign(discordOnly.member, { steamId: null, steamSource: null });
    await discordOnly.store.mutate(id, award(discordOnly.payment.id), staff, "123", policy);
    expect(applied(discordOnly.query)).toHaveLength(0);
    const found = fixture();
    found.state.otherFounder = true;
    await expect(found.store.mutate(id, award(found.payment.id), staff, "123", policy)).rejects.toMatchObject({
      status: 409,
    });
    expect(applied(found.query)).toHaveLength(0);
  });
  it("keeps Patreon records closed while Patreon is not configured and rejects receipts on PayPal records", async () => {
    const { store, member } = fixture();
    const review = { kind: "review" as const, id: randomUUID(), version: 3, confirm: "member-123", reason: "Review" };
    await expect(store.mutate(id, review, staff, null, policy)).rejects.toMatchObject({ status: 503 });
    await expect(store.mutate(id, review, staff, "456", policy)).rejects.toMatchObject({ status: 404 });
    Object.assign(member, { provider: "paypal", campaignId: null, patreonMemberId: null });
    // A PayPal record confirms with its own ID; the old Patreon member ID no longer matches.
    await expect(store.mutate(id, review, staff, null, policy)).rejects.toMatchObject({ status: 409 });
    await expect(store.mutate(id, { ...review, confirm: id }, staff, null, policy)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      store.mutate(
        id,
        {
          kind: "payment",
          id: randomUUID(),
          version: 3,
          confirm: id,
          reason: "Receipt",
          paidAt: new Date(),
          amountCents: 500,
          currency: "USD",
          reference: "receipt",
          completedPaymentVerified: true,
          firstSuccessfulPaymentVerified: true,
        },
        staff,
        null,
        policy,
      ),
    ).rejects.toMatchObject({ status: 409, message: "Use the PayPal payment record for PayPal supporters." });
  });
  const link = (change: Partial<Extract<SupporterMutation, { kind: "link" }>>): SupporterMutation => ({
    kind: "link",
    id: randomUUID(),
    version: 3,
    confirm: "member-123",
    reason: "Linked",
    ...change,
  });
  const memberUpdate = (query: jest.Mock) =>
    query.mock.calls.find(([config]) => config.text.startsWith('update "supporter_members" set "discord_id"'))!;
  it("marks only a changed identity as a staff link and keeps where an unchanged one came from", async () => {
    const { store, query, member } = fixture();
    // The dashboard used to resend both fields; the Discord ID Patreon filled in must stay a Patreon link.
    await store.mutate(id, link({ discordId: staff.id, steamId: "76561198000000002" }), staff, "123", policy);
    const [statement, params] = memberUpdate(query);
    expect(statement.text).toContain('"discord_source" = $2');
    expect(statement.text).toContain('"steam_source" = $4');
    expect(params.slice(0, 5)).toEqual([staff.id, "patreon", "76561198000000002", "staff", null]);
    const audit = query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_actions"'))!;
    expect(JSON.parse(audit[1].find((value: unknown) => String(value).startsWith("{")) as string)).toMatchObject({
      previousDiscordSource: "patreon",
      discordSource: "patreon",
      previousSteamSource: "staff",
      steamSource: "staff",
    });
    const changed = fixture();
    await changed.store.mutate(id, link({ discordId: "234567890123456789" }), staff, "123", policy);
    expect(memberUpdate(changed.query)[1].slice(0, 4)).toEqual([
      "234567890123456789",
      "staff",
      member.steamId,
      "staff",
    ]);
  });
  it("keeps a Discord account as a staff link when staff confirm the one the record has", async () => {
    const { store, query, member } = fixture();
    await store.mutate(id, link({ discordId: staff.id, discordConfirmed: true }), staff, "123", policy);
    // Same account, now staff-checked. The SteamID and where it came from are unchanged.
    expect(memberUpdate(query)[1].slice(0, 4)).toEqual([staff.id, "staff", member.steamId, "staff"]);
    const audit = query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_actions"'))!;
    expect(JSON.parse(audit[1].find((value: unknown) => String(value).startsWith("{")) as string)).toMatchObject({
      previousDiscordSource: "patreon",
      discordSource: "staff",
      discordConfirmed: 1,
    });
    // Without the confirmation, resending the account keeps where it came from.
    const resent = fixture();
    await resent.store.mutate(id, link({ discordId: staff.id }), staff, "123", policy);
    expect(memberUpdate(resent.query)[1].slice(0, 2)).toEqual([staff.id, "patreon"]);
  });
  it("refuses to move a SteamID copied from an application onto a new Discord account unless staff restate it", async () => {
    const { store, query, member } = fixture();
    const applicationId = randomUUID();
    Object.assign(member, { steamSource: "application", steamApplicationId: applicationId });
    await expect(
      store.mutate(id, link({ discordId: "234567890123456789" }), staff, "123", policy),
    ).rejects.toMatchObject({ status: 409, response: { blockedReason: "steam_from_application" } });
    // Resending the same SteamID is not a restatement.
    await expect(
      store.mutate(
        id,
        link({ discordId: "234567890123456789", steamId: member.steamId as string }),
        staff,
        "123",
        policy,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([config]) => config.text.startsWith("update"))).toBe(false);
    await store.mutate(id, link({ discordId: "234567890123456789", steamConfirmed: true }), staff, "123", policy);
    expect(memberUpdate(query)[1].slice(0, 5)).toEqual(["234567890123456789", "staff", member.steamId, "staff", null]);
    // A SteamID-only change, or keeping the same Discord account, needs no restatement.
    const steamOnly = fixture();
    Object.assign(steamOnly.member, { steamSource: "application", steamApplicationId: applicationId });
    await expect(
      steamOnly.store.mutate(id, link({ discordId: staff.id, steamId: "76561198000000002" }), staff, "123", policy),
    ).resolves.toMatchObject({ ok: true });
  });
  it("asks staff to confirm a SteamID the previous Discord account applied with before it follows a new one", async () => {
    const { store, query, state, member } = fixture();
    Object.assign(member, { steamId: null, steamSource: null });
    state.previousApplication = true;
    const moved = { discordId: "234567890123456789", steamId: "76561198000000002" };
    await expect(store.mutate(id, link(moved), staff, "123", policy)).rejects.toMatchObject({
      status: 409,
      response: {
        blockedReason: "steam_from_application",
        message: expect.stringContaining("previous Discord account"),
      },
    });
    const check = query.mock.calls.find(([config]) => config.text.startsWith("SELECT 1 FROM whitelist_applications"))!;
    expect(check[0].text).toContain("status NOT IN ('declined', 'revoked')");
    expect(check[1]).toEqual([staff.id, "76561198000000002"]);
    expect(query.mock.calls.some(([config]) => config.text.startsWith("update"))).toBe(false);
    await expect(
      store.mutate(id, link({ ...moved, steamConfirmed: true }), staff, "123", policy),
    ).resolves.toMatchObject({ ok: true });
    // Only a new Discord account with a new SteamID is checked.
    for (const change of [{ steamId: "76561198000000002" }, { discordId: "234567890123456789" }]) {
      const other = fixture();
      Object.assign(other.member, { steamId: null, steamSource: null });
      other.state.previousApplication = true;
      await expect(other.store.mutate(id, link(change), staff, "123", policy)).resolves.toMatchObject({ ok: true });
      expect(
        other.query.mock.calls.some(([config]) => config.text.startsWith("SELECT 1 FROM whitelist_applications")),
      ).toBe(false);
    }
  });
  it("refuses to move a founder onto an identity another founder holds, after locking it", async () => {
    const { store, query, state } = fixture();
    state.founder = true;
    state.otherFounder = true;
    await expect(store.mutate(id, link({ steamId: "76561198000000002" }), staff, "123", policy)).rejects.toMatchObject({
      status: 409,
      // The record being changed is a founder itself, so the refusal says the account belongs to another one.
      response: {
        blockedReason: "already_founder",
        message: "Another supporter with this Discord account or SteamID is already a founder.",
      },
    });
    const locks = query.mock.calls.flatMap(([config, params], index) =>
      config.text.includes("pg_advisory_xact_lock") ? [{ index, key: params[0] }] : [],
    );
    const check = query.mock.calls.findIndex(([config]) =>
      config.text.includes('from "supporter_founders" inner join'),
    );
    // The new SteamID is locked before the founder lock, the order automatic matching uses.
    expect(locks.map((lock) => lock.key)).toEqual([
      "supporter:steam:76561198000000002",
      "founder:steam:76561198000000002",
    ]);
    expect(locks[1].index).toBeLessThan(check);
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
    // The same for a SteamID that a founder with no SteamID linked applied with, named as its own reason.
    const applied = fixture();
    applied.state.founder = true;
    applied.state.appliedFounder = true;
    await expect(
      applied.store.mutate(id, link({ steamId: "76561198000000002" }), staff, "123", policy),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        blockedReason: "steam_applied_by_founder",
        message:
          "A founder with no SteamID linked applied for the whitelist with this SteamID. Link that founder's SteamID first.",
      },
    });
    expect(applied.query.mock.calls.find(([config]) => config.text.includes("applied_founder"))![1]).toEqual([
      id,
      "76561198000000002",
    ]);
    // A record that is not a founder takes no founder lock, only the SteamID lock.
    const plain = fixture();
    plain.state.otherFounder = true;
    await expect(
      plain.store.mutate(id, link({ steamId: "76561198000000002" }), staff, "123", policy),
    ).resolves.toMatchObject({ ok: true });
    expect(
      plain.query.mock.calls.filter(([config]) => config.text.includes("pg_advisory_xact_lock")).map(([, p]) => p[0]),
    ).toEqual(["supporter:steam:76561198000000002"]);
  });
  it("locks a SteamID a staff Link writes, before the write, and nothing for a Discord-only change", async () => {
    const steam = fixture();
    await steam.store.mutate(id, link({ steamId: "76561198000000002" }), staff, "123", policy);
    const all = steam.query.mock.calls.map(([config]) => config.text);
    const lock = all.findIndex((text) => text.includes("pg_advisory_xact_lock"));
    expect(steam.query.mock.calls[lock][1]).toEqual(["supporter:steam:76561198000000002"]);
    expect(lock).toBeGreaterThan(all.findIndex((text) => text.endsWith("for update")));
    expect(lock).toBeLessThan(all.findIndex((text) => text.startsWith('update "supporter_members" set "discord_id"')));
    const discord = fixture();
    await discord.store.mutate(id, link({ discordId: "234567890123456789" }), staff, "123", policy);
    expect(discord.query.mock.calls.some(([config]) => config.text.includes("pg_advisory_xact_lock"))).toBe(false);
  });
  it("names an existing founder record instead of failing on its key", async () => {
    const { store, query, payment, state } = fixture();
    state.founder = true;
    await expect(
      store.mutate(
        id,
        {
          kind: "founder",
          id: randomUUID(),
          version: 3,
          confirm: "member-123",
          reason: "Again",
          paymentId: payment.id,
        },
        staff,
        "123",
        policy,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { blockedReason: "already_founder", message: "They are already a founder." },
    });
    expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_founders"'))).toBe(false);
  });
  it("marks a founder payment checked with the payment and why it was listed, only for a payment on the record", async () => {
    const { store, query, payment } = fixture();
    payment.verificationState = "unverified";
    const review: SupporterMutation = {
      kind: "review",
      id: randomUUID(),
      version: 3,
      confirm: "member-123",
      reason: "Checked in Patreon",
      paymentId: payment.id,
    };
    await expect(store.mutate(id, review, staff, "123", policy)).resolves.toMatchObject({ ok: true });
    const lookup = query.mock.calls.find(([config]) => /^select .* from "supporter_payments"/.test(config.text))!;
    expect(lookup[1]).toEqual([payment.id, id]);
    const audit = query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_actions"'))!;
    expect(audit[1]).toEqual(expect.arrayContaining(["review", "Checked in Patreon"]));
    expect(JSON.parse(audit[1].find((value: unknown) => String(value).startsWith("{")) as string)).toEqual({
      paymentId: payment.id,
      reviewReason: "unverified",
    });
    // A founder's own payment that is still paid was listed for losing its first-payment mark.
    const first = fixture();
    await first.store.mutate(id, { ...review, id: randomUUID() }, staff, "123", policy);
    const firstAudit = first.query.mock.calls.find(([config]) =>
      config.text.startsWith('insert into "supporter_actions"'),
    )!;
    expect(firstAudit[1]).toContain(JSON.stringify({ paymentId: first.payment.id, reviewReason: "not_first_payment" }));
    // A payment that is not on this record is refused, and nothing is written.
    const missing = fixture();
    missing.state.missingPayment = true;
    await expect(missing.store.mutate(id, { ...review, id: randomUUID() }, staff, "123", policy)).rejects.toMatchObject(
      { status: 409, message: "Choose a payment recorded for this supporter." },
    );
    expect(missing.query.mock.calls.at(-1)![0].text).toBe("rollback");
    expect(missing.query.mock.calls.some(([config]) => config.text.startsWith("update"))).toBe(false);
  });
  it("leaves out only the founder reviews staff marked checked for the same payment and reason", async () => {
    const paymentId = randomUUID();
    const other = randomUUID();
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({
      rows: [
        [id, { paymentId, reviewReason: "unverified" }],
        [other, { paymentId: null }],
      ],
    }));
    const store = new SupportersStore(drizzle({ query } as unknown as Client) as Database);
    const review = (
      supporterId: string,
      unverifiedPaymentId: string,
      reviewReason: "unverified" | "not_first_payment",
    ) => ({
      supporterId,
      unverifiedPaymentId,
      reviewReason,
    });
    const reviews = [
      review(id, paymentId, "unverified"),
      review(id, paymentId, "not_first_payment"),
      review(id, randomUUID(), "unverified"),
      review(other, paymentId, "unverified"),
    ];
    expect(await store.uncheckedFounderReviews(reviews)).toEqual(reviews.slice(1));
    const [statement, values] = query.mock.calls[0];
    expect(statement.text).toContain('from "supporter_actions"');
    expect(statement.text).toContain('"supporter_actions"."member_id" in ($1, $2)');
    expect(values).toEqual([id, other, "review"]);
    // Nothing to check reads nothing.
    query.mockClear();
    expect(await store.uncheckedFounderReviews([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it("words the founder verdict for a payment in another currency, and flags a first payment staff can check", async () => {
    const usd = {
      id: randomUUID(),
      paidAt: "2026-09-02T00:00:00.000Z",
      amountCents: 500,
      currency: "USD",
      source: "patreon_api",
      reference: "pledge_start:1",
      verificationState: "verified",
      firstSuccessfulPaymentVerified: false,
      minimumConfirmed: false,
      recordedBy: "system:patreon-sync",
    };
    const stored = (payment: Record<string, unknown>, change: Record<string, unknown> = {}) => ({
      id,
      provider: "patreon",
      patreonMemberId: "member-123",
      confirmKey: "member-123",
      lastChargeStatus: "Paid",
      lastChargeAt: usd.paidAt,
      discordId: staff.id,
      discordSource: "patreon",
      patreonDiscordId: staff.id,
      steamId: null,
      steamSource: null,
      steamApplicationId: null,
      payments: [payment],
      founderEligiblePayment: null,
      founderCandidate: { payment, earlier: false, copyUnverified: false },
      otherFounder: false,
      founder: null,
      matchFacts: {
        applications: [],
        automatic: { payment, earlier: false, earlierOtherRecord: false },
        discordReportedForOtherPatron: false,
        patreonDiscordElsewhere: false,
      },
      ...change,
    });
    const read = async (row: Record<string, unknown>) => {
      const query = jest.fn(async () => ({ rows: [{ supporter: row }] }));
      return (await new SupportersStore(drizzle({ query } as unknown as Client) as Database).list("123", policy))[0];
    };
    // A payment in another currency is not below US$5, only not confirmed as worth it.
    const cad = { ...usd, currency: "CAD", amountCents: 1000, firstSuccessfulPaymentVerified: true };
    const unconfirmed = "This CAD payment is not confirmed as US$5 or more.";
    expect(await read(stored(cad))).toMatchObject({
      founderBlockedReason: "below_minimum",
      founderBlockedMessage: unconfirmed,
      automaticBlockedReason: "below_minimum",
      automaticBlockedMessage: unconfirmed,
      founderFirstPaymentToCheck: false,
    });
    const low = { ...usd, amountCents: 300, firstSuccessfulPaymentVerified: true };
    expect(await read(stored(low))).toMatchObject({
      founderBlockedMessage: "Paid less than US$5.",
      automaticBlockedMessage: "Paid less than US$5.",
    });
    // Only the first-payment mark is missing: staff can check it and add a receipt.
    expect(await read(stored(usd))).toMatchObject({
      founderBlockedReason: "not_first_payment",
      founderFirstPaymentToCheck: true,
    });
    // Without a Discord account it is still worth checking: staff can add one.
    expect(await read(stored(usd, { discordId: null, discordSource: null, patreonDiscordId: null }))).toMatchObject({
      founderBlockedReason: "not_first_payment",
      founderFirstPaymentToCheck: true,
    });
    // Anything else that would still stop it leaves it a note.
    for (const [payment, change] of [
      [{ ...usd, paidAt: "2026-08-30T00:00:00.000Z" }, {}],
      [{ ...usd, amountCents: 300 }, {}],
      [{ ...usd, currency: "CAD", minimumConfirmed: true }, {}],
      [usd, { founderCandidate: { payment: usd, earlier: true, copyUnverified: false } }],
      [usd, { otherFounder: true }],
    ] as const)
      expect(await read(stored(payment, change))).toMatchObject({
        founderBlockedReason: "not_first_payment",
        founderFirstPaymentToCheck: false,
      });
  });
  it("reports where each identity came from and how the record is linked", async () => {
    const { store, query } = fixture();
    await store.list("123", policy);
    const [statement] = query.mock.calls[0];
    expect(statement.text).toContain("'discordSource', m.discord_source");
    expect(statement.text).toContain("'patreonDiscordId', m.patreon_discord_id");
    expect(statement.text).toContain("'steamSource', m.steam_source");
    expect(statement.text).toContain("'steamApplicationId', m.steam_application_id");
    expect(statement.text).toContain("WHEN m.discord_id IS NULL OR m.steam_id IS NULL THEN 'partial'");
    expect(statement.text).toContain("WHEN m.discord_source = 'patreon' THEN 'patreon_linked' ELSE 'staff_linked'");
    expect(statement.text).toContain("'automatic', f.awarded_by LIKE 'system:%'");
  });
  it("reads whether a founder with no SteamID linked applied with the record's SteamID, by the shared expression", async () => {
    const { store, query } = fixture();
    await store.list("123", policy);
    const [statement] = query.mock.calls[0];
    expect(statement.text).toContain(
      "'founderAppliedWithSteam', EXISTS (SELECT 1 FROM supporter_founders applied_founder",
    );
    expect(statement.text).toContain(
      "WHERE applied_member.id <> m.id AND applied_member.steam_id IS NULL AND applied.steam_id = m.steam_id",
    );
    expect(statement.text).toContain("AND applied.status NOT IN ('declined', 'revoked'))");
  });
  it("reads every application of the Discord account for matching, never contact details", async () => {
    const { store, query } = fixture();
    await store.list("123", policy);
    const [statement, values] = query.mock.calls[0];
    expect(statement.text).toContain("'matchFacts', json_build_object(");
    expect(statement.text).toContain("FROM whitelist_applications a WHERE a.discord_user_id = m.discord_id");
    expect(statement.text).toContain("claim.status NOT IN ('declined', 'revoked')");
    expect(statement.text).toContain("rejected.status IN ('declined', 'revoked')");
    // Another supporter record of any provider counts: every PayPal record and the campaign's Patreon records.
    expect(statement.text).toContain(
      "AND (holder.provider = 'paypal' OR (holder.provider = 'patreon' AND holder.campaign_id = $",
    );
    expect(statement.text).toContain("p.source = 'patreon_api' AND p.verification_state = 'verified'");
    expect(statement.text).toContain("other_payment.paid_at < p.paid_at");
    expect(statement.text).toContain("reporter.patreon_discord_id = m.discord_id");
    // Only whether another Discord account applied with the linked SteamID, never which one.
    expect(statement.text).toContain("'linkedSteamShared', m.discord_id IS NOT NULL AND m.steam_id IS NOT NULL");
    expect(statement.text).toContain("WHERE shared.steam_id = m.steam_id");
    expect(statement.text).toContain(
      "AND shared.discord_user_id <> m.discord_id AND shared.status NOT IN ('declined', 'revoked')",
    );
    expect(values.filter((value: unknown) => value === "123").length).toBeGreaterThanOrEqual(2);
    expect(statement.text).not.toMatch(/email|contact_consent|review_reason|reviewed_by|discord_display_name/);
  });
  it("shows what automatic matching would do, using the founder rule on its own payment", async () => {
    const payment = {
      id: randomUUID(),
      paidAt: "2026-09-02T00:00:00.000Z",
      amountCents: 500,
      currency: "USD",
      source: "patreon_api",
      reference: "pledge_start:1",
      verificationState: "verified",
      firstSuccessfulPaymentVerified: true,
      minimumConfirmed: false,
      recordedBy: "system:patreon-sync",
    };
    const applicationId = randomUUID();
    const stored = (change: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) => ({
      id,
      provider: "patreon",
      patreonMemberId: "member-123",
      confirmKey: "member-123",
      lastChargeStatus: "Paid",
      lastChargeAt: payment.paidAt,
      discordId: staff.id,
      discordSource: "patreon",
      patreonDiscordId: staff.id,
      steamId: "76561198000000001",
      steamSource: "application",
      steamApplicationId: applicationId,
      payments: [payment],
      founderEligiblePayment: payment,
      founderCandidate: null,
      otherFounder: false,
      founder: null,
      matchFacts: {
        applications: [
          {
            id: applicationId,
            serverId: "primary",
            steamId: "76561198000000001",
            status: "approved",
            accessIntent: "grant",
            whitelistGrant: "granted",
            revokedAt: null,
            reviewedAt: "2026-09-02T01:00:00.000Z",
            otherDiscordClaim: false,
            rejectedBefore: false,
            otherSupporter: false,
          },
        ],
        automatic: { payment, earlier: false, earlierOtherRecord: false },
        discordReportedForOtherPatron: false,
        patreonDiscordElsewhere: false,
        ...facts,
      },
      ...change,
    });
    const read = async (row: Record<string, unknown>) => {
      const query = jest.fn(async () => ({ rows: [{ supporter: row }] }));
      return (await new SupportersStore(drizzle({ query } as unknown as Client) as Database).list("123", policy))[0];
    };
    const view = await read(stored());
    expect(view).toMatchObject({
      automaticBlockedReason: null,
      automaticPayment: { id: payment.id },
      match: {
        steam: { reason: null, steamId: "76561198000000001", applicationId },
        sourceApplication: { id: applicationId, serverId: "primary", status: "approved" },
        sourceApplicationRevoked: false,
      },
    });
    expect(view).not.toHaveProperty("matchFacts");
    expect(view).not.toHaveProperty("otherFounder");
    expect(view).not.toHaveProperty("founderAppliedWithSteam");
    // The staff rule runs on the automatic payment after the automatic rules.
    expect(await read(stored({}, { automatic: { payment, earlier: true, earlierOtherRecord: false } }))).toMatchObject({
      automaticBlockedReason: "earlier_payment",
    });
    expect(await read(stored({ otherFounder: true }))).toMatchObject({ automaticBlockedReason: "already_founder" });
    // A founder with no SteamID linked applied with this record's SteamID: no award, by staff or by automation.
    const appliedByFounder = await read(stored({ founderAppliedWithSteam: true }));
    expect(appliedByFounder).toMatchObject({
      founderBlockedReason: "steam_applied_by_founder",
      founderBlockedMessage: expect.stringContaining("Link that founder's SteamID first."),
      automaticBlockedReason: "steam_applied_by_founder",
    });
    expect(appliedByFounder).not.toHaveProperty("founderAppliedWithSteam");
    expect(await read(stored({ otherFounder: true, founderAppliedWithSteam: true }))).toMatchObject({
      founderBlockedReason: "already_founder",
    });
    expect(await read(stored({}, { linkedSteamShared: true }))).toMatchObject({
      automaticBlockedReason: "steam_shared",
      match: { linkedSteamShared: true },
    });
    expect((await read(stored())).match.linkedSteamShared).toBe(false);
    expect(await read(stored({ discordSource: "staff" }))).toMatchObject({
      automaticBlockedReason: "discord_not_from_patreon",
      automaticBlockedMessage: expect.stringContaining("entered by staff"),
    });
    expect(await read(stored({}, { applications: [] }))).toMatchObject({
      automaticBlockedReason: "source_application_revoked",
      match: { steam: { reason: "no_application" }, sourceApplicationRevoked: true, sourceApplication: null },
    });
    // No SteamID is needed: with none linked, the application's SteamID is only offered for the fill.
    expect(await read(stored({ steamId: null, steamSource: null, steamApplicationId: null }))).toMatchObject({
      automaticBlockedReason: null,
      automaticBlockedMessage: null,
      match: { steam: { reason: null, steamId: "76561198000000001" }, sourceApplicationRevoked: false },
    });
    expect(
      await read(stored({ steamId: null, steamSource: null, steamApplicationId: null }, { applications: [] })),
    ).toMatchObject({ automaticBlockedReason: null, match: { steam: { reason: "no_application" } } });
    // Another record holds the SteamID this Discord account applied with: staff check both before any founder.
    const held = { ...stored().matchFacts.applications[0], otherSupporter: true };
    expect(
      await read(stored({ steamId: null, steamSource: null, steamApplicationId: null }, { applications: [held] })),
    ).toMatchObject({
      automaticBlockedReason: "steam_on_another_record",
      automaticBlockedMessage: "Another supporter record holds a SteamID this Discord account applied with.",
      match: { steam: { reason: "steam_on_another_record" } },
    });
    // The same verdict once the SteamID fill copied the approved SteamID, when the SteamID held elsewhere is another
    // one this Discord account applied with.
    const second = { ...held, id: randomUUID(), serverId: "event", steamId: "76561198000000002", status: "pending" };
    for (const linked of [{}, { steamId: null, steamSource: null, steamApplicationId: null }])
      expect(await read(stored(linked, { applications: [stored().matchFacts.applications[0], second] }))).toMatchObject(
        {
          automaticBlockedReason: "steam_on_another_record",
          match: { steam: { reason: null, steamId: "76561198000000001" } },
        },
      );
    // A founder needs no automatic verdict, and a record without a Discord account has no SteamID match.
    expect(
      await read(
        stored({
          founder: { awardedAt: payment.paidAt, paymentId: payment.id, source: "patreon_api", automatic: true },
        }),
      ),
    ).toMatchObject({ automaticBlockedReason: null, automaticBlockedMessage: null });
    expect(await read(stored({ discordId: null, discordSource: null }))).toMatchObject({
      automaticBlockedReason: "no_discord",
      match: { steam: null },
    });
  });
  it("links one identity at a time and keeps the other", async () => {
    const { store, query } = fixture();
    await store.mutate(
      id,
      {
        kind: "link",
        id: randomUUID(),
        version: 3,
        confirm: "member-123",
        reason: "Linked",
        discordId: "234567890123456789",
      },
      staff,
      "123",
      policy,
    );
    const [, params] = query.mock.calls.find(([config]) =>
      config.text.startsWith('update "supporter_members" set "discord_id"'),
    )!;
    expect(params).toEqual(expect.arrayContaining(["234567890123456789", "76561198000000001"]));
  });
  it("accepts a checked first payment at the inclusive start and writes a permanent promise plus private audit", async () => {
    const { store, query, payment } = fixture();
    await expect(
      store.mutate(
        id,
        {
          kind: "founder",
          id: randomUUID(),
          version: 3,
          confirm: "member-123",
          reason: "Reviewed receipt",
          paymentId: payment.id,
        },
        staff,
        "123",
        policy,
      ),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_founders"'))).toBe(true);
    const audit = query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_actions"'))!;
    expect(audit[1]).toContain("Reviewed receipt");
    expect(audit[1]).toContain(staff.id);
  });
  it("rejects stale reviews and replays only the same actor's exact durable action", async () => {
    const { store, query, state } = fixture();
    const input: SupporterMutation = {
      kind: "review",
      id: randomUUID(),
      version: 2,
      confirm: "member-123",
      reason: "Reviewed observation",
    };
    await expect(store.mutate(id, input, staff, "123", policy)).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([config]) => config.text.startsWith("update"))).toBe(false);
    state.action = {
      id: input.id,
      memberId: id,
      actorId: staff.id,
      actorName: staff.name,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ memberId: id, ...input }))
        .digest("hex"),
      kind: "review",
      reason: input.reason,
      details: {},
      createdAt: new Date(),
    };
    await expect(store.mutate(id, input, staff, "123", policy)).resolves.toMatchObject({ replayed: true });
    await expect(store.mutate(id, { ...input, reason: "Changed review" }, staff, "123", policy)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("PayPal supporter ledger", () => {
  const supporterView = (memberId: string, founder: Record<string, unknown> | null = null) => ({
    id: memberId,
    provider: "paypal",
    patreonMemberId: null,
    confirmKey: memberId,
    displayName: "PayPal donor",
    discordId: staff.id,
    steamId: null,
    version: 1,
    payments: [],
    latestPayment: null,
    founderEligiblePayment: null,
    founderCandidate: null,
    otherFounder: false,
    founder,
  });
  function paypalFixture() {
    const member = {
      id: randomUUID(),
      provider: "paypal",
      campaignId: null,
      patreonMemberId: null,
      displayName: "PayPal donor",
      patronStatus: null,
      lastChargeStatus: null,
      lastChargeAt: null,
      observedAt: new Date(),
      reviewState: "verified",
      discordId: staff.id as string | null,
      steamId: null as string | null,
      version: 2,
    };
    const payment = {
      id: randomUUID(),
      memberId: member.id,
      campaignId: null,
      paidAt: new Date("2026-09-03T12:00:00Z"),
      amountCents: 1000,
      currency: "USD",
      source: "paypal",
      reference: "ABCDE12345FGHIJ",
      verificationState: "verified",
      firstSuccessfulPaymentVerified: true,
      verifiedBy: staff.id,
      minimumConfirmed: false,
      recordedBy: staff.id,
      recordedAt: new Date(),
    };
    const state = {
      existingMember: false,
      recorded: false,
      founderAwarded: false,
      /** This PayPal record is a founder already. */
      existingFounder: false,
      earlier: false,
      appliedFounder: false,
      action: null as Record<string, unknown> | null,
    };
    const query = jest.fn(async (config: { text: string }, _params: unknown[]) => {
      const text = config.text;
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.startsWith("SELECT EXISTS (SELECT 1 FROM supporter_founders applied_founder"))
        return { rows: [{ applied: state.appliedFounder }] };
      if (text.includes("json_build_object"))
        return {
          rows: [
            {
              supporter: supporterView(
                member.id,
                state.founderAwarded ? { paymentId: payment.id, awardedAt: "2026-09-03T12:00:00Z" } : null,
              ),
            },
          ],
        };
      if (text.includes('from "supporter_actions"'))
        return { rows: state.action ? [row(supporterActions, state.action)] : [] };
      if (text.includes('from "supporter_founders"')) return { rows: state.existingFounder ? [[member.id]] : [] };
      if (text.startsWith('select "id" from "supporter_payments"'))
        return { rows: state.earlier ? [[randomUUID()]] : [] };
      if (text.includes('from "supporter_payments"') && text.includes('"reference" ='))
        return { rows: state.recorded ? [row(supporterPayments, payment)] : [] };
      if (text.includes('from "supporter_payments"')) return { rows: [row(supporterPayments, payment)] };
      if (text.includes('from "supporter_members"'))
        return { rows: state.existingMember ? [row(supporterMembers, member)] : [] };
      if (text.startsWith('insert into "supporter_members"')) return { rows: [row(supporterMembers, member)] };
      if (text.startsWith('insert into "supporter_payments"')) return { rows: [row(supporterPayments, payment)] };
      return { rows: [] };
    });
    const input: PaypalInput = {
      id: randomUUID(),
      displayName: "PayPal donor",
      discordId: staff.id,
      paidAt: new Date(payment.paidAt),
      amountCents: 1000,
      currency: "USD",
      transactionId: payment.reference,
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: true,
      minimumConfirmed: false,
      awardFounder: false,
      reason: "Checked the completed PayPal payment",
    };
    return {
      store: new SupportersStore(drizzle({ query } as unknown as Client) as Database),
      query,
      member,
      payment,
      state,
      input,
    };
  }
  const texts = (query: jest.Mock) => query.mock.calls.map(([config]) => (config as { text: string }).text);
  it("creates a verified PayPal supporter, payment and audit together without Patreon fields or payer details", async () => {
    const { store, query, input } = paypalFixture();
    const result = await store.recordPaypal(input, staff, null, policy);
    expect(result).toMatchObject({ ok: true, replayed: false, payment: { source: "paypal" } });
    expect(result.founder).toEqual({ awarded: false, eligible: true, blockedReason: null });
    const all = texts(query);
    expect(all[0]).toBe("begin");
    // The transaction lock is the first statement, before any replay or member lookup.
    expect(all[1]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[1][1]).toEqual([`paypal:${input.transactionId}`]);
    const [memberInsert, memberValues] = query.mock.calls.find(([config]) =>
      config.text.startsWith('insert into "supporter_members"'),
    )!;
    expect(memberValues).toEqual(expect.arrayContaining(["paypal", "PayPal donor", staff.id, "verified"]));
    // The Discord ID staff entered is a staff link; no SteamID was entered, so it has no source.
    expect(memberInsert.text).toContain('"discord_source"');
    expect(memberValues).toContain("staff");
    expect(memberValues).not.toContain("application");
    const [, paymentValues] = query.mock.calls.find(([config]) =>
      config.text.startsWith('insert into "supporter_payments"'),
    )!;
    expect(paymentValues).toEqual(expect.arrayContaining(["paypal", input.transactionId, "verified", "USD", 1000]));
    const [, audit] = query.mock.calls.find(([config]) => config.text.startsWith('insert into "supporter_actions"'))!;
    expect(audit).toEqual(expect.arrayContaining([input.id, staff.id, "paypal-payment", input.reason]));
    expect(all.some((text) => text.startsWith('insert into "supporter_founders"'))).toBe(false);
    expect(all.some((text) => text === "commit")).toBe(true);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/email|payer/i);
  });
  it("attaches a later transaction to the PayPal supporter found by Discord ID and bumps its version", async () => {
    const { store, query, state, input, member } = paypalFixture();
    state.existingMember = true;
    await store.recordPaypal({ ...input, steamId: "76561198000000009" }, staff, null, policy);
    expect(texts(query).some((text) => text.startsWith('insert into "supporter_members"'))).toBe(false);
    const [statement, update] = query.mock.calls.find(([config]) =>
      config.text.startsWith('update "supporter_members"'),
    )!;
    expect(update).toEqual(expect.arrayContaining([staff.id, "76561198000000009", member.version + 1]));
    // Only the SteamID this payment fills in becomes a staff link; the existing Discord link keeps its source.
    expect(statement.text).toContain('"steam_source" =');
    expect(statement.text).not.toContain('"discord_source" =');
    // That SteamID is locked after the member row and before it is written, as a staff Link and automatic matching do.
    const all = texts(query);
    const lock = query.mock.calls.findIndex(([, params]) => params?.[0] === "supporter:steam:76561198000000009");
    expect(lock).toBeGreaterThan(all.findIndex((text) => text.endsWith("for update")));
    expect(lock).toBeLessThan(all.findIndex((text) => text.startsWith('update "supporter_members"')));
  });
  it("locks a SteamID a new PayPal supporter is created with, and none when no SteamID is entered", async () => {
    const withSteam = paypalFixture();
    await withSteam.store.recordPaypal({ ...withSteam.input, steamId: "76561198000000009" }, staff, null, policy);
    const lock = withSteam.query.mock.calls.findIndex(
      ([, params]) => params?.[0] === "supporter:steam:76561198000000009",
    );
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(
      texts(withSteam.query).findIndex((text) => text.startsWith('insert into "supporter_members"')),
    );
    const without = paypalFixture();
    await without.store.recordPaypal(without.input, staff, null, policy);
    expect(
      without.query.mock.calls.some(([, params]) => String(params?.[0] ?? "").startsWith("supporter:steam:")),
    ).toBe(false);
  });
  it("refuses an identity that conflicts with the matched supporter", async () => {
    const { store, query, state, input, member } = paypalFixture();
    state.existingMember = true;
    member.steamId = "76561198000000001";
    await expect(
      store.recordPaypal({ ...input, steamId: "76561198000000009" }, staff, null, policy),
    ).rejects.toMatchObject({ status: 409 });
    expect(texts(query).at(-1)).toBe("rollback");
  });
  it("replays the same action ID only for the same actor and exact request", async () => {
    const { store, query, state, input, payment } = paypalFixture();
    state.action = {
      id: input.id,
      memberId: payment.memberId,
      actorId: staff.id,
      actorName: staff.name,
      kind: "paypal-payment",
      reason: input.reason,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ kind: "paypal-payment", ...input }))
        .digest("hex"),
      details: { paymentId: payment.id },
      createdAt: new Date(),
    };
    await expect(store.recordPaypal(input, staff, null, policy)).resolves.toMatchObject({ replayed: true });
    expect(texts(query).some((text) => text.startsWith("insert"))).toBe(false);
    await expect(store.recordPaypal({ ...input, reason: "Changed reason" }, staff, null, policy)).rejects.toMatchObject(
      { status: 409, message: "This action ID was already used for another review." },
    );
    await expect(store.recordPaypal(input, { ...staff, id: "999999999999999999" }, null, policy)).rejects.toMatchObject(
      { status: 409 },
    );
  });
  it("returns an already recorded transaction with matching details and writes nothing", async () => {
    const { store, query, state, input } = paypalFixture();
    state.recorded = true;
    state.existingMember = true;
    await expect(store.recordPaypal(input, staff, null, policy)).resolves.toMatchObject({ replayed: true });
    expect(texts(query).some((text) => text.startsWith("insert") || text.startsWith("update"))).toBe(false);
  });
  it.each([
    ["amount", { amountCents: 999 }],
    ["currency", { currency: "EUR" }],
    ["payment time", { paidAt: new Date("2026-09-04T12:00:00Z") }],
  ])("refuses an already recorded transaction with a different %s", async (_label, change) => {
    const { store, query, state, input } = paypalFixture();
    state.recorded = true;
    state.existingMember = true;
    await expect(store.recordPaypal({ ...input, ...change }, staff, null, policy)).rejects.toMatchObject({
      status: 409,
      message: "This PayPal transaction is already recorded with different details. Search the transaction ID.",
    });
    expect(texts(query).some((text) => text.startsWith("insert"))).toBe(false);
  });
  it("asks for the founder action when a recorded transaction is resent with a founder request", async () => {
    const { store, state, input } = paypalFixture();
    state.recorded = true;
    state.existingMember = true;
    await expect(store.recordPaypal({ ...input, awardFounder: true }, staff, null, policy)).rejects.toMatchObject({
      status: 409,
      message: "Already recorded; use the founder action.",
    });
  });
  it("records the founder promise in the same transaction when the PayPal payment qualifies", async () => {
    const { store, query, state, input } = paypalFixture();
    state.founderAwarded = true;
    const result = await store.recordPaypal({ ...input, awardFounder: true }, staff, null, policy);
    expect(result.founder).toEqual({ awarded: true, eligible: true, blockedReason: null });
    expect(texts(query).some((text) => text.startsWith('insert into "supporter_founders"'))).toBe(true);
  });
  it("refuses a founder by SteamID when a founder with no SteamID linked applied with it, recording nothing", async () => {
    const { store, query, state, input, member } = paypalFixture();
    state.appliedFounder = true;
    Object.assign(member, { discordId: null, steamId: "76561198000000009" });
    const award = { ...input, discordId: undefined, steamId: "76561198000000009", awardFounder: true };
    await expect(store.recordPaypal(award, staff, null, policy)).rejects.toMatchObject({
      status: 409,
      response: {
        blockedReason: "steam_applied_by_founder",
        message: expect.stringMatching(/Link that founder's SteamID first\. Nothing was recorded\.$/),
      },
    });
    expect(texts(query).at(-1)).toBe("rollback");
    expect(texts(query).some((text) => text.startsWith('insert into "supporter_founders"'))).toBe(false);
    const check = query.mock.calls.find(([config]) => config.text.includes("applied_founder"))!;
    expect(check[1]).toEqual([member.id, "76561198000000009"]);
    // The SteamID lock, then the founder lock, both before the check.
    const keys = query.mock.calls.flatMap(([config, params], index) =>
      config.text.includes("pg_advisory_xact_lock") ? [{ index, key: String(params[0]) }] : [],
    );
    const steamLock = keys.find(({ key }) => key === "supporter:steam:76561198000000009")!;
    const founderLock = keys.find(({ key }) => key === "founder:steam:76561198000000009")!;
    expect([steamLock.index < founderLock.index, founderLock.index < query.mock.calls.indexOf(check)]).toEqual([
      true,
      true,
    ]);
  });
  it.each([
    ["an earlier payment", { earlier: true }, {}, "earlier_payment"],
    ["a non-USD amount without staff confirmation", {}, { currency: "CAD", amountCents: 700 }, "below_minimum"],
    ["no confirmed first payment", {}, { firstSuccessfulPaymentVerified: false }, "not_first_payment"],
  ])("rolls back everything when the founder request is blocked by %s", async (_label, stateChange, change, reason) => {
    const { store, query, state, input, payment } = paypalFixture();
    Object.assign(state, stateChange);
    Object.assign(payment, change);
    await expect(
      store.recordPaypal({ ...input, ...change, awardFounder: true }, staff, null, policy),
    ).rejects.toMatchObject({ status: 409, response: { blockedReason: reason } });
    expect(texts(query).at(-1)).toBe("rollback");
    expect(texts(query).some((text) => text.startsWith('insert into "supporter_founders"'))).toBe(false);
  });
  it("says why a founder was refused in words that are true for the payment and the record", async () => {
    const refusal = async (change: Record<string, unknown>, existingFounder = false) => {
      const { store, state, input, payment } = paypalFixture();
      state.existingFounder = existingFounder;
      Object.assign(payment, change);
      return store
        .recordPaypal({ ...input, ...change, awardFounder: true }, staff, null, policy)
        .catch((error) => error);
    };
    // A payment in another currency is refused only because the form's box was left unticked, so the refusal says so.
    expect(await refusal({ currency: "CAD", amountCents: 1000 })).toMatchObject({
      status: 409,
      response: {
        blockedReason: "below_minimum",
        message:
          "This CAD payment is not confirmed as US$5 or more. Tick Worth US$5 or more if it is. Nothing was recorded.",
      },
    });
    expect(await refusal({ amountCents: 300 })).toMatchObject({
      response: { blockedReason: "below_minimum", message: "Paid less than US$5. Nothing was recorded." },
    });
    // This record is the founder itself, not another one.
    expect(await refusal({}, true)).toMatchObject({
      response: { blockedReason: "already_founder", message: "They are already a founder. Nothing was recorded." },
    });
  });
});
