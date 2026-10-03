import { createHash, randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import { supporterActions, supporterMembers, supporterPayments } from "../database/supporters.schema";
import { SupportersStore } from "./supporters.store";
import type { FounderPolicy, ManualMemberInput, PatreonObservation, SupporterMutation } from "./supporters.types";
import type { Staff } from "../admin/admin.types";

const id = randomUUID();
const staff: Staff = { id: "123456789012345678", name: "Admin", role: "admin", csrf: "csrf" };
const policy: FounderPolicy = {
  configured: true,
  amountCents: 500,
  currency: "USD",
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: "2026-09-16T00:00:00Z",
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
  const member = {
    id,
    campaignId: "123",
    patreonMemberId: "member-123",
    displayName: "Supporter",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: new Date("2026-09-10T00:00:00Z"),
    observedAt: new Date(),
    reviewState: "verified",
    discordId: staff.id,
    steamId: "76561198000000001",
    version: 3,
  };
  const payment = {
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
    action: Record<string, unknown> | null;
  } = {
    duplicate: false,
    manualDuplicate: false,
    earlier: false,
    action: null,
  };
  const query = jest.fn(async (config: { text: string }, _params: unknown[]) => {
    if (config.text.startsWith('insert into "supporter_members"') && config.text.includes("returning"))
      return { rows: state.manualDuplicate ? [] : [[id]] };
    if (config.text.includes('from "supporter_members"') && config.text.endsWith("for update"))
      return { rows: [row(supporterMembers, member)] };
    if (config.text.includes('from "supporter_actions"'))
      return { rows: state.action ? [row(supporterActions, state.action)] : [] };
    if (config.text.startsWith('select "id" from "supporter_payments"'))
      return { rows: state.earlier ? [[randomUUID()]] : [] };
    if (config.text.includes('from "supporter_payments"')) return { rows: [row(supporterPayments, payment)] };
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
    expect(statement.text).toContain("WHERE m.campaign_id =");
    expect(statement.text).toContain("strpos(lower(coalesce(m.display_name, ''))");
    expect(statement.text).toContain("strpos(lower(m.patreon_member_id)");
    expect(statement.text).toContain("strpos(coalesce(m.discord_id, '')");
    expect(statement.text).toContain("strpos(coalesce(m.steam_id, '')");
    expect(statement.text.indexOf("strpos(")).toBeLessThan(statement.text.indexOf("LIMIT 100"));
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
  it.each(["low", "end", "before", "signed", "not-first", "unlinked", "invalid-steam", "earlier"])(
    "rejects founder award for %s evidence",
    async (caseName) => {
      const { store, query, payment, member, state } = fixture();
      if (caseName === "low") payment.amountCents = 499;
      if (caseName === "end") payment.paidAt = new Date(policy.endsAt!);
      if (caseName === "before") payment.paidAt = new Date("2026-08-31T23:59:59Z");
      if (caseName === "signed") payment.source = "signed_status";
      if (caseName === "not-first") payment.firstSuccessfulPaymentVerified = false;
      if (caseName === "unlinked") member.discordId = "";
      if (caseName === "invalid-steam") member.steamId = "76561190000000001";
      if (caseName === "earlier") state.earlier = true;
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
      ).rejects.toMatchObject({ status: 409 });
      expect(query.mock.calls.some(([config]) => config.text.startsWith('insert into "supporter_founders"'))).toBe(
        false,
      );
      expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
    },
  );
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
