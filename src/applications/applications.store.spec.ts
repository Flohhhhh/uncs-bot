import { PgDialect } from "drizzle-orm/pg-core";
import { ApplicationsStore } from "./applications.store";
import type { Database } from "../database/database.types";
import { randomUUID } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../database/schema";

describe("atomic application review persistence", () => {
  const staff: Staff = { id: "123456789012345678", name: "Reviewer", role: "admin", csrf: "csrf" };
  it("keeps older unresolved requests ahead of resolved history in a bounded review batch", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const db = drizzle({ client: { query } as never, schema });
    await new ApplicationsStore(db as unknown as Database).list();
    const [statement, parameters] = query.mock.calls[0];
    expect(statement.text).toContain(
      'order by case when "whitelist_applications"."status" in ($2, $3, $4) then 0 else 1 end',
    );
    expect(statement.text).toContain('then "whitelist_applications"."submitted_at" end asc');
    expect(statement.text).toContain(
      '"whitelist_applications"."submitted_at" desc, "whitelist_applications"."id" asc limit $8',
    );
    expect(parameters).toEqual([
      "primary",
      "pending",
      "processing",
      "needs_review",
      "pending",
      "processing",
      "needs_review",
      100,
    ]);
  });
  it("claims only pending requests and writes its review in the same transaction", async () => {
    const applicationId = randomUUID(),
      actionId = randomUUID();
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([
        {
          id: applicationId,
          status: "processing",
          lastActionState: "started",
          lastActionMessage: "Approval started",
        },
      ]),
    });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
    const tx = { update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }), insert };
    const db = { transaction: jest.fn(async (callback) => callback(tx)) };
    const store = new ApplicationsStore(db as unknown as Database);
    const result = await store.claim(applicationId, { id: actionId, reason: "Reviewed evidence" }, "approve", staff);
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toContain('"whitelist_applications"."status"');
    expect(query.params).toEqual([applicationId, "primary", "pending"]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(result.claimed).toBe(true);
  });
  it("matches the original claim ID and processing state before finalizing", async () => {
    const applicationId = randomUUID(),
      actionId = randomUUID();
    const where = jest
      .fn()
      .mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: applicationId, status: "approved" }]) });
    const reviewWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: actionId }]) });
    const update = jest
      .fn()
      .mockReturnValueOnce({ set: jest.fn().mockReturnValue({ where }) })
      .mockReturnValueOnce({ set: jest.fn().mockReturnValue({ where: reviewWhere }) });
    const db = { transaction: jest.fn(async (callback) => callback({ update })) };
    await new ApplicationsStore(db as unknown as Database).finishApproval(applicationId, actionId, {
      state: "applied",
      message: "Confirmed",
    });
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toEqual([applicationId, "processing", actionId]);
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("whitelist revocation persistence", () => {
  const staff: Staff = { id: "123456789012345678", name: "Reviewer", role: "admin", csrf: "csrf", serverId: "primary" };
  const applicationId = randomUUID();
  const application = (overrides: Record<string, unknown> = {}) => ({
    id: applicationId,
    serverId: "primary",
    discordUserId: "234567890123456789",
    discordDisplayName: "Member",
    steamId: "76561198123456789",
    relationship: "unc_member",
    contactConsent: true,
    consentVersion: "v1",
    rulesAcceptedAt: new Date(),
    status: "revoking",
    accessIntent: "revoke",
    lastActionMessage: "Revocation started. The running whitelist has not yet been confirmed.",
    submittedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  const row = (value: Record<string, unknown>) =>
    Object.keys(getTableColumns(schema.whitelistApplications)).map((key) =>
      value[key] instanceof Date ? (value[key] as Date).toISOString() : (value[key] ?? null),
    );
  function fixture(options: { updated?: Record<string, unknown>[]; reviewed?: boolean } = {}) {
    const query = jest.fn(async (config: { text: string }, _params: unknown[]) => {
      if (config.text.startsWith('update "whitelist_applications"'))
        return { rows: (options.updated ?? [application()]).map(row) };
      if (config.text.startsWith('update "whitelist_application_reviews"'))
        return { rows: options.reviewed === false ? [] : [[randomUUID()]] };
      return { rows: [] };
    });
    const db = drizzle({ client: { query } as never, schema });
    const find = (prefix: string) => query.mock.calls.find(([config]) => config.text.startsWith(prefix))!;
    return { store: new ApplicationsStore(db as unknown as Database), query, find };
  }
  it("claims a revocation only from approved, or after an uncertain revocation, with its receipt in one transaction", async () => {
    const { store, query, find } = fixture();
    const review = { id: randomUUID(), reason: "Left the community" };
    await expect(store.claimRevoke(applicationId, review, staff)).resolves.toMatchObject({ claimed: true });
    const [update, params] = find('update "whitelist_applications"');
    expect(update.text).toContain('"status" = $');
    expect(params).toEqual(
      expect.arrayContaining(["revoking", "revoke", applicationId, "primary", "approved", "needs_review"]),
    );
    const [, receipt] = find('insert into "whitelist_application_reviews"');
    expect(receipt).toEqual(expect.arrayContaining([review.id, applicationId, "revoke", staff.id, "started"]));
    expect(query.mock.calls[0][0].text).toBe("begin");
    expect(query.mock.calls.at(-1)![0].text).toBe("commit");
  });
  it.each([
    ["applied", "revoked"],
    ["pending", "revoked"],
    ["failed", "approved"],
    ["unknown", "needs_review"],
  ] as const)("finishes a %s removal as %s, matching the original claim", async (state, status) => {
    const { store, find } = fixture();
    const actionId = randomUUID();
    await store.finishRevoke(applicationId, actionId, { state, message: "Result" });
    const [update, params] = find('update "whitelist_applications"');
    expect(params).toEqual(expect.arrayContaining([status, applicationId, "revoking", actionId]));
    expect(update.text.includes('"revoked_at" =')).toBe(status === "revoked");
    expect(params.includes("grant")).toBe(state === "failed");
    const [, reviewParams] = find('update "whitelist_application_reviews"');
    expect(reviewParams).toEqual(expect.arrayContaining([state, actionId, applicationId, "revoke", "started"]));
  });
  it("refuses a revocation completion that no longer matches its claim", async () => {
    const { store, query } = fixture({ reviewed: false });
    await expect(
      store.finishRevoke(applicationId, randomUUID(), { state: "applied", message: "Result" }),
    ).rejects.toThrow("no longer matches");
    expect(query.mock.calls.at(-1)![0].text).toBe("rollback");
  });
  it("revokes only the approved application for a SteamID removed on the Whitelist page", async () => {
    const { store, find } = fixture({ updated: [application({ status: "revoked" })] });
    const actionId = randomUUID();
    const revoked = await store.recordExternalRevoke({
      serverId: "primary",
      steamId: "76561198123456789",
      actionId,
      actorId: staff.id,
      actorName: staff.name,
      state: "applied",
    });
    expect(revoked).toHaveLength(1);
    const [, params] = find('update "whitelist_applications"');
    expect(params).toEqual(expect.arrayContaining(["revoked", "primary", "76561198123456789", "approved"]));
    const [, receipt] = find('insert into "whitelist_application_reviews"');
    expect(receipt).toEqual(
      expect.arrayContaining([
        applicationId,
        "revoke",
        staff.id,
        staff.name,
        `Removed from the Whitelist page (action ${actionId}).`,
        "applied",
      ]),
    );
  });
  it("writes no receipt when no approved application matches the removed SteamID", async () => {
    const { store, query } = fixture({ updated: [] });
    await expect(
      store.recordExternalRevoke({
        serverId: "primary",
        steamId: "76561198123456789",
        actionId: randomUUID(),
        actorId: staff.id,
        actorName: staff.name,
        state: "pending",
      }),
    ).resolves.toEqual([]);
    expect(query.mock.calls.some(([config]) => config.text.startsWith("insert"))).toBe(false);
  });
  it("finishes a revocation readback as revoked and keeps the intent in its match", async () => {
    const { store, find } = fixture();
    const previous = application({ status: "needs_review", reviewId: randomUUID() });
    await store.finishRecheck(previous as never, { id: randomUUID(), reason: "Check" }, staff, {
      state: "applied",
      message: "Removed",
    });
    const [update, params] = find('update "whitelist_applications"');
    expect(update.text).toContain('"revoked_at" =');
    expect(update.text).toContain('"access_intent" =');
    expect(params).toEqual(expect.arrayContaining(["revoked", "revoke", "revoking"]));
  });
  it("records how an approval was achieved only when it applied", async () => {
    const { store, find } = fixture({ updated: [application({ status: "approved" })] });
    await store.finishApproval(applicationId, randomUUID(), { state: "applied", message: "Registered" }, "existing");
    expect(find('update "whitelist_applications"')[1]).toContain("existing");
    const second = fixture({ updated: [application({ status: "needs_review" })] });
    await second.store.finishApproval(applicationId, randomUUID(), { state: "pending", message: "Saved" }, "granted");
    expect(second.find('update "whitelist_applications"')[1]).not.toContain("granted");
  });
});
