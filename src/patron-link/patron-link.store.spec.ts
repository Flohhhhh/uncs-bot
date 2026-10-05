import { randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { supporterMembers } from "../database/supporters.schema";
import { PATRON_LINK_ACTOR, PATRON_LINK_CONFLICT_REPEAT_MS, PatronLinkStore } from "./patron-link.store";

const memberId = randomUUID();
const campaign = "16880209";
const patron = "500000000000000001";
const otherDiscord = "500000000000000002";
const now = new Date("2026-10-05T12:00:00.000Z");
const input = { campaignId: campaign, patreonMemberId: "member-1", discordId: patron, now };

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
    observedAt: new Date("2026-10-01T12:00:00.000Z"),
    reviewState: "pending",
    discordId: null,
    discordSource: null,
    patreonDiscordId: null,
    steamId: null,
    steamSource: null,
    steamApplicationId: null,
    version: 3,
  };
  const state = {
    created: false,
    holder: false,
    founder: false,
    otherFounder: false,
    waiting: false,
    // Another record of the campaign committed this Discord account after the check: the update hits the index.
    raced: false,
    payments: [["patreon_api", "2026-10-01T12:00:00.000Z", 500, "USD", false]] as unknown[][],
  };
  const query = jest.fn(async (config: { text: string }, _params: unknown[]) => {
    const text = config.text;
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.startsWith('insert into "supporter_members"')) return { rows: state.created ? [[memberId]] : [] };
    if (text.startsWith("select") && text.includes('from "supporter_members"') && text.endsWith("for update"))
      return { rows: [row(supporterMembers, member)] };
    if (text.startsWith('select "id" from "supporter_members"')) return { rows: state.holder ? [[randomUUID()]] : [] };
    if (text.startsWith('select "member_id" from "supporter_founders" where'))
      return { rows: state.founder ? [[memberId]] : [] };
    if (text.includes('from "supporter_founders" inner join'))
      return { rows: state.otherFounder ? [[randomUUID()]] : [] };
    if (text.startsWith('select "id" from "supporter_actions"')) return { rows: state.waiting ? [[randomUUID()]] : [] };
    if (text.startsWith('update "supporter_members"')) {
      if (state.raced) throw Object.assign(new Error("duplicate key value"), { code: "23505" });
      return { rows: [[memberId]] };
    }
    if (text.startsWith('select "source", "paid_at"')) return { rows: state.payments };
    return { rows: [] };
  });
  const store = new PatronLinkStore(drizzle({ query } as unknown as Client) as Database);
  const texts = () => query.mock.calls.map(([config]) => config.text);
  const calls = (prefix: string) => query.mock.calls.filter(([config]) => config.text.startsWith(prefix));
  const audits = () =>
    calls('insert into "supporter_actions"').map(([, params]) => ({
      params,
      details: JSON.parse(params.find((value) => String(value).startsWith("{")) as string),
    }));
  return { store, query, member, state, texts, calls, audits };
}
const writes = (texts: string[]) => texts.filter((text) => /^(update|insert into "supporter_actions")/.test(text));

