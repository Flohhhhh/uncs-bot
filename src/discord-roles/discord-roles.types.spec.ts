import {
  PAYPAL_SUPPORT_MS,
  SUPPORTER_DECLINE_GRACE_MS,
  supportActive,
  type SupportFacts,
} from "../supporters/supporters.types";
import { classifyDiscordError, decide, ROLE_REASONS, type LedgerEntry, type RoleFacts } from "./discord-roles.types";

const joinedAt = new Date("2026-10-01T12:00:00Z");
const entry = (
  operation: LedgerEntry["operation"],
  state: LedgerEntry["state"],
  changed: boolean,
  at = "2026-10-02T00:00:00Z",
): LedgerEntry => ({
  id: `${operation}-${state}`,
  operation,
  state,
  changed,
  createdAt: new Date(at),
});
const facts = (overrides: Partial<RoleFacts>): RoleFacts => ({
  kind: "member",
  desiredBasis: null,
  endedBasis: null,
  hasRole: false,
  joinedAt,
  lastEffective: null,
  ...overrides,
});
const applied = entry("add", "applied", true);
const unknownAdd = entry("add", "unknown", false);
const startedAdd = entry("add", "started", false);
const note = entry("note", "applied", false);
const removal = entry("remove", "applied", true);
const unknownRemove = entry("remove", "unknown", false);
const startedRemove = entry("remove", "started", false);
const beforeJoin = (value: LedgerEntry) => ({ ...value, createdAt: new Date("2026-09-30T00:00:00Z") });

