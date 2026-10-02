import { PgDialect } from "drizzle-orm/pg-core";
import { ApplicationsStore } from "./applications.store";
import type { Database } from "../database/database.types";
import { randomUUID } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import { drizzle } from "drizzle-orm/node-postgres";
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
