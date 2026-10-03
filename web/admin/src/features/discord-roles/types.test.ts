import { describe, expect, it } from "vitest";
import { adds, dryRun, ledgerRow, notes, pass, removal, rolesStatus } from "./test-fixtures";
import { validateReconcile, validateRolesStatus } from "./types";

const clone = <T>(value: T) => structuredClone(value) as T & Record<string, unknown>;

describe("validateRolesStatus", () => {
  it("accepts the status contract, including a status read before Discord connected", () => {
    const status = rolesStatus({ lastPass: pass(), lastFullPass: pass({ trigger: "schedule" }) });
    expect(validateRolesStatus(status)).toBe(status);
    const offline = rolesStatus({
      discordReady: false,
      ready: false,
      bot: { manageRoles: null, highestRolePosition: null },
      nextRetryAt: "2026-10-03T12:30:00.000Z",
      summary: { memberEligible: 0, founders: 0, foundersWithoutDiscord: 0, supporterEligible: 3 },
      recent: [],
      attention: [],
    });
    delete (offline as { note?: string }).note;
    expect(validateRolesStatus(offline)).toBe(offline);
  });

  it.each<[string, (value: Record<string, unknown>) => void]>([
    ["a text switch", (value) => (value.enabled = "false")],
    ["a missing configured flag", (value) => delete (value.configured as Record<string, unknown>).supporterRole],
    ["a missing role", (value) => delete (value.roles as Record<string, unknown>).supporter],
    ["a text Manage Roles answer", (value) => ((value.bot as Record<string, unknown>).manageRoles = "yes")],
    [
      "candidates that are not a list",
      (value) => ((value.roles as Record<string, Record<string, unknown>>).supporter.candidates = "Supporter"),
    ],
    ["a negative count", (value) => ((value.summary as Record<string, unknown>).founders = -1)],
    ["a missing supporter count", (value) => delete (value.summary as Record<string, unknown>).supporterEligible],
    ["a pass without counts", (value) => (value.lastPass = { ...pass(), added: undefined })],
    ["an unreadable retry time", (value) => (value.nextRetryAt = "soon")],
    ["attention that is not a list", (value) => (value.attention = {})],
    ["a Discord user ID that is not a snowflake", (value) => (value.recent = [ledgerRow(1, { discordUserId: "abc" })])],
    ["an unknown role kind", (value) => (value.recent = [{ ...ledgerRow(1), roleKind: "moderator" }])],
    ["a ledger row without a time", (value) => (value.recent = [{ ...ledgerRow(1), createdAt: null }])],
  ])("rejects %s", (_case, change) => {
    const value = clone(rolesStatus());
    change(value);
    expect(() => validateRolesStatus(value)).toThrow("The Discord roles status could not be verified.");
  });

  it("rejects a response that is not a status object", () => {
    for (const value of [null, [], "ok", { enabled: true }])
      expect(() => validateRolesStatus(value)).toThrow("The Discord roles status could not be verified.");
  });
});

describe("validateReconcile", () => {
  it("accepts a preview with its plan and a real run without one", () => {
    const preview = dryRun([...adds, removal, ...notes]);
    expect(validateReconcile(preview, true)).toBe(preview);
    const run = { ok: true, replayed: true, summary: pass({ trigger: "admin" }) };
    expect(validateReconcile(run, false)).toBe(run);
  });

  it("rejects a result that does not match the request", () => {
    expect(() => validateReconcile({ ...dryRun(adds), ok: false }, true)).toThrow(/Nothing was changed/);
    // A real run must never be reported back as a dry run, or the other way round.
    expect(() => validateReconcile(dryRun(adds), false)).toThrow(/check Recent role changes/);
    expect(() => validateReconcile({ ok: true, replayed: false, summary: pass() }, true)).toThrow(/preview again/);
    const missingPlan = dryRun(adds);
    delete missingPlan.summary.plan;
    expect(() => validateReconcile(missingPlan, true)).toThrow();
    const tooLong = dryRun(Array.from({ length: 101 }, () => adds[0]));
    expect(() => validateReconcile(tooLong, true)).toThrow();
    expect(() => validateReconcile(dryRun([{ ...removal, discordUserId: "<b>" }]), true)).toThrow();
  });
});