describe("deciding one role for one member", () => {
  it.each<[string, Partial<RoleFacts>, object]>([
    // Desired and already present.
    [
      "confirms an unknown add when the role is present",
      { desiredBasis: "app", hasRole: true, lastEffective: unknownAdd },
      { op: "confirm", entryId: unknownAdd.id },
    ],
    [
      "confirms an unfinished add when the role is present",
      { desiredBasis: "app", hasRole: true, lastEffective: startedAdd },
      { op: "confirm", entryId: startedAdd.id },
    ],
    [
      "does nothing for a recorded add",
      { desiredBasis: "app", hasRole: true, lastEffective: applied },
      { op: "none", why: "already-recorded" },
    ],
    [
      "does nothing for a recorded note",
      { desiredBasis: "app", hasRole: true, lastEffective: note },
      { op: "none", why: "already-recorded" },
    ],
    ["notes a role someone else gave", { desiredBasis: "app", hasRole: true }, { op: "note", basisId: "app" }],
    [
      "notes a role present again after Gramps removed it",
      { desiredBasis: "app", hasRole: true, lastEffective: removal },
      { op: "note" },
    ],
    [
      "notes a role present after rejoining",
      { desiredBasis: "app", hasRole: true, lastEffective: beforeJoin(applied) },
      { op: "note" },
    ],
    // Desired and missing.
    ["adds a role with no history", { desiredBasis: "app" }, { op: "add", basisId: "app", why: "desired" }],
    [
      "does not re-add a role staff removed in this membership",
      { desiredBasis: "app", lastEffective: applied },
      { op: "none", why: "removed-in-discord" },
    ],
    [
      "does not add a role noted earlier and removed by staff",
      { desiredBasis: "app", lastEffective: note },
      { op: "none", why: "removed-in-discord" },
    ],
    [
      "retries an unknown add",
      { desiredBasis: "app", lastEffective: unknownAdd },
      { op: "add", why: "retry-unknown-add" },
    ],
    [
      "adds again after Gramps removed it",
      { desiredBasis: "app", lastEffective: removal },
      { op: "add", why: "desired" },
    ],
    [
      "re-adds after leaving and rejoining",
      { desiredBasis: "app", lastEffective: beforeJoin(applied) },
      { op: "add", why: "desired" },
    ],
    [
      "re-adds a Founder role after rejoining",
      { kind: "founder", desiredBasis: "supporter", lastEffective: beforeJoin(applied) },
      { op: "add" },
    ],
    [
      "treats unknown join times as the same membership",
      { desiredBasis: "app", joinedAt: null, lastEffective: beforeJoin(applied) },
      { op: "none", why: "removed-in-discord" },
    ],
    // Not desired.
    [
      "removes a UNC role Gramps added after revocation",
      { endedBasis: "app", hasRole: true, lastEffective: applied },
      { op: "remove", basisId: "app" },
    ],
    ["removes after an unknown add", { endedBasis: "app", hasRole: true, lastEffective: unknownAdd }, { op: "remove" }],
    [
      "removes after an unfinished add",
      { endedBasis: "app", hasRole: true, lastEffective: startedAdd },
      { op: "remove" },
    ],
    [
      "retries an unknown removal while the role is still present",
      { endedBasis: "app", hasRole: true, lastEffective: unknownRemove },
      { op: "remove", basisId: "app", why: "retry-unknown-remove" },
    ],
    [
      "retries an unfinished removal while the role is still present",
      { endedBasis: "app", hasRole: true, lastEffective: startedRemove },
      { op: "remove", basisId: "app", why: "retry-unknown-remove" },
    ],
    [
      "confirms an unknown removal when the role is gone",
      { endedBasis: "app", lastEffective: unknownRemove },
      { op: "confirm", entryId: unknownRemove.id, why: "unknown-remove-absent" },
    ],
    [
      "confirms an unfinished removal when the role is gone",
      { endedBasis: "app", lastEffective: startedRemove },
      { op: "confirm", entryId: startedRemove.id },
    ],
    [
      "never retries a removal from an earlier membership",
      { endedBasis: "app", hasRole: true, lastEffective: beforeJoin(unknownRemove) },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a role given back after a confirmed removal",
      { endedBasis: "app", hasRole: true, lastEffective: removal },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a noted role",
      { endedBasis: "app", hasRole: true, lastEffective: note },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a role with no ledger history",
      { endedBasis: "app", hasRole: true },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a role added in an earlier membership",
      { endedBasis: "app", hasRole: true, lastEffective: beforeJoin(applied) },
      { op: "none", why: "not-ours" },
    ],
    [
      "does nothing when the revoked member no longer has it",
      { endedBasis: "app", lastEffective: applied },
      { op: "none", why: "not-present" },
    ],
    [
      "does nothing without a revoked UNC application",
      { hasRole: true, lastEffective: applied },
      { op: "none", why: "no-basis" },
    ],
    [
      "never removes a Founder role",
      { kind: "founder", endedBasis: "x", hasRole: true, lastEffective: applied },
      { op: "none", why: "founder-kept" },
    ],
    // Supporter.
    [
      "adds a Supporter role for someone who supports",
      { kind: "supporter", desiredBasis: "record" },
      { op: "add", basisId: "record", why: "desired" },
    ],
    [
      "only notes a Supporter role someone else gave",
      { kind: "supporter", desiredBasis: "record", hasRole: true },
      { op: "note", basisId: "record", why: "already-present" },
    ],
    [
      "does not re-add a Supporter role staff removed in this membership",
      { kind: "supporter", desiredBasis: "record", lastEffective: applied },
      { op: "none", why: "removed-in-discord" },
    ],
    [
      "removes a Supporter role Gramps added once support lapsed",
      { kind: "supporter", endedBasis: "record", hasRole: true, lastEffective: applied },
      { op: "remove", basisId: "record", why: "support-lapsed" },
    ],
    [
      "retries an unknown Supporter removal while the role is still present",
      { kind: "supporter", endedBasis: "record", hasRole: true, lastEffective: unknownRemove },
      { op: "remove", basisId: "record", why: "retry-unknown-remove" },
    ],
    [
      "confirms an unknown Supporter removal when the role is gone",
      { kind: "supporter", endedBasis: "record", lastEffective: unknownRemove },
      { op: "confirm", entryId: unknownRemove.id, why: "unknown-remove-absent" },
    ],
    [
      "never removes a lapsed Supporter role that was already present",
      { kind: "supporter", endedBasis: "record", hasRole: true, lastEffective: note },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a lapsed Supporter role Gramps has no record of adding",
      { kind: "supporter", endedBasis: "record", hasRole: true },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a Supporter role added in an earlier membership",
      { kind: "supporter", endedBasis: "record", hasRole: true, lastEffective: beforeJoin(applied) },
      { op: "none", why: "not-ours" },
    ],
  ])("%s", (_label, overrides, expected) => {
    expect(decide(facts(overrides))).toMatchObject(expected);
  });
});

