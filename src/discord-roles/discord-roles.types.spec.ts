import { classifyDiscordError, decide, type LedgerEntry, type RoleFacts } from "./discord-roles.types";

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
  revokedBasis: null,
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
      { revokedBasis: "app", hasRole: true, lastEffective: applied },
      { op: "remove", basisId: "app" },
    ],
    [
      "removes after an unknown add",
      { revokedBasis: "app", hasRole: true, lastEffective: unknownAdd },
      { op: "remove" },
    ],
    [
      "removes after an unfinished add",
      { revokedBasis: "app", hasRole: true, lastEffective: startedAdd },
      { op: "remove" },
    ],
    [
      "retries an unknown removal while the role is still present",
      { revokedBasis: "app", hasRole: true, lastEffective: unknownRemove },
      { op: "remove", basisId: "app", why: "retry-unknown-remove" },
    ],
    [
      "retries an unfinished removal while the role is still present",
      { revokedBasis: "app", hasRole: true, lastEffective: startedRemove },
      { op: "remove", basisId: "app", why: "retry-unknown-remove" },
    ],
    [
      "confirms an unknown removal when the role is gone",
      { revokedBasis: "app", lastEffective: unknownRemove },
      { op: "confirm", entryId: unknownRemove.id, why: "unknown-remove-absent" },
    ],
    [
      "confirms an unfinished removal when the role is gone",
      { revokedBasis: "app", lastEffective: startedRemove },
      { op: "confirm", entryId: startedRemove.id },
    ],
    [
      "never retries a removal from an earlier membership",
      { revokedBasis: "app", hasRole: true, lastEffective: beforeJoin(unknownRemove) },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a role given back after a confirmed removal",
      { revokedBasis: "app", hasRole: true, lastEffective: removal },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a noted role",
      { revokedBasis: "app", hasRole: true, lastEffective: note },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a role with no ledger history",
      { revokedBasis: "app", hasRole: true },
      { op: "none", why: "not-ours" },
    ],
    [
      "never removes a role added in an earlier membership",
      { revokedBasis: "app", hasRole: true, lastEffective: beforeJoin(applied) },
      { op: "none", why: "not-ours" },
    ],
    [
      "does nothing when the revoked member no longer has it",
      { revokedBasis: "app", lastEffective: applied },
      { op: "none", why: "not-present" },
    ],
    [
      "does nothing without a revoked UNC application",
      { hasRole: true, lastEffective: applied },
      { op: "none", why: "no-basis" },
    ],
    [
      "never removes a Founder role",
      { kind: "founder", revokedBasis: "x", hasRole: true, lastEffective: applied },
      { op: "none", why: "founder-kept" },
    ],
  ])("%s", (_label, overrides, expected) => {
    expect(decide(facts(overrides))).toMatchObject(expected);
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
