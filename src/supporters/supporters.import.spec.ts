import { randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { supporterMembers, supporterPayments } from "../database/supporters.schema";
import type { Staff } from "../admin/admin.types";
import type { PatreonMemberSnapshot, PatreonPledgeEvent } from "./patreon.client";
import { apiSnapshotHash, PATREON_SYNC_ACTOR, SupportersStore, tierMeetsMinimum } from "./supporters.store";
import type { FounderPolicy } from "./supporters.types";

const campaign = "16880209";
const memberId = randomUUID();
const staff: Staff = { id: "123456789012345678", name: "Admin", role: "admin", csrf: "csrf" };
const policy: FounderPolicy = {
  configured: true,
  amountCents: 500,
  currency: "USD",
  startsAt: "2026-09-30T04:00:00.000Z",
  endsAt: "2026-10-15T04:00:00.000Z",
  source: "PATREON_FOUNDER",
};
const paid = (id: string, date: string, overrides: Partial<PatreonPledgeEvent> = {}): PatreonPledgeEvent => ({
  id,
  date: new Date(date),
  amountCents: 500,
  currency: "USD",
  paymentStatus: "Paid",
  type: "subscription",
  ...overrides,
});
const snapshot = (overrides: Partial<PatreonMemberSnapshot> = {}): PatreonMemberSnapshot => ({
  patreonMemberId: "member-1",
  displayName: "Patron",
  patronStatus: "active_patron",
  lastChargeStatus: "Paid",
  lastChargeAt: new Date("2026-10-01T12:00:00Z"),
  discordId: null,
  discordKnown: true,
  events: [paid("pledge_start:1", "2026-10-01T12:00:00Z", { type: "pledge_start" })],
  historyComplete: true,
  ...overrides,
});
function row(table: PgTable, value: Record<string, unknown>) {
  return Object.keys(getTableColumns(table)).map((key) =>
    value[key] instanceof Date ? (value[key] as Date).toISOString() : (value[key] ?? null),
  );
}
function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    memberId,
    campaignId: campaign,
    paidAt: new Date("2026-10-01T12:00:00Z"),
    amountCents: 500,
    currency: "USD",
    source: "patreon_api",
    reference: "pledge_start:1",
    verificationState: "verified",
    firstSuccessfulPaymentVerified: true,
    verifiedBy: PATREON_SYNC_ACTOR.id,
    recordedAt: new Date(),
    ...overrides,
  };
}
function fixture() {
  const state = {
    created: false,
    observed: true,
    otherDiscord: false,
    earlier: false,
    // The imported copy of a staff receipt's charge, as the receipt-copy lookup returns it.
    copy: null as { id: string; verification_state: string } | null,
    member: {
      id: memberId,
      campaignId: campaign,
      patreonMemberId: "member-1",
      displayName: "Patron",
      patronStatus: "active_patron",
      lastChargeStatus: "Paid",
      lastChargeAt: new Date("2026-10-01T12:00:00Z"),
      observedAt: new Date(),
      reviewState: "verified",
      discordId: null as string | null,
      discordSource: null as string | null,
      patreonDiscordId: null as string | null,
      steamId: null as string | null,
      steamSource: null as string | null,
      version: 4,
    },
    payments: [] as Record<string, unknown>[],
  };
  const query = jest.fn(async (config: { text: string }, params: unknown[]) => {
    const text = config.text;
    if (text.startsWith('insert into "supporter_members"')) return { rows: state.created ? [[memberId]] : [] };
    if (text.includes('from "supporter_members"') && text.endsWith("for update"))
      return { rows: [row(supporterMembers, state.member)] };
    if (text.startsWith('select "id" from "supporter_members"'))
      return { rows: state.otherDiscord ? [[randomUUID()]] : [] };
    if (text.startsWith('insert into "supporter_observations"')) return { rows: state.observed ? [[params[0]]] : [] };
    if (text.startsWith('select "id" from "supporter_payments"'))
      return { rows: state.earlier ? [[randomUUID()]] : [] };
    if (text.startsWith("SELECT dup.id")) return { rows: state.copy ? [state.copy] : [] };
    if (text.startsWith("select") && text.includes('from "supporter_payments"'))
      return { rows: state.payments.map((value) => row(supporterPayments, value)) };
    if (text.startsWith('insert into "supporter_payments"')) return { rows: [[randomUUID()]] };
    return { rows: [] };
  });
  const store = new SupportersStore(drizzle({ query } as unknown as Client) as Database);
  const calls = (prefix: string) => query.mock.calls.filter(([config]) => config.text.startsWith(prefix));
  return { store, query, state, calls };
}
const at = new Date("2026-10-02T12:00:00Z");
type Call = [{ text: string }, unknown[]];
/** The value an insert binds for one column; undefined when the column is left to its default. */
function bound([statement, values]: Call, column: string) {
  const [, columns, placeholders] = /\(([^)]*)\) values \(([^)]*)\)/.exec(statement.text)!;
  const placeholder = placeholders.split(", ")[columns.split(", ").indexOf(`"${column}"`)];
  return placeholder.startsWith("$") ? values[Number(placeholder.slice(1)) - 1] : undefined;
}
/** The details of each audit row written. */
const details = (calls: Call[]) =>
  calls.map(([, values]) => JSON.parse(values.find((value) => String(value).startsWith("{")) as string));

