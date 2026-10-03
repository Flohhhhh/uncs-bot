import { randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { supporterMembers } from "../database/supporters.schema";
import {
  applicationFixture,
  FIXTURE_DISCORD_ID as discordId,
  FIXTURE_STEAM_ID as steamId,
  paymentFixture,
} from "./supporter-fixtures";
import type { MatchFacts } from "./supporter-match.rules";
import { SupporterMatchStore, type AutoMatchOptions } from "./supporter-match.store";
import type { FounderPolicy } from "./supporters.types";

const memberId = randomUUID();
const campaign = "123";
const policy: FounderPolicy = {
  configured: true,
  amountCents: 500,
  currency: "USD",
  startsAt: "2026-09-30T04:00:00.000Z",
  endsAt: "2026-10-15T04:00:00.000Z",
  source: "SUPPORTER_FOUNDER",
  automaticHoldHours: 72,
};
const now = new Date("2026-10-10T00:00:00.000Z");
function row(table: PgTable, value: Record<string, unknown>) {
  return Object.keys(getTableColumns(table)).map((key) =>
    value[key] instanceof Date ? (value[key] as Date).toISOString() : (value[key] ?? null),
  );
}
function fixture() {
  const member: Record<string, unknown> = {
    id: memberId,
    provider: "patreon",
    campaignId: campaign,
    patreonMemberId: "member-1",
    displayName: "Patron",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: new Date("2026-10-01T12:00:00.000Z"),
    observedAt: new Date(),
    reviewState: "pending",
    discordId,
    discordSource: "patreon",
    patreonDiscordId: discordId,
    steamId: null,
    steamSource: null,
    steamApplicationId: null,
    version: 4,
  };
  const state = {
    found: true,
    founder: false,
    otherFounder: false,
    earlier: false,
    // A staff link of the same SteamID committed first, so the conditional fill matches no row.
    lost: false,
    facts: {
      applications: [applicationFixture()],
      automatic: { payment: paymentFixture(), earlier: false, earlierOtherRecord: false },
      discordReportedForOtherPatron: false,
      patreonDiscordElsewhere: false,
    } as MatchFacts,
  };
  const query = jest.fn(async (config: { text: string }, params: unknown[]) => {
    const text = config.text;
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.startsWith("select") && text.includes('from "supporter_members"') && text.endsWith("for update"))
      return { rows: state.found ? [row(supporterMembers, member)] : [] };
    if (text.startsWith("SELECT id FROM whitelist_applications")) return { rows: [] };
    if (text.includes("AS facts FROM supporter_members m")) return { rows: [{ facts: state.facts }] };
    if (text.startsWith('select "member_id" from "supporter_founders" where'))
      return { rows: state.founder ? [[memberId]] : [] };
    if (text.includes('from "supporter_founders" inner join'))
      return { rows: state.otherFounder ? [[randomUUID()]] : [] };
    if (text.startsWith('select "id" from "supporter_payments"'))
      return { rows: state.earlier ? [[randomUUID()]] : [] };
    if (text.startsWith('update "supporter_members" set "steam_id"')) {
      if (state.lost) return { rows: [] };
      Object.assign(member, { steamId: params[0], steamSource: params[1], steamApplicationId: params[2] });
      return { rows: [row(supporterMembers, member)] };
    }
    return { rows: [] };
  });
  const store = new SupporterMatchStore(drizzle({ query } as unknown as Client) as Database);
  const texts = () => query.mock.calls.map(([config]) => config.text);
  const calls = (prefix: string) => query.mock.calls.filter(([config]) => config.text.startsWith(prefix));
  const run = (options: Partial<AutoMatchOptions> = {}) =>
    store.autoMatch(memberId, {
      campaignId: campaign,
      policy,
      fillSteam: true,
      recordFounder: false,
      now,
      ...options,
    });
  return { store, query, member, state, texts, calls, run };
}
const writes = (texts: string[]) => texts.filter((text) => /^(insert|update)/.test(text));
const audit = (calls: [{ text: string }, unknown[]][]) =>
  calls.map(([, params]) => JSON.parse(params.find((value) => String(value).startsWith("{")) as string));

