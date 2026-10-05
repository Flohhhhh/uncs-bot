import { describe, expect, it } from "vitest";
import { discordCell, paymentLine, providerLine, rowState } from "./policy";
import type { NextStep, PatreonSyncStatus, PaymentEvidence, Supporter } from "./types";

const payment: PaymentEvidence = {
  id: "01234567-89ab-4cde-8fab-0123456789ac",
  paidAt: "2026-10-01T16:00:00Z",
  amountCents: 500,
  currency: "USD",
  source: "patreon_api",
  reference: "pledge-1",
  verificationState: "verified",
  firstSuccessfulPaymentVerified: true,
};
/** A Patreon record with both accounts from staff and nothing left to do. */
const record: Supporter = {
  id: "01234567-89ab-4cde-8fab-0123456789ab",
  provider: "patreon",
  patreonMemberId: "member-1",
  confirmKey: "member-1",
  displayName: "Fixture patron",
  patronStatus: "active_patron",
  lastChargeStatus: "Paid",
  lastChargeAt: "2026-10-01T16:00:00Z",
  observedAt: "2026-10-01T16:00:00Z",
  reviewState: "pending",
  discordId: "23456789012345678",
  discordSource: "staff",
  patreonDiscordId: null,
  steamId: "76561198000000001",
  steamSource: "staff",
  steamApplicationId: null,
  identityState: "staff_linked",
  version: 1,
  latestPayment: payment,
  founderEligiblePayment: null,
  founder: { awardedAt: "2026-10-01T16:00:00Z", paymentId: payment.id },
  founderBlockedReason: null,
  founderBlockedMessage: null,
  needsDiscordLink: false,
  match: {
    steam: null,
    sourceApplication: null,
    sourceApplicationRevoked: false,
    patreonDiscordElsewhere: false,
    discordReportedForOtherPatron: false,
    linkedSteamShared: false,
  },
  automaticPayment: null,
  automaticBlockedReason: null,
  automaticBlockedMessage: null,
  nextSteps: [],
};
const step = (code: string, area: NextStep["area"] = "steam"): NextStep => ({ code, area, message: `Step ${code}.` });
const withSteps = (...nextSteps: NextStep[]): Supporter => ({ ...record, nextSteps });
type Lists = Pick<PatreonSyncStatus, "founderReviews" | "conflictDetails">;
const review = (reviewReason: "unverified" | "not_first_payment", supporterId = record.id) => ({
  supporterId,
  patreonMemberId: "member-1",
  paymentId: payment.id,
  paymentSource: "patreon_api",
  reference: payment.reference,
  unverifiedPaymentId: payment.id,
  unverifiedReference: payment.reference,
  reviewReason,
});
const conflict = (reason: "discord-in-use" | "discord-differs", supporterId = record.id) => ({
  supporterId,
  patreonMemberId: "member-1",
  reason,
});
const lists = (overrides: Partial<Lists> = {}): Lists => ({ founderReviews: [], conflictDetails: [], ...overrides });