describe("linking a membership after the patron's sign-in", () => {
  it("fills the empty link as patron_signin, bumps the version once and writes one audit row, under the row lock", async () => {
    const { store, texts, calls, audits } = fixture();
    expect(await store.link(input)).toEqual({ outcome: "linked", memberId });
    const all = texts();
    expect(all[0]).toBe("begin");
    expect(all.at(-1)).toBe("commit");
    const lock = all.findIndex((text) => text.endsWith("for update"));
    const update = all.findIndex((text) => text.startsWith('update "supporter_members"'));
    expect(lock).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(lock);
    const [[statement, values]] = calls('update "supporter_members"');
    expect(statement.text).toBe(
      'update "supporter_members" set "discord_id" = $1, "discord_source" = $2, "version" = $3 where ("supporter_members"."id" = $4 and "supporter_members"."discord_id" is null) returning "id"',
    );
    expect(values).toEqual([patron, "patron_signin", 4, memberId]);
    const [audit] = audits();
    expect(audits()).toHaveLength(1);
    expect(audit.params).toEqual(
      expect.arrayContaining([
        memberId,
        PATRON_LINK_ACTOR.id,
        "Linked by patron",
        "patron-discord-link",
        "The patron signed in to Discord and Patreon to link this membership.",
        now.toISOString(),
      ]),
    );
    expect(audit.details).toEqual({
      discordId: patron,
      previousDiscordId: null,
      patreonMemberId: "member-1",
      patreonDiscordId: null,
      memberCreated: 0,
    });
  });
  it("creates the import's minimal row for a membership the import has not seen, and says so", async () => {
    const { store, state, calls, audits } = fixture();
    state.created = true;
    state.payments = [];
    expect(await store.link(input)).toEqual({ outcome: "pending", memberId });
    const [[statement, values]] = calls('insert into "supporter_members"');
    expect(statement.text).toContain("on conflict do nothing");
    expect(values).toEqual([expect.any(String), campaign, "member-1", now.toISOString()]);
    expect(audits()[0].details.memberCreated).toBe(1);
  });
  it("says pending until the record supports by the Supporter role's rule", async () => {
    for (const [change, outcome] of [
      [{ patronStatus: "former_patron" }, "pending"],
      [{ lastChargeStatus: "Refunded" }, "pending"],
      [{ patronStatus: "declined_patron", lastChargeAt: new Date("2026-10-01T12:00:00.000Z") }, "linked"],
    ] as const) {
      const f = fixture();
      Object.assign(f.member, change);
      expect((await f.store.link(input)).outcome).toBe(outcome);
    }
  });
  it("writes nothing for an account the record already links", async () => {
    const { store, member, texts } = fixture();
    member.discordId = patron;
    member.discordSource = "patreon";
    expect(await store.link(input)).toEqual({ outcome: "already", memberId });
    expect(writes(texts())).toEqual([]);
  });
  it("never replaces another account, and records the refusal with both accounts", async () => {
    const { store, member, texts, audits } = fixture();
    member.discordId = otherDiscord;
    member.discordSource = "staff";
    expect(await store.link(input)).toEqual({ outcome: "conflict", conflict: "membership_linked", memberId });
    expect(texts().some((text) => text.startsWith("update"))).toBe(false);
    const [audit] = audits();
    expect(audit.params).toEqual(
      expect.arrayContaining([
        "patron-link-conflict",
        "A patron sign-in matched this membership, but the link was refused.",
        PATRON_LINK_ACTOR.id,
      ]),
    );
    expect(audit.details).toEqual({
      discordId: patron,
      conflict: "membership_linked",
      linkedDiscordId: otherDiscord,
      patreonMemberId: "member-1",
    });
  });
  it("never takes an account another Patreon record of the campaign links, while a PayPal record does not block", async () => {
    const { store, state, calls, audits } = fixture();
    state.holder = true;
    expect(await store.link(input)).toEqual({ outcome: "conflict", conflict: "discord_linked", memberId });
    const [[statement, values]] = calls('select "id" from "supporter_members"');
    expect(statement.text).toContain('"supporter_members"."provider" = $1');
    expect(values).toEqual(["patreon", campaign, patron, memberId, 1]);
    expect(audits()[0].details).toMatchObject({ conflict: "discord_linked", linkedDiscordId: null });
  });
  it("gives a founder record no account another founder holds, after locking that account", async () => {
    const { store, state, query, texts, audits } = fixture();
    state.founder = true;
    state.otherFounder = true;
    expect(await store.link(input)).toEqual({ outcome: "conflict", conflict: "founder_tie", memberId });
    const locks = query.mock.calls.filter(([config]) => config.text.includes("pg_advisory_xact_lock"));
    expect(locks.map(([, params]) => params[0])).toEqual([`founder:discord:${patron}`]);
    const all = texts();
    expect(all.findIndex((text) => text.includes("pg_advisory_xact_lock"))).toBeLessThan(
      all.findIndex((text) => text.includes('from "supporter_founders" inner join')),
    );
    expect(audits()[0].details.conflict).toBe("founder_tie");
    const free = fixture();
    free.state.founder = true;
    expect((await free.store.link(input)).outcome).toBe("linked");
    // No founder on this record: no founder check, no lock.
    const plain = fixture();
    await plain.store.link(input);
    expect(plain.texts().some((text) => text.includes("pg_advisory_xact_lock"))).toBe(false);
  });
  it("records the same waiting refusal once a day", async () => {
    const { store, state, member, calls, audits } = fixture();
    member.discordId = otherDiscord;
    state.waiting = true;
    expect((await store.link(input)).outcome).toBe("conflict");
    expect(audits()).toHaveLength(0);
    const [[statement, values]] = calls('select "id" from "supporter_actions"');
    expect(statement.text).toContain(`"supporter_actions"."details"->>'discordId' = $`);
    expect(statement.text).toContain(`"supporter_actions"."details"->>'conflict' = $`);
    expect(statement.text).toContain(`"supporter_actions"."created_at" > $`);
    // A later staff link or "Keep accounts" review, a later Discord link, or the import moving the account off the
    // record settles the earlier refusal, so it is recorded again. The Supporters page settles it by the same rule.
    expect(statement.text).toContain(
      `settled.kind IN ('link', 'review', 'patron-discord-link', 'patreon-discord-link', 'patreon-discord-moved') AND settled.created_at > "supporter_actions"."created_at")`,
    );
    expect(values).toEqual(
      expect.arrayContaining([
        patron,
        "membership_linked",
        new Date(now.getTime() - PATRON_LINK_CONFLICT_REPEAT_MS).toISOString(),
      ]),
    );
  });
  it("turns a lost race for the account into a recorded refusal, in a transaction of its own", async () => {
    const { store, state, texts, audits } = fixture();
    state.raced = true;
    expect(await store.link(input)).toEqual({ outcome: "conflict", conflict: "discord_linked", memberId });
    const all = texts();
    expect(all.filter((text) => text === "begin")).toHaveLength(2);
    expect(all.filter((text) => text === "rollback")).toHaveLength(1);
    expect(all.at(-1)).toBe("commit");
    expect(audits().map((audit) => audit.details.conflict)).toEqual(["discord_linked"]);
    expect(
      audits()
        .map(({ params }) => params)
        .flat(),
    ).not.toContain("patron-discord-link");
  });
  it("passes any other database failure on", async () => {
    const { store, query } = fixture();
    query.mockImplementation(async (config: { text: string }) => {
      if (config.text.startsWith('update "supporter_members"')) throw new Error("connection lost");
      if (config.text.startsWith("select") && config.text.endsWith("for update"))
        return { rows: [row(supporterMembers, fixture().member)] };
      return { rows: [] };
    });
    await expect(store.link(input)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "connection lost" }),
    });
  });
});

describe("whether a Discord account is linked already", () => {
  it("looks only at Patreon records of the campaign", async () => {
    const { store, calls } = fixture();
    expect(await store.linked(campaign, patron)).toBe(false);
    const [[statement, values]] = calls('select "id" from "supporter_members"');
    expect(statement.text).toContain('"supporter_members"."provider" = $1');
    expect(values).toEqual(["patreon", campaign, patron, 1]);
  });
});
