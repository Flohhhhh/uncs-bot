import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { OperationReceipts, ServiceCallError, ServiceClient } from "../src/index";
const token = "a".repeat(40);
test("validated reads use service credentials, no cookies or redirects", async () => {
  const calls: RequestInit[] = [];
  const client = new ServiceClient("http://api.test", token, 1000, async (_url, init) => {
    calls.push(init!);
    return Response.json({ ok: true });
  });
  assert.deepEqual(await client.request("/internal/v1/check", z.object({ ok: z.literal(true) })), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "error");
  assert.deepEqual(calls[0].headers, { authorization: `Bearer ${token}`, "content-type": "application/json" });
});
for (const [name, response] of [
  ["malformed", () => Response.json({ bad: true })],
  [
    "timeout",
    () => {
      throw new Error("lost response after commit");
    },
  ],
  ["upstream outage", () => Response.json({ message: "private" }, { status: 503 })],
] as const) {
  test(`${name} leaves mutation uncertain and is never retried`, async () => {
    let calls = 0;
    const client = new ServiceClient("http://api.test", token, 1000, async () => {
      calls++;
      return response();
    });
    await assert.rejects(
      client.request("/internal/v1/write", z.object({ ok: z.literal(true) }), { operationId: "one" }),
      (error) => error instanceof ServiceCallError && error.outcome === "unknown",
    );
    assert.equal(calls, 1);
  });
}
test("rejected credentials are a confirmed refusal", async () => {
  const client = new ServiceClient("http://api.test", token, 1000, async () =>
    Response.json({ message: "no" }, { status: 401 }),
  );
  await assert.rejects(
    client.request("/internal/v1/write", z.boolean(), {}),
    (error) => error instanceof ServiceCallError && error.outcome === "rejected",
  );
});
test("duplicate operation IDs share one result and different payloads are refused", async () => {
  const receipts = new OperationReceipts();
  let writes = 0;
  const write = async () => {
    writes++;
    return { committed: true };
  };
  const results = await Promise.all([
    receipts.run("one", { value: 1 }, write),
    receipts.run("one", { value: 1 }, write),
  ]);
  assert.deepEqual(results, [{ committed: true }, { committed: true }]);
  assert.equal(writes, 1);
  await assert.rejects(receipts.run("one", { value: 2 }, write));
  assert.equal(writes, 1);
});
test("unknown operation receipts do not run again", async () => {
  const receipts = new OperationReceipts();
  let writes = 0;
  const write = async () => {
    writes++;
    throw new Error("unconfirmed");
  };
  await assert.rejects(receipts.run("one", {}, write));
  await assert.rejects(receipts.run("one", {}, write));
  assert.equal(writes, 1);
});