describe("Patreon API import persistence", () => {
  it("hashes a canonical snapshot that ignores event order and the connected Discord account", () => {
    const events = [paid("subscription:2", "2026-11-01T00:00:00Z"), ...snapshot().events];
    const base = apiSnapshotHash(campaign, snapshot({ events }));
    expect(apiSnapshotHash(campaign, snapshot({ events: [...events].reverse(), discordId: staff.id }))).toBe(base);
    expect(apiSnapshotHash(campaign, snapshot({ events, patronStatus: "former_patron" }))).not.toBe(base);
    expect(apiSnapshotHash("other", snapshot({ events }))).not.toBe(base);
    expect(apiSnapshotHash(campaign, snapshot({ events, patreonMemberId: "member-2" }))).not.toBe(base);
  });
  it("imports a new member with an api:sync observation and one verified first payment per Paid event", async () => {
    const { store, state, calls, query } = fixture();
    state.created = true;
    const result = await store.importApiMember(
      campaign,
      snapshot({
        events: [
          paid("pledge_start:1", "2026-10-01T12:00:00Z", { type: "pledge_start" }),
          paid("subscription:2", "2026-11-01T12:00:00Z"),
          paid("subscription:3", "2026-12-01T12:00:00Z", { paymentStatus: "Declined" }),
        ],
      }),
      at,
    );
    expect(result).toMatchObject({ created: true, updated: false, payments: 2, revoked: 0, conflict: null });
    const [observation] = calls('insert into "supporter_observations"');
    expect(observation[0].text).toContain("on conflict do nothing");
    expect(observation[1]).toEqual(expect.arrayContaining(["api:sync", "active_patron", "Paid"]));
    const inserts = calls('insert into "supporter_payments"');
    expect(inserts).toHaveLength(2);
    for (const [statement] of inserts) expect(statement.text).toContain("on conflict do nothing");
    const [first, second] = inserts.map(([, values]) => values);
    expect(first).toEqual(
      expect.arrayContaining(["patreon_api", "pledge_start:1", "verified", true, 500, "USD", PATREON_SYNC_ACTOR.id]),
    );
    expect(second).toEqual(expect.arrayContaining(["patreon_api", "subscription:2", "verified", false]));
    expect(JSON.stringify(inserts)).not.toContain("subscription:3");
    const [update] = calls('update "supporter_members"');
    expect(update[1]).toEqual(expect.arrayContaining(["pending", 5]));
    expect(query.mock.calls.map(([config]) => config.text).join("\n")).not.toMatch(/supporter_founders/);
    expect(query.mock.calls.at(-1)![0].text).toBe("commit");
  });
  it("leaves the first-payment flag unset when the returned history may be truncated", async () => {
    const { store, state, calls } = fixture();
    state.created = true;
    await store.importApiMember(campaign, snapshot({ historyComplete: false }), at);
    const [[, values]] = calls('insert into "supporter_payments"');
    expect(values).toEqual(expect.arrayContaining(["pledge_start:1", "verified", false]));
    expect(values).not.toContain(true);
  });
  it("re-syncs an unchanged member without an observation, review reset, payment write or version bump", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [payment()];
    expect(await store.importApiMember(campaign, snapshot(), at)).toMatchObject({
      created: false,
      updated: false,
      payments: 0,
      revoked: 0,
      discordLinked: false,
    });
    expect(calls("update")).toHaveLength(0);
    expect(calls('insert into "supporter_payments"')).toHaveLength(0);
    expect(calls('insert into "supporter_actions"')).toHaveLength(0);
  });
  it("adds only new charges for a changed member and keeps an existing first payment answer on truncation", async () => {
    const { store, state, calls } = fixture();
    state.payments = [payment()];
    const result = await store.importApiMember(
      campaign,
      snapshot({
        historyComplete: false,
        events: [...snapshot().events, paid("subscription:2", "2026-11-01T12:00:00Z")],
      }),
      at,
    );
    expect(result).toMatchObject({ updated: true, payments: 1 });
    const inserts = calls('insert into "supporter_payments"');
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toContain("subscription:2");
    expect(calls('update "supporter_payments"')).toHaveLength(0);
  });
  it.each(["Refunded", "Declined", "Fraud", "Partially Refunded"])(
    "marks a payment later reported %s unverified with a system audit and never touches founder records",
    async (status) => {
      const { store, state, calls, query } = fixture();
      state.payments = [payment()];
      const result = await store.importApiMember(
        campaign,
        snapshot({
          events: [paid("pledge_start:1", "2026-10-01T12:00:00Z", { type: "pledge_start", paymentStatus: status })],
        }),
        at,
      );
      expect(result).toMatchObject({ revoked: 1, payments: 0 });
      const [update] = calls('update "supporter_payments"');
      expect(update[1]).toEqual(expect.arrayContaining(["unverified", false]));
      const [[, audit]] = calls('insert into "supporter_actions"');
      expect(audit).toEqual(
        expect.arrayContaining([PATREON_SYNC_ACTOR.id, PATREON_SYNC_ACTOR.name, "patreon-payment-status"]),
      );
      expect(JSON.stringify(audit)).toContain(status);
      expect(query.mock.calls.map(([config]) => config.text).join("\n")).not.toMatch(/supporter_founders|delete from/);
    },
  );
  it("re-verifies a payment Patreon reports Paid again", async () => {
    const { store, state, calls } = fixture();
    state.payments = [payment({ verificationState: "unverified", firstSuccessfulPaymentVerified: false })];
    expect(await store.importApiMember(campaign, snapshot(), at)).toMatchObject({ revoked: 0 });
    const [update] = calls('update "supporter_payments"');
    expect(update[1]).toEqual(expect.arrayContaining(["verified", true]));
    expect(calls('insert into "supporter_actions"')).toHaveLength(1);
  });
  it("fills an empty Discord link from Patreon with a system audit row", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [payment()];
    const result = await store.importApiMember(campaign, snapshot({ discordId: staff.id }), at);
    expect(result).toMatchObject({ discordLinked: true, conflict: null });
    const [lookup] = calls('select "id" from "supporter_members"');
    expect(lookup[0].text).toContain('"discord_id" =');
    expect(lookup[0].text).toContain('"id" <>');
    const [update] = calls('update "supporter_members"');
    expect(update[0].text).toContain('"discord_id" =');
    expect(update[0].text).toContain('"discord_source" =');
    expect(update[0].text).toContain('"patreon_discord_id" =');
    expect(update[0].text).not.toContain('"steam_id"');
    expect(update[0].text).not.toContain('"steam_source"');
    expect(update[0].text).not.toContain('"steam_application_id"');
    expect(update[0].text).not.toContain('"review_state"');
    expect(update[1]).toEqual(expect.arrayContaining([staff.id, "patreon", 5]));
    const [[, audit]] = calls('insert into "supporter_actions"');
    expect(audit).toEqual(
      expect.arrayContaining(["system:patreon-sync", "Patreon sync", "patreon-discord-link", memberId]),
    );
  });
  it("never overwrites an existing link, and records what Patreon reports with one version bump", async () => {
    const differs = fixture();
    differs.state.observed = false;
    differs.state.payments = [payment()];
    differs.state.member.discordId = "999999999999999999";
    expect(await differs.store.importApiMember(campaign, snapshot({ discordId: staff.id }), at)).toMatchObject({
      discordLinked: false,
      conflict: "discord-differs",
      patreonDiscordChanged: true,
    });
    const [update, ...others] = differs.calls("update");
    expect(others).toHaveLength(0);
    expect(update[0].text).toBe(
      'update "supporter_members" set "patreon_discord_id" = $1, "version" = $2 where "supporter_members"."id" = $3',
    );
    expect(update[1]).toEqual([staff.id, 5, memberId]);
    expect(differs.calls('insert into "supporter_actions"')).toHaveLength(0);
    const same = fixture();
    same.state.observed = false;
    same.state.member.discordId = staff.id;
    expect(await same.store.importApiMember(campaign, snapshot({ discordId: staff.id }), at)).toMatchObject({
      conflict: null,
      discordLinked: false,
    });
    const used = fixture();
    used.state.observed = false;
    used.state.payments = [payment()];
    used.state.otherDiscord = true;
    expect(await used.store.importApiMember(campaign, snapshot({ discordId: staff.id }), at)).toMatchObject({
      discordLinked: false,
      conflict: "discord-in-use",
      patreonDiscordChanged: true,
    });
    const [recorded] = used.calls("update");
    expect(recorded[0].text).not.toContain('"discord_id" =');
    expect(recorded[0].text).not.toContain('"discord_source"');
    expect(recorded[1]).toEqual([staff.id, 5, memberId]);
  });
  it("writes nothing when Patreon still reports the account it reported before", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [payment()];
    Object.assign(state.member, { discordId: staff.id, discordSource: "patreon", patreonDiscordId: staff.id });
    expect(await store.importApiMember(campaign, snapshot({ discordId: staff.id }), at)).toMatchObject({
      updated: false,
      patreonDiscordChanged: false,
    });
    expect(calls("update")).toHaveLength(0);
  });
  it("clears what Patreon reports when the patron disconnects Discord, but keeps the link", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [payment()];
    Object.assign(state.member, { discordId: staff.id, discordSource: "patreon", patreonDiscordId: staff.id });
    expect(await store.importApiMember(campaign, snapshot({ discordId: null }), at)).toMatchObject({
      patreonDiscordChanged: true,
      discordId: staff.id,
    });
    const [update] = calls("update");
    expect(update[0].text).not.toContain('"discord_id" =');
    expect(update[1]).toEqual([null, 5, memberId]);
  });
  it("never clears what Patreon reported when its answer could not be read", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [payment()];
    Object.assign(state.member, { discordId: staff.id, discordSource: "patreon", patreonDiscordId: staff.id });
    expect(await store.importApiMember(campaign, snapshot({ discordId: null, discordKnown: false }), at)).toMatchObject(
      { patreonDiscordChanged: false },
    );
    expect(calls("update")).toHaveLength(0);
  });
  it("keeps webhook ordering rules: an older API charge does not replace newer webhook state", async () => {
    const { store, state, calls } = fixture();
    state.member.lastChargeAt = new Date("2026-11-01T12:00:00Z");
    await store.importApiMember(campaign, snapshot(), at);
    const [update] = calls('update "supporter_members"');
    expect(update[0].text).not.toContain('"last_charge_at" =');
    expect(update[0].text).not.toContain('"patron_status" =');
    expect(update[1]).toContain("pending");
  });
  it("re-asserts an unchanged snapshot over member state a late webhook overwrote", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [payment()];
    // A redelivered webhook with the same charge date set an older status after the sync stored this snapshot.
    const result = await store.importApiMember(campaign, snapshot({ patronStatus: "former_patron" }), at);
    expect(result).toMatchObject({ created: false, updated: true, payments: 0 });
    const [update] = calls('update "supporter_members"');
    expect(update[0].text).toContain('"patron_status" =');
    expect(update[1]).toEqual(expect.arrayContaining(["former_patron", "pending", 5]));
  });
  it.each([
    ["a newer webhook charge", { lastChargeAt: new Date("2026-11-01T12:00:00Z"), patronStatus: "former_patron" }, {}],
    ["an undated snapshot", {}, { lastChargeStatus: null, lastChargeAt: null }],
  ])(
    "does not re-assert an unchanged snapshot against %s",
    async (_case, member: Partial<ReturnType<typeof fixture>["state"]["member"]>, changes) => {
      const { store, state, calls } = fixture();
      state.observed = false;
      state.payments = [payment()];
      Object.assign(state.member, member);
      expect(await store.importApiMember(campaign, snapshot(changes), at)).toMatchObject({ updated: false });
      expect(calls("update")).toHaveLength(0);
    },
  );
  it("lists founder promises whose payment is no longer verified, scoped to the campaign", async () => {
    const { store, query } = fixture();
    await store.founderReviews(campaign);
    const [statement, values] = query.mock.calls[0];
    expect(statement.text).toContain("FROM supporter_founders f");
    expect(statement.text).toContain("x.verification_state <> 'verified'");
    expect(statement.text).toContain("WHERE m.campaign_id = $1");
    expect(values).toEqual([campaign]);
  });
  it("also lists a founder awarded on a staff receipt when an imported payment around the founder window is no longer verified", async () => {
    const { store, query } = fixture();
    await store.founderReviews(campaign);
    const text = query.mock.calls[0][0].text;
    expect(text).toContain("x.id = f.payment_id OR (x.source = 'patreon_api'");
    expect(text).toContain("x.paid_at >= f.window_start - interval '36 hours'");
    expect(text).toContain("x.paid_at < f.window_end + interval '36 hours'");
    expect(text).toContain('unverified.id AS "unverifiedPaymentId", unverified.reference AS "unverifiedReference"');
  });
  it("also lists a founder whose own payment is no longer marked as the first payment", async () => {
    const { store, query } = fixture();
    await store.founderReviews(campaign);
    const text = query.mock.calls[0][0].text;
    expect(text).toContain("OR (x.id = f.payment_id AND NOT x.first_successful_payment_verified)");
    expect(text).toContain("ELSE 'not_first_payment' END AS review_reason");
    expect(text).toContain('unverified.review_reason AS "reviewReason"');
  });
});