describe("automatic SteamID fill", () => {
  it("copies the SteamID under the member and application locks, with one audit row and one version bump", async () => {
    const { run, texts, calls } = fixture();
    expect(await run()).toMatchObject({ steamFilled: true, founderRecorded: false, blocked: [], discordId });
    const all = texts();
    const lock = all.findIndex((text) => text.endsWith("for update"));
    const share = all.findIndex((text) => text.startsWith("SELECT id FROM whitelist_applications"));
    const fill = all.findIndex((text) => text.startsWith('update "supporter_members" set "steam_id"'));
    expect(all[0]).toBe("begin");
    expect(lock).toBeLessThan(share);
    expect(share).toBeLessThan(fill);
    expect(all[share]).toContain("ORDER BY id FOR SHARE");
    expect(all[fill]).toContain('"supporter_members"."steam_id" is null');
    const [[, fillParams]] = calls('update "supporter_members" set "steam_id"');
    expect(fillParams.slice(0, 3)).toEqual([steamId, "application", applicationFixture().id]);
    const [version, ...others] = calls('update "supporter_members" set "version"');
    expect(others).toHaveLength(0);
    expect(version[1]).toEqual([5, memberId]);
    const actions = calls('insert into "supporter_actions"');
    expect(actions).toHaveLength(1);
    expect(actions[0][1]).toEqual(
      expect.arrayContaining(["system:supporter-match", "Automatic supporter match", "application-steam-link"]),
    );
    expect(audit(actions)[0]).toEqual({
      steamId,
      applicationId: applicationFixture().id,
      applicationServerId: "primary",
      discordId,
      discordSource: "patreon",
      whitelistGrant: "granted",
      previousSteamId: null,
    });
    expect(all.at(-1)).toBe("commit");
    expect(all.some((text) => text.startsWith('insert into "supporter_founders"'))).toBe(false);
  });
  it.each([
    ["staff", { steamId, steamSource: "staff" }],
    ["an application", { steamId, steamSource: "application", steamApplicationId: applicationFixture().id }],
    ["an older unlabelled link", { steamId, steamSource: null }],
  ])("never overwrites a SteamID from %s", async (_name, change) => {
    const { run, member, texts } = fixture();
    Object.assign(member, change);
    expect(await run()).toMatchObject({ steamFilled: false, blocked: [] });
    expect(writes(texts())).toEqual([]);
  });
  it("writes nothing when the conditional fill lost a race with a staff link", async () => {
    const { run, state, texts } = fixture();
    state.lost = true;
    expect(await run()).toMatchObject({ steamFilled: false });
    expect(writes(texts())).toEqual([expect.stringMatching(/^update "supporter_members" set "steam_id"/)]);
  });
  it.each([
    ["application_in_progress", [applicationFixture({ status: "needs_review" })]],
    ["application_not_confirmed", [applicationFixture({ whitelistGrant: null })]],
    ["steam_shared", [applicationFixture({ otherDiscordClaim: true })]],
    ["steam_rejected_before", [applicationFixture({ rejectedBefore: true })]],
    ["steam_on_another_record", [applicationFixture({ otherSupporter: true })]],
    ["no_application", []],
  ])("refuses to copy a SteamID: %s", async (reason, applications) => {
    const { run, state, texts } = fixture();
    state.facts.applications = applications;
    expect(await run()).toMatchObject({ steamFilled: false, blocked: [reason] });
    expect(writes(texts())).toEqual([]);
  });
  it.each([
    ["a PayPal record", { provider: "paypal", campaignId: null, patreonMemberId: null }],
    ["another campaign", { campaignId: "456" }],
  ])("skips %s without reading applications", async (_name, change) => {
    const { run, member, texts } = fixture();
    Object.assign(member, change);
    expect(await run()).toMatchObject({ skipped: true, steamFilled: false });
    expect(texts().some((text) => text.includes("whitelist_applications"))).toBe(false);
    expect(writes(texts())).toEqual([]);
  });
  it("needs a Discord account", async () => {
    const { run, member, texts } = fixture();
    Object.assign(member, { discordId: null, discordSource: null });
    expect(await run()).toMatchObject({ blocked: ["no_discord"] });
    expect(texts().some((text) => text.includes("whitelist_applications"))).toBe(false);
  });
  it("gives a founder a SteamID only when no other founder holds it, after locking it", async () => {
    const { run, state, query, texts } = fixture();
    state.founder = true;
    state.otherFounder = true;
    expect(await run({ recordFounder: true })).toMatchObject({ steamFilled: false, blocked: ["already_founder"] });
    const lock = query.mock.calls.find(([config]) => config.text.includes("pg_advisory_xact_lock"))!;
    expect(lock[1]).toEqual([`founder:steam:${steamId}`]);
    expect(writes(texts())).toEqual([]);
    const allowed = fixture();
    allowed.state.founder = true;
    expect(await allowed.run({ recordFounder: true })).toMatchObject({ steamFilled: true, founderRecorded: false });
  });
  it("only reads when neither step is switched on", async () => {
    const { run, texts } = fixture();
    expect(await run({ fillSteam: false })).toMatchObject({ steamFilled: false, founderRecorded: false, blocked: [] });
    expect(writes(texts())).toEqual([]);
  });
});