describe("row state", () => {
  it("is all set with nothing left", () => {
    expect(rowState(record)).toEqual({ state: "set", needs: [], waiting: [], later: [], notes: [] });
  });

  it.each([
    "connect_discord_in_patreon",
    "steam_ready_automatic",
    "founder_ready_automatic",
    "founder_automatic_waiting",
  ])("waits on Gramps or the supporter for %s", (code) => {
    expect(rowState(withSteps(step(code)))).toMatchObject({ state: "waiting", waiting: [`Step ${code}.`], needs: [] });
  });

  it.each(["no_whitelist_application", "application_pending", "application_in_progress", "no_approved_application"])(
    "keeps %s for later, so the row stays all set",
    (code) => {
      expect(rowState(withSteps(step(code)))).toMatchObject({ state: "set", later: [`Step ${code}.`], needs: [] });
    },
  );

  it.each([
    ["a payment step", step("founder_not_first_payment", "payment")],
    ["a note", step("founder_outside_window", "info")],
    ["unset founder dates", step("founder_window_not_configured", "founder")],
  ])("keeps %s as a note, never a task", (_label, note) => {
    expect(rowState(withSteps(note))).toMatchObject({ state: "set", notes: [note.message], needs: [] });
  });

  it.each([
    "link_discord_paypal",
    "discord_on_another_record",
    "link_discord_no_import",
    "discord_not_reported",
    "discord_differs",
    "discord_reported_for_other_patron",
    "application_not_confirmed",
    "several_steam_ids",
    "invalid_steam_id",
    "steam_shared",
    "linked_steam_shared",
    "steam_rejected_before",
    "steam_on_another_record",
    "steam_available",
    "source_application_revoked",
    "steam_differs_from_application",
    "founder_needs_discord",
    "founder_ready_staff",
    "founder_ready_automatic_off",
    "founder_steam_applied_by_founder",
  ])("needs staff for %s", (code) => {
    expect(rowState(withSteps(step(code)))).toMatchObject({ state: "needs", needs: [`Step ${code}.`] });
  });

  it("puts a step it does not know under Needs you", () => {
    expect(rowState(withSteps(step("something_new", "founder")))).toMatchObject({
      state: "needs",
      needs: ["Step something_new."],
    });
  });

  it("waits for an account only while the record has neither", () => {
    const missing = step("founder_no_identity", "founder");
    expect(rowState({ ...withSteps(missing), discordId: null, steamId: null }).state).toBe("waiting");
    expect(rowState({ ...withSteps(missing), discordId: null }).state).toBe("needs");
  });

  it("needs staff above waiting, and keeps every group", () => {
    const state = rowState(
      withSteps(
        step("connect_discord_in_patreon", "discord"),
        step("steam_shared"),
        step("no_whitelist_application"),
        step("founder_earlier_payment", "payment"),
      ),
    );
    expect(state).toEqual({
      state: "needs",
      needs: ["Step steam_shared."],
      waiting: ["Step connect_discord_in_patreon."],
      later: ["Step no_whitelist_application."],
      notes: ["Step founder_earlier_payment."],
    });
  });

  it("starts with a sentence for each founder payment to check on this record, then the server's steps", () => {
    const sync = lists({
      founderReviews: [review("unverified"), review("not_first_payment"), review("unverified", "another-record")],
    });
    expect(rowState(withSteps(step("steam_shared")), sync)).toMatchObject({
      state: "needs",
      needs: [
        "Patreon no longer shows their founder payment as paid.",
        "Their founder payment is no longer their first payment.",
        "Step steam_shared.",
      ],
    });
    // A founder with nothing else left still needs staff.
    expect(rowState(record, sync).state).toBe("needs");
    expect(rowState({ ...record, id: "unlisted" }, sync).state).toBe("set");
  });

  it("adds a Discord conflict unless a Discord step already needs staff", () => {
    expect(rowState(record, lists({ conflictDetails: [conflict("discord-in-use")] })).needs).toEqual([
      "Their Discord account is already on another supporter.",
    ]);
    expect(rowState(record, lists({ conflictDetails: [conflict("discord-differs")] })).needs).toEqual([
      "Patreon shows a different Discord account.",
    ]);
    const differs = withSteps(step("discord_differs", "discord"));
    expect(rowState(differs, lists({ conflictDetails: [conflict("discord-differs")] })).needs).toEqual([
      "Step discord_differs.",
    ]);
    // A Discord step that only waits does not say what the conflict is.
    const waiting = withSteps(step("connect_discord_in_patreon", "discord"));
    expect(rowState(waiting, lists({ conflictDetails: [conflict("discord-in-use")] }))).toMatchObject({
      state: "needs",
      needs: ["Their Discord account is already on another supporter."],
      waiting: ["Step connect_discord_in_patreon."],
    });
    expect(rowState(record, lists({ conflictDetails: [conflict("discord-in-use", "another-record")] })).state).toBe(
      "set",
    );
  });
});