describe("a Patreon payment in another currency, counted by the price of its tier", () => {
  /** The live case: a Canadian patron on the US$5 tier pays 7.50 CAD. */
  const cad = (overrides: Partial<PatreonPledgeEvent> = {}) =>
    paid("pledge_start:1", "2026-10-01T12:00:00Z", {
      type: "pledge_start",
      amountCents: 750,
      currency: "CAD",
      tierId: "111",
      tierAmountCents: 500,
      ...overrides,
    });
  const cadRow = (overrides: Record<string, unknown> = {}) =>
    payment({ amountCents: 750, currency: "CAD", minimumConfirmed: false, ...overrides });

  it.each<[string, Partial<PatreonPledgeEvent>, boolean]>([
    ["a US$5 tier", {}, true],
    ["a dearer tier", { amountCents: 1500, tierAmountCents: 1000 }, true],
    ["a tier under US$5", { tierAmountCents: 499 }, false],
    ["a tier Patreon gave no price for", { tierAmountCents: undefined }, false],
    ["no tier at all", { tierId: undefined, tierAmountCents: undefined }, false],
    ["a payment in US dollars", { currency: "USD", amountCents: 100 }, false],
    ["a payment with no currency", { currency: null }, false],
    ["a payment with no amount", { amountCents: null }, false],
    ["a payment of nothing", { amountCents: 0 }, false],
    ["a declined charge", { paymentStatus: "Declined" }, false],
    ["a refunded charge", { paymentStatus: "Refunded" }, false],
  ])("decides %s", (_name, change, expected) => {
    expect(tierMeetsMinimum(cad(change))).toBe(expected);
  });
  it("confirms a new CAD payment on a US$5 tier, with a system audit row", async () => {
    const { store, state, calls } = fixture();
    state.created = true;
    const result = await store.importApiMember(campaign, snapshot({ events: [cad()] }), at);
    expect(result).toMatchObject({ payments: 1, tierConfirmed: 1, tierConfirmedNew: 1, tierUnconfirmed: 0 });
    const [insert] = calls('insert into "supporter_payments"') as Call[];
    expect(bound(insert, "minimum_confirmed")).toBe(true);
    // The amount and currency Patreon charged are stored as they are.
    expect(bound(insert, "amount_cents")).toBe(750);
    expect(bound(insert, "currency")).toBe("CAD");
    expect(bound(insert, "verification_state")).toBe("verified");
    expect(bound(insert, "first_successful_payment_verified")).toBe(true);
    const audits = calls('insert into "supporter_actions"') as Call[];
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toEqual(
      expect.arrayContaining([PATREON_SYNC_ACTOR.id, PATREON_SYNC_ACTOR.name, "patreon-payment-minimum", memberId]),
    );
    expect(details(audits)[0]).toEqual({
      paymentId: expect.any(String),
      reference: "pledge_start:1",
      amountCents: 750,
      currency: "CAD",
      tierId: "111",
      tierAmountCents: 500,
      minimumConfirmed: 1,
    });
  });
  it.each<[string, Partial<PatreonPledgeEvent>]>([
    ["a tier under US$5", { tierAmountCents: 300 }],
    ["an unknown tier", { tierAmountCents: undefined }],
    ["no tier", { tierId: undefined, tierAmountCents: undefined }],
  ])("leaves a new CAD payment on %s unconfirmed, exactly as before", async (_name, change) => {
    const { store, state, calls } = fixture();
    state.created = true;
    const result = await store.importApiMember(campaign, snapshot({ events: [cad(change)] }), at);
    expect(result).toMatchObject({ payments: 1, tierConfirmed: 0, tierConfirmedNew: 0, tierUnconfirmed: 1 });
    const [insert] = calls('insert into "supporter_payments"') as Call[];
    expect(bound(insert, "minimum_confirmed")).toBe(false);
    expect(bound(insert, "verification_state")).toBe("verified");
    expect(bound(insert, "first_successful_payment_verified")).toBe(true);
    expect(calls('insert into "supporter_actions"')).toHaveLength(0);
  });
  it("leaves payments in US dollars alone, whatever their tier costs", async () => {
    const { store, state, calls } = fixture();
    state.created = true;
    const result = await store.importApiMember(
      campaign,
      snapshot({ events: [cad({ currency: "USD", amountCents: 500, tierAmountCents: 1000 })] }),
      at,
    );
    expect(result).toMatchObject({ payments: 1, tierConfirmed: 0, tierConfirmedNew: 0, tierUnconfirmed: 0 });
    expect(bound(calls('insert into "supporter_payments"')[0] as Call, "minimum_confirmed")).toBe(false);
    expect(calls('insert into "supporter_actions"')).toHaveLength(0);
  });
  it("gives the same hash with and without tier data, so learning a tier sends no record back to review", () => {
    const plain = cad({ tierId: undefined, tierAmountCents: undefined });
    expect(apiSnapshotHash(campaign, snapshot({ events: [cad()] }))).toBe(
      apiSnapshotHash(campaign, snapshot({ events: [plain] })),
    );
  });
  it("confirms a CAD payment imported earlier, on an unchanged member, without resetting its review", async () => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [cadRow()];
    const result = await store.importApiMember(campaign, snapshot({ events: [cad()] }), at);
    expect(result).toMatchObject({
      created: false,
      updated: false,
      payments: 0,
      revoked: 0,
      tierConfirmed: 1,
      tierConfirmedNew: 1,
      tierUnconfirmed: 0,
    });
    const [update, ...others] = calls('update "supporter_payments"');
    expect(others).toHaveLength(0);
    expect(update[0].text).toBe(
      'update "supporter_payments" set "verification_state" = $1, "first_successful_payment_verified" = $2, "minimum_confirmed" = $3 where "supporter_payments"."id" = $4',
    );
    expect(update[1]).toEqual(["verified", true, true, state.payments[0].id]);
    // Only the version moves, so an open staff dialog refreshes; the review state and the member's fields stay.
    const [member] = calls('update "supporter_members"');
    expect(member[0].text).toBe('update "supporter_members" set "version" = $1 where "supporter_members"."id" = $2');
    expect(member[1]).toEqual([5, memberId]);
    const audits = calls('insert into "supporter_actions"') as Call[];
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toEqual(expect.arrayContaining([PATREON_SYNC_ACTOR.id, "patreon-payment-minimum"]));
    expect(details(audits)[0]).toMatchObject({ paymentId: state.payments[0].id, tierAmountCents: 500 });
    expect(calls('insert into "supporter_payments"')).toHaveLength(0);
    expect(calls('insert into "supporter_observations"')).toHaveLength(1);
  });
  it.each<[string, Partial<PatreonPledgeEvent>]>([
    ["with the same tier", {}],
    ["after the tier's price dropped under US$5", { tierAmountCents: 100 }],
    ["when Patreon stops reporting the tier", { tierId: undefined, tierAmountCents: undefined }],
  ])("never takes a confirmation back: %s", async (_name, change) => {
    const { store, state, calls } = fixture();
    state.observed = false;
    state.payments = [cadRow({ minimumConfirmed: true })];
    const result = await store.importApiMember(campaign, snapshot({ events: [cad(change)] }), at);
    expect(result).toMatchObject({ updated: false, tierConfirmed: 1, tierConfirmedNew: 0, tierUnconfirmed: 0 });
    expect(calls("update")).toHaveLength(0);
    expect(calls('insert into "supporter_actions"')).toHaveLength(0);
  });
  it("keeps a confirmation when the payment is later refunded, and confirms nothing on a refunded payment", async () => {
    const refunded = fixture();
    refunded.state.payments = [cadRow({ minimumConfirmed: true })];
    expect(
      await refunded.store.importApiMember(campaign, snapshot({ events: [cad({ paymentStatus: "Refunded" })] }), at),
    ).toMatchObject({ revoked: 1, tierConfirmed: 0, tierConfirmedNew: 0, tierUnconfirmed: 0 });
    const [update] = refunded.calls('update "supporter_payments"');
    expect(update[0].text).not.toContain("minimum_confirmed");
    expect(update[1]).toEqual(expect.arrayContaining(["unverified", false]));
    const never = fixture();
    never.state.observed = false;
    never.state.payments = [cadRow({ verificationState: "unverified", firstSuccessfulPaymentVerified: false })];
    expect(
      await never.store.importApiMember(campaign, snapshot({ events: [cad({ paymentStatus: "Refunded" })] }), at),
    ).toMatchObject({ tierConfirmedNew: 0 });
    expect(never.calls("update")).toHaveLength(0);
  });
  it("leaves an earlier CAD payment unconfirmed while its tier is unknown or under US$5", async () => {
    for (const change of [{ tierAmountCents: undefined }, { tierAmountCents: 499 }]) {
      const { store, state, calls } = fixture();
      state.observed = false;
      state.payments = [cadRow()];
      expect(await store.importApiMember(campaign, snapshot({ events: [cad(change)] }), at)).toMatchObject({
        updated: false,
        tierConfirmed: 0,
        tierConfirmedNew: 0,
        tierUnconfirmed: 1,
      });
      expect(calls("update")).toHaveLength(0);
      expect(calls('insert into "supporter_actions"')).toHaveLength(0);
    }
  });
  it("confirms and re-verifies one payment in a single update, with an audit row for each change", async () => {
    const { store, state, calls } = fixture();
    state.payments = [cadRow({ verificationState: "unverified", firstSuccessfulPaymentVerified: false })];
    expect(await store.importApiMember(campaign, snapshot({ events: [cad()] }), at)).toMatchObject({
      revoked: 0,
      tierConfirmedNew: 1,
    });
    const updates = calls('update "supporter_payments"');
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(["verified", true, true, state.payments[0].id]);
    const kinds = (calls('insert into "supporter_actions"') as Call[]).map(([statement, values]) =>
      bound([statement, values], "kind"),
    );
    expect(kinds.sort()).toEqual(["patreon-payment-minimum", "patreon-payment-status"]);
  });
});