describe("automatic founder promise", () => {
  const ready = () => {
    const result = fixture();
    Object.assign(result.member, { steamId, steamSource: "staff" });
    return result;
  };
  it("records it with the system actor after the staff founder rule, under sorted locks taken after the member lock", async () => {
    const { run, texts, calls, query } = ready();
    expect(await run({ recordFounder: true })).toMatchObject({ founderRecorded: true, blocked: [] });
    const all = texts();
    const member = all.findIndex((text) => text.endsWith("for update"));
    const locks = query.mock.calls.filter(([config]) => config.text.includes("pg_advisory_xact_lock"));
    expect(locks.map(([, params]) => params[0])).toEqual([`founder:discord:${discordId}`, `founder:steam:${steamId}`]);
    expect(all.findIndex((text) => text.includes("pg_advisory_xact_lock"))).toBeGreaterThan(member);
    // founderCheck: the earlier-payment query and the cross-record founder check run before the insert.
    const earlier = all.findIndex((text) => text.startsWith('select "id" from "supporter_payments"'));
    const other = all.findIndex((text) => text.includes('from "supporter_founders" inner join'));
    const insert = all.findIndex((text) => text.startsWith('insert into "supporter_founders"'));
    expect(Math.max(earlier, other)).toBeLessThan(insert);
    const [[, founderValues]] = calls('insert into "supporter_founders"');
    expect(founderValues).toEqual(
      expect.arrayContaining([memberId, paymentFixture().id, "system:supporter-match", policy.startsAt, policy.endsAt]),
    );
    const actions = calls('insert into "supporter_actions"');
    expect(actions[0][1]).toEqual(expect.arrayContaining(["system:supporter-match", "founder"]));
    expect(audit(actions)[0]).toEqual({
      paymentId: paymentFixture().id,
      paymentSource: "patreon_api",
      reference: "pledge_start:1",
      windowStart: policy.startsAt,
      windowEnd: policy.endsAt,
      discordId,
      steamId,
      discordSource: "patreon",
      steamSource: "staff",
      automatic: 1,
    });
    expect(calls('update "supporter_members" set "version"')).toHaveLength(1);
  });
  it("copies the SteamID and records the founder in one run, locking and checking the new SteamID", async () => {
    const { run, query, calls } = fixture();
    expect(await run({ recordFounder: true })).toMatchObject({ steamFilled: true, founderRecorded: true });
    const locks = query.mock.calls.filter(([config]) => config.text.includes("pg_advisory_xact_lock"));
    expect(locks.map(([, params]) => params[0])).toContain(`founder:steam:${steamId}`);
    const facts = query.mock.calls.filter(([config]) => config.text.includes("AS facts FROM supporter_members m"));
    expect(facts).toHaveLength(2);
    expect(calls('insert into "supporter_actions"')).toHaveLength(2);
    expect(calls('update "supporter_members" set "version"')).toHaveLength(1);
  });
  it.each([
    [
      "the staff rule's earlier payment",
      (f: ReturnType<typeof fixture>) => (f.state.earlier = true),
      "earlier_payment",
    ],
    ["another founder", (f: ReturnType<typeof fixture>) => (f.state.otherFounder = true), "already_founder"],
    [
      "a payment outside the window",
      (f: ReturnType<typeof fixture>) =>
        (f.state.facts.automatic!.payment = paymentFixture({ paidAt: "2026-10-15T04:00:00.000Z" })),
      "outside_window",
    ],
  ])("refuses a promise blocked by %s after taking the locks", async (_name, change, reason) => {
    const f = ready();
    change(f);
    expect(await f.run({ recordFounder: true, now: new Date("2026-10-30T00:00:00Z") })).toMatchObject({
      founderRecorded: false,
      blocked: [reason],
    });
    expect(f.texts().some((text) => text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(writes(f.texts())).toEqual([]);
  });
  it.each([
    ["a staff-entered Discord account", { discordSource: "staff" }, {}, "discord_not_from_patreon"],
    ["a Discord account Patreon no longer reports", { patreonDiscordId: null }, {}, "discord_differs"],
    ["no imported first payment", {}, { automatic: null }, "no_patreon_payment"],
    [
      "a reversed charge",
      { lastChargeStatus: "Refunded", lastChargeAt: new Date("2026-10-05T00:00:00Z") },
      {},
      "charge_reversed",
    ],
    [
      "a revoked source application",
      { steamSource: "application", steamApplicationId: applicationFixture().id },
      { applications: [applicationFixture({ status: "revoked", accessIntent: "revoke" })] },
      "source_application_revoked",
    ],
  ])("refuses %s without taking founder locks", async (_name, memberChange, facts, reason) => {
    const f = ready();
    Object.assign(f.member, memberChange);
    Object.assign(f.state.facts, facts);
    expect(await f.run({ recordFounder: true, fillSteam: false })).toMatchObject({ blocked: [reason] });
    expect(f.texts().some((text) => text.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(writes(f.texts())).toEqual([]);
  });
  it("waits for the payment to pass the hold", async () => {
    const f = ready();
    expect(
      await f.run({ recordFounder: true, now: new Date(Date.parse(paymentFixture().paidAt) + 3_600_000) }),
    ).toMatchObject({ founderRecorded: false, blocked: ["payment_too_recent"] });
  });
  it("writes nothing on a second run once the founder exists", async () => {
    const f = ready();
    f.state.founder = true;
    expect(await f.run({ recordFounder: true })).toMatchObject({
      steamFilled: false,
      founderRecorded: false,
      blocked: [],
    });
    expect(writes(f.texts())).toEqual([]);
  });
});

describe("automatic matching queries", () => {
  it("lists only Patreon records of the campaign that a switched-on step could change, wrapping after a cursor", async () => {
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [{ id: "b" }] }));
    const store = new SupporterMatchStore(drizzle({ query } as unknown as Client) as Database);
    expect(await store.candidates(campaign, policy, { fillSteam: false, recordFounder: false }, null, 10)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(await store.candidates(campaign, policy, { fillSteam: true, recordFounder: true }, "a", 10)).toEqual([
      "b",
      "b",
    ]);
    const [[first, firstValues], [second]] = query.mock.calls;
    expect(first.text).toContain("WHERE m.provider = 'patreon' AND m.campaign_id = $1 AND m.discord_id IS NOT NULL");
    expect(first.text).toContain("m.steam_id IS NULL AND EXISTS (SELECT 1 FROM whitelist_applications a");
    expect(first.text).toContain("NOT EXISTS (SELECT 1 FROM supporter_founders f WHERE f.member_id = m.id)");
    expect(first.text).toContain("p.source = 'patreon_api'");
    expect(first.text).toContain("AND m.id > $");
    expect(first.text).toContain("ORDER BY m.id LIMIT");
    expect(firstValues).toEqual(expect.arrayContaining([campaign, policy.startsAt, policy.endsAt, "a", 10]));
    expect(second.text).toContain("AND m.id <= $");
    query.mockClear();
    await store.candidates(
      campaign,
      { ...policy, configured: false },
      { fillSteam: false, recordFounder: true },
      null,
      5,
    );
    expect(query).not.toHaveBeenCalled();
  });
  it("labels only unlabelled links, counting a staff Link only when it changed the Discord account", async () => {
    const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({ rows: [], rowCount: 2 }));
    const store = new SupporterMatchStore(drizzle({ query } as unknown as Client) as Database);
    expect(await store.backfillSources()).toEqual({ discord: 2, steam: 2 });
    const [[discord], [steam]] = query.mock.calls;
    expect(discord.text).toContain("WHERE m.discord_id IS NOT NULL AND m.discord_source IS NULL");
    expect(discord.text).toContain(
      "(a.kind = 'link' AND a.details->>'previousDiscordId' IS DISTINCT FROM a.details->>'discordId')",
    );
    expect(discord.text).toContain("= 'patreon-discord-link' THEN 'patreon'");
    expect(discord.text).toContain("WHEN m.provider = 'patreon'");
    expect(steam.text).toContain("SET steam_source = 'staff'");
    expect(steam.text).toContain("WHERE steam_id IS NOT NULL AND steam_source IS NULL");
    // Labels say where existing links came from; nothing about the links changes.
    expect(`${discord.text}${steam.text}`).not.toMatch(/version|supporter_actions \(|insert/i);
  });
});