describe("deciding the Supporter role from supporter records over time", () => {
  const day = 86_400_000;
  const chargedAt = Date.parse("2026-11-01T12:00:00Z");
  const payment = (overrides: Partial<SupportFacts["payments"][number]> = {}) => ({
    source: "patreon_api",
    paidAt: new Date(chargedAt),
    amountCents: 500,
    currency: "USD",
    minimumConfirmed: false,
    ...overrides,
  });
  const patron = (overrides: Partial<SupportFacts> = {}): SupportFacts => ({
    provider: "patreon",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: new Date(chargedAt),
    payments: [payment()],
    ...overrides,
  });
  const declined = patron({ patronStatus: "declined_patron", lastChargeStatus: "Declined" });
  const paypal = patron({
    provider: "paypal",
    patronStatus: null,
    lastChargeStatus: null,
    lastChargeAt: null,
    payments: [payment({ source: "paypal", amountCents: 1000 })],
  });
  /** The service's view of one record: desired while it supports, otherwise lapsed with the same record. */
  const supporter = (record: SupportFacts, now: number, overrides: Partial<RoleFacts> = {}) => {
    const active = supportActive(record, now);
    return decide(
      facts({
        kind: "supporter",
        desiredBasis: active ? "record" : null,
        endedBasis: active ? null : "record",
        hasRole: true,
        lastEffective: applied,
        ...overrides,
      }),
    );
  };
  const kept = { op: "none", why: "already-recorded" };
  const lapsed = { op: "remove", basisId: "record", why: "support-lapsed" };

  it("adds the role for an active patron of any paid tier and keeps it while they support", () => {
    expect(supporter(patron(), chargedAt + day, { hasRole: false, lastEffective: null })).toEqual({
      op: "add",
      basisId: "record",
      why: "desired",
    });
    expect(supporter(patron({ payments: [payment({ amountCents: 2500 })] }), chargedAt + 300 * day)).toEqual(kept);
  });

  it("keeps the role for 7 days after a declined charge, then removes it", () => {
    expect(SUPPORTER_DECLINE_GRACE_MS).toBe(7 * day);
    expect(supporter(declined, chargedAt + SUPPORTER_DECLINE_GRACE_MS - 1)).toEqual(kept);
    expect(supporter(declined, chargedAt + SUPPORTER_DECLINE_GRACE_MS)).toEqual(lapsed);
  });

  it("keeps the role for 31 days after a PayPal payment, then removes it", () => {
    expect(PAYPAL_SUPPORT_MS).toBe(31 * day);
    expect(supporter(paypal, chargedAt, { hasRole: false, lastEffective: null })).toMatchObject({ op: "add" });
    expect(supporter(paypal, chargedAt + PAYPAL_SUPPORT_MS - 1)).toEqual(kept);
    expect(supporter(paypal, chargedAt + PAYPAL_SUPPORT_MS)).toEqual(lapsed);
  });

  it("removes the role at once when Patreon reports a refund, fraud or a cancelled membership", () => {
    for (const record of [
      patron({ lastChargeStatus: "Refunded" }),
      patron({ lastChargeStatus: "Fraud" }),
      patron({ patronStatus: "former_patron" }),
    ])
      expect(supporter(record, chargedAt + day)).toEqual(lapsed);
  });

  it("never removes a lapsed Supporter role that was already present before Gramps checked", () => {
    expect(supporter(paypal, chargedAt + PAYPAL_SUPPORT_MS, { lastEffective: note })).toEqual({
      op: "none",
      why: "not-ours",
    });
  });

  it("keeps the Founder role of a founder whose support lapsed and removes only the Supporter role", () => {
    const now = chargedAt + SUPPORTER_DECLINE_GRACE_MS;
    const founder = decide(facts({ kind: "founder", desiredBasis: "record", hasRole: true, lastEffective: applied }));
    expect(founder).toEqual(kept);
    expect(supporter(declined, now)).toEqual(lapsed);
    // A founder who still supports holds both roles.
    expect(supporter(patron(), now)).toEqual(kept);
    expect(ROLE_REASONS.supporter).toEqual({ add: "Gramps: active supporter", remove: "Gramps: support ended" });
  });
});

describe("classifying Discord failures", () => {
  it.each([
    [{ code: 50013, status: 403 }, "permission"],
    [{ code: 50001, status: 403 }, "permission"],
    [{ status: 403 }, "permission"],
    [{ code: 10011, status: 404 }, "unknown-role"],
    [{ code: 10007, status: 404 }, "left"],
    [{ code: 10013, status: 404 }, "left"],
    [{ code: 50035, status: 400 }, "rejected"],
    [{ status: 500 }, "transient"],
    [{ status: 503 }, "transient"],
    [{ status: 429 }, "transient"],
    [{ name: "AbortError" }, "transient"],
    [new Error("ECONNRESET"), "transient"],
    [null, "transient"],
  ])("treats %p as %s", (error, expected) => {
    expect(classifyDiscordError(error)).toBe(expected);
  });
});