describe("founder eligibility for authenticated Patreon payments", () => {
  it("lists a verified first patreon_api payment like a manual receipt, ignoring only earlier webhook status rows", async () => {
    const { store, query } = fixture();
    await store.list(campaign, policy);
    const [statement, values] = query.mock.calls[0];
    // One provider-neutral rule: every qualifying source is a bound parameter.
    expect(statement.text).toMatch(/p\.source IN \(\$\d+, \$\d+, \$\d+\) AND p\.verification_state = 'verified'/);
    expect(values).toEqual(expect.arrayContaining(["manual_receipt", "patreon_api", "paypal"]));
    expect(statement.text).toContain("AND p.first_successful_payment_verified AND NOT EXISTS");
    expect(statement.text).toContain("AND (p.source <> 'patreon_api' OR earlier.source <> 'signed_status')");
  });
  it("lists a staff receipt despite the earlier imported copy of its own charge, and prefers the receipt", async () => {
    const { store, query } = fixture();
    await store.list(campaign, policy);
    const text = query.mock.calls[0][0].text;
    // The copy is the nearest imported payment with the receipt's amount and currency within 36 hours.
    expect(text).toContain("LEFT JOIN LATERAL (SELECT api.id, api.verification_state FROM supporter_payments api");
    expect(text).toContain("WHERE p.source = 'manual_receipt' AND api.member_id = p.member_id");
    expect(text).toContain("AND api.amount_cents = p.amount_cents AND api.currency = p.currency");
    expect(text).toContain(
      "AND api.paid_at BETWEEN p.paid_at - interval '36 hours' AND p.paid_at + interval '36 hours'",
    );
    expect(text).toContain(
      "ORDER BY abs(extract(epoch FROM api.paid_at - p.paid_at)), api.paid_at, api.id LIMIT 1) dup",
    );
    expect(text).toContain("AND (dup.id IS NULL OR dup.verification_state = 'verified')");
    expect(text).toContain("AND earlier.id IS DISTINCT FROM dup.id");
    expect(text).toContain("ORDER BY (p.source = 'manual_receipt') DESC, p.paid_at DESC, p.recorded_at DESC LIMIT 1");
  });
  const founder = (paymentId: string) => ({
    kind: "founder" as const,
    id: randomUUID(),
    version: 4,
    confirm: "member-1",
    reason: "Checked the Patreon payment history",
    paymentId,
  });
  function linked(source: string, overrides: Record<string, unknown> = {}) {
    const context = fixture();
    context.state.member.discordId = staff.id;
    context.state.member.steamId = "76561198000000001";
    context.state.payments = [payment({ source, ...overrides })];
    return context;
  }
  it("accepts a verified first patreon_api payment and checks earlier non-webhook payments", async () => {
    const { store, state, calls } = linked("patreon_api");
    await expect(
      store.mutate(memberId, founder(state.payments[0].id as string), staff, campaign, policy),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    const [[earlier, values]] = calls('select "id" from "supporter_payments"');
    expect(earlier.text).toContain('"supporter_payments"."source" <>');
    expect(values).toContain("signed_status");
    expect(calls('insert into "supporter_founders"')).toHaveLength(1);
    expect(calls("SELECT dup.id")).toHaveLength(0);
  });
  it("still lets any earlier payment, including a webhook status row, block a manual receipt", async () => {
    const { store, state, calls } = linked("manual_receipt");
    await store.mutate(memberId, founder(state.payments[0].id as string), staff, campaign, policy);
    const [[earlier, values]] = calls('select "id" from "supporter_payments"');
    expect(earlier.text).not.toContain('"source"');
    expect(earlier.text).not.toContain('"id" <>');
    expect(values).not.toContain("signed_status");
  });
  it("does not let the verified imported copy of a staff receipt's charge count as an earlier payment", async () => {
    const { store, state, calls } = linked("manual_receipt", { reference: "receipt-1", verifiedBy: staff.id });
    const copy = randomUUID();
    state.copy = { id: copy, verification_state: "verified" };
    await expect(
      store.mutate(memberId, founder(state.payments[0].id as string), staff, campaign, policy),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    const [[lookup, lookupValues]] = calls("SELECT dup.id");
    expect(lookup.text).toContain(
      "CROSS JOIN LATERAL (SELECT api.id, api.verification_state FROM supporter_payments api",
    );
    expect(lookupValues).toEqual([state.payments[0].id]);
    const [[earlier, values]] = calls('select "id" from "supporter_payments"');
    expect(earlier.text).toContain('"supporter_payments"."id" <>');
    expect(values).toContain(copy);
    expect(calls('insert into "supporter_founders"')).toHaveLength(1);
  });
  it("refuses a staff receipt whose imported copy Patreon no longer reports as paid", async () => {
    const { store, state, calls, query } = linked("manual_receipt", { reference: "receipt-1", verifiedBy: staff.id });
    state.copy = { id: randomUUID(), verification_state: "unverified" };
    await expect(
      store.mutate(memberId, founder(state.payments[0].id as string), staff, campaign, policy),
    ).rejects.toMatchObject({ status: 409, response: { blockedReason: "not_verified" } });
    expect(calls('insert into "supporter_founders"')).toHaveLength(0);
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
  });
  it.each([
    ["an earlier verified payment", {}, true],
    ["an unverified (refunded) payment", { verificationState: "unverified" }, false],
    ["a payment not derived as the first", { firstSuccessfulPaymentVerified: false }, false],
    ["a non-USD payment", { currency: "EUR" }, false],
    ["a non-USD payment on a tier under US$5", { currency: "CAD", amountCents: 750, minimumConfirmed: false }, false],
    ["an amount under $5", { amountCents: 499 }, false],
    ["a payment after the window", { paidAt: new Date(policy.endsAt!) }, false],
  ])("rejects a patreon_api founder award for %s", async (_name, overrides, earlier) => {
    const { store, state, calls, query } = linked("patreon_api", overrides);
    state.earlier = earlier;
    await expect(
      store.mutate(memberId, founder(state.payments[0].id as string), staff, campaign, policy),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls('insert into "supporter_founders"')).toHaveLength(0);
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
  });
  it("accepts a non-USD patreon_api payment the import counted by its tier's price", async () => {
    const { store, state, calls } = linked("patreon_api", {
      currency: "CAD",
      amountCents: 750,
      minimumConfirmed: true,
    });
    await expect(
      store.mutate(memberId, founder(state.payments[0].id as string), staff, campaign, policy),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(calls('insert into "supporter_founders"')).toHaveLength(1);
  });
  it("applies the provider-neutral identity rule: a Patreon-filled Discord ID is enough, no identity is not", async () => {
    const discordOnly = linked("patreon_api");
    discordOnly.state.member.steamId = null;
    await expect(
      discordOnly.store.mutate(memberId, founder(discordOnly.state.payments[0].id as string), staff, campaign, policy),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    expect(discordOnly.calls('insert into "supporter_founders"')).toHaveLength(1);
    const unlinked = linked("patreon_api");
    Object.assign(unlinked.state.member, { discordId: null, steamId: null });
    await expect(
      unlinked.store.mutate(memberId, founder(unlinked.state.payments[0].id as string), staff, campaign, policy),
    ).rejects.toMatchObject({ status: 409, response: { blockedReason: "no_identity" } });
    expect(unlinked.calls('insert into "supporter_founders"')).toHaveLength(0);
  });
});