describe("the Discord column", () => {
  const unlinked: Supporter = { ...record, discordId: null, discordSource: null };
  it.each([
    "discord_on_another_record",
    "discord_not_reported",
    "discord_differs",
    "discord_reported_for_other_patron",
  ])("asks staff to check the account for %s, before anything else", (code) => {
    expect(discordCell(withSteps(step(code, "discord")))).toEqual({ text: "Check", warn: true, rank: 0 });
  });
  it("asks staff to check an account the last import found a conflict for", () => {
    expect(discordCell(record, lists({ conflictDetails: [conflict("discord-in-use")] }))).toMatchObject({
      text: "Check",
      warn: true,
    });
    expect(discordCell(record, lists({ conflictDetails: [conflict("discord-in-use", "another-record")] })).text).toBe(
      "Linked",
    );
  });
  it("says where a linked account came from", () => {
    expect(discordCell(record)).toEqual({ text: "Linked", warn: false, detail: "Added by staff", rank: 4 });
    expect(discordCell({ ...record, discordSource: "patreon" }).detail).toBe("From Patreon");
    expect(discordCell({ ...record, discordSource: null }).detail).toBe("Added earlier");
  });
  it("says an account is missing where staff must add it", () => {
    const missing = { text: "Missing", warn: true, rank: 1 };
    expect(discordCell({ ...unlinked, provider: "paypal", patreonMemberId: null })).toEqual(missing);
    expect(discordCell({ ...unlinked, needsDiscordLink: true })).toEqual(missing);
    expect(discordCell({ ...unlinked, nextSteps: [step("link_discord_no_import", "discord")] })).toEqual(missing);
  });
  it("says Gramps links an account Patreon shows, and otherwise that none is connected", () => {
    expect(discordCell({ ...unlinked, patreonDiscordId: "34567890123456789" })).toEqual({
      text: "Linking soon",
      warn: false,
      rank: 3,
    });
    expect(discordCell(unlinked)).toEqual({ text: "Not connected", warn: false, rank: 2 });
  });
});

describe("the supporter's small line", () => {
  it.each([
    ["PayPal", { provider: "paypal" as const }, "PayPal"],
    ["an active patron", {}, "Patreon"],
    ["a declined patron", { patronStatus: "declined_patron" }, "Patreon · payment issue"],
    ["a former patron", { patronStatus: "former_patron" }, "Patreon · former"],
    ["a member with no status", { patronStatus: null }, "Patreon · not paying"],
    ["a status Gramps does not know", { patronStatus: "paused_patron" }, "Patreon · paused_patron"],
  ])("names %s", (_label, overrides, text) => {
    expect(providerLine({ ...record, ...overrides })).toEqual({ text, warn: false });
  });
  it("warns about a last charge that was not paid", () => {
    expect(providerLine({ ...record, lastChargeStatus: "Refunded" })).toEqual({
      text: "Patreon · last charge Refunded",
      warn: true,
    });
    expect(providerLine({ ...record, lastChargeStatus: null }).warn).toBe(false);
  });
});

describe("the payment line", () => {
  it.each([
    ["an imported first payment", payment, "5.00 USD · from Patreon · first payment"],
    ["a staff receipt", { ...payment, source: "manual_receipt" as const }, "5.00 USD · added by staff · first payment"],
    [
      "a PayPal renewal",
      { ...payment, source: "paypal" as const, firstSuccessfulPaymentVerified: false },
      "5.00 USD · PayPal",
    ],
    [
      "a payment Patreon stopped reporting",
      { ...payment, verificationState: "unverified" as const },
      "5.00 USD · no longer paid · first payment",
    ],
    [
      "a signed status",
      {
        ...payment,
        source: "signed_status" as const,
        amountCents: null,
        currency: null,
        verificationState: "unverified" as const,
        firstSuccessfulPaymentVerified: false,
      },
      "status only",
    ],
  ])("words %s", (_label, value, text) => {
    expect(paymentLine(value)).toBe(text);
  });
  it("says when there is no payment", () => {
    expect(paymentLine(null)).toBe("No payment yet");
  });
});
