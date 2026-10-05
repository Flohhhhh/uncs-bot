import { describe, expect, it } from "vitest";
import {
  applicationSteamId,
  discordCell,
  discordSource,
  founderOffered,
  paymentLine,
  paymentOffered,
  providerLine,
  reviewInput,
  rowState,
} from "./policy";
import type { NextStep, PaymentEvidence, Supporter } from "./types";

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
const paypal = (...nextSteps: NextStep[]): Supporter => ({
  ...record,
  provider: "paypal",
  patreonMemberId: null,
  confirmKey: record.id,
  nextSteps,
});
/** Which list a step lands in, on a Patreon record and on a PayPal record. */
const placed = (state: ReturnType<typeof rowState>) =>
  (["needs", "waiting", "later", "notes"] as const).find((list) => state[list].length > 0) ?? "none";

describe("row state", () => {
  it("is all set with nothing left", () => {
    expect(rowState(record)).toEqual({ state: "set", needs: [], waiting: [], later: [], notes: [] });
  });

  // One case per step code the server sends, for each provider: [code, area, Patreon list, PayPal list].
  it.each<[string, NextStep["area"], string, string]>([
    // Discord
    ["connect_discord_in_patreon", "discord", "waiting", "waiting"],
    ["link_discord_no_import", "discord", "waiting", "waiting"],
    ["link_discord_paypal", "discord", "needs", "needs"],
    ["discord_on_another_record", "discord", "needs", "needs"],
    ["discord_differs", "discord", "needs", "needs"],
    ["discord_reported_for_other_patron", "discord", "needs", "needs"],
    // A patron's own Link Patreon sign-in that Gramps refused is a real conflict.
    ["patron_link_conflict", "discord", "needs", "needs"],
    // SteamID: whitelist applications matter later, and no founder needs a SteamID, on either provider
    ["no_whitelist_application", "steam", "later", "later"],
    ["application_pending", "steam", "later", "later"],
    ["application_in_progress", "steam", "later", "later"],
    ["no_approved_application", "steam", "later", "later"],
    ["application_not_confirmed", "steam", "later", "later"],
    ["several_steam_ids", "steam", "later", "later"],
    ["invalid_steam_id", "steam", "later", "later"],
    ["steam_shared", "steam", "later", "later"],
    ["steam_rejected_before", "steam", "later", "later"],
    ["steam_available", "steam", "later", "later"],
    ["source_application_revoked", "steam", "later", "later"],
    ["steam_differs_from_application", "steam", "later", "later"],
    ["linked_steam_shared", "steam", "later", "later"],
    // One person on two records is for staff on either provider.
    ["steam_on_another_record", "steam", "needs", "needs"],
    ["steam_ready_automatic", "steam", "waiting", "waiting"],
    // Founder: what Gramps or Patreon settles waits, a conflict needs staff
    ["founder_ready_automatic", "founder", "waiting", "waiting"],
    ["founder_automatic_waiting", "founder", "waiting", "waiting"],
    ["founder_ready_automatic_off", "founder", "waiting", "waiting"],
    ["founder_below_minimum", "founder", "waiting", "waiting"],
    ["founder_not_first_payment", "founder", "waiting", "waiting"],
    ["founder_source_not_qualifying", "founder", "waiting", "waiting"],
    ["founder_waiting_patreon", "founder", "waiting", "waiting"],
    ["founder_waiting_discord", "founder", "waiting", "waiting"],
    ["founder_needs_discord", "founder", "waiting", "needs"],
    ["founder_ready_staff", "founder", "needs", "needs"],
    ["founder_steam_on_another_record", "founder", "needs", "needs"],
    // A person's first payment on another record is a note: Gramps decided it.
    ["founder_earlier_payment_other_record", "info", "notes", "notes"],
    ["founder_steam_applied_by_founder", "founder", "needs", "needs"],
    ["founder_window_not_configured", "founder", "notes", "notes"],
    // Notes: why a record is not a founder
    ["founder_not_first_payment", "payment", "notes", "notes"],
    ["founder_no_payment", "payment", "notes", "notes"],
    ["founder_earlier_payment", "payment", "notes", "notes"],
    ["founder_not_verified", "payment", "notes", "notes"],
    ["founder_outside_window", "info", "notes", "notes"],
    ["founder_already_founder", "info", "notes", "notes"],
    ["founder_below_minimum", "info", "notes", "notes"],
    // A step this page does not know is shown to staff, so nothing new is hidden.
    ["something_new", "founder", "needs", "needs"],
  ])("puts %s (%s) under %s for Patreon and %s for PayPal", (code, area, patreonList, paypalList) => {
    const patreonState = rowState(withSteps(step(code, area)));
    expect(placed(patreonState)).toBe(patreonList);
    expect(placed(rowState(paypal(step(code, area))))).toBe(paypalList);
    expect(patreonState.state).toBe(patreonList === "needs" ? "needs" : patreonList === "waiting" ? "waiting" : "set");
  });

  it("waits for an account only while the record has neither, and needs staff for an invalid SteamID", () => {
    const missing = step("founder_no_identity", "founder");
    expect(rowState({ ...withSteps(missing), discordId: null, steamId: null }).state).toBe("waiting");
    expect(rowState({ ...withSteps(missing), discordId: null }).state).toBe("needs");
    expect(rowState(withSteps(missing)).state).toBe("needs");
  });

  it("needs staff above waiting, and keeps every group", () => {
    const state = rowState(
      withSteps(
        step("connect_discord_in_patreon", "discord"),
        step("steam_shared"),
        step("steam_on_another_record"),
        step("no_whitelist_application"),
        step("founder_earlier_payment", "payment"),
      ),
    );
    expect(state).toEqual({
      state: "needs",
      needs: ["Step steam_on_another_record."],
      waiting: ["Step connect_discord_in_patreon."],
      later: ["Step steam_shared.", "Step no_whitelist_application."],
      notes: ["Step founder_earlier_payment."],
    });
  });

  it("lists a line once when two steps wait for the same thing", () => {
    const message = "Waiting for them to connect Discord on Patreon.";
    const state = rowState(
      withSteps(
        { code: "connect_discord_in_patreon", area: "discord", message },
        { code: "founder_waiting_discord", area: "founder", message },
      ),
    );
    expect(state).toMatchObject({ state: "waiting", waiting: [message] });
  });
});

describe("PayPal SteamID alerts", () => {
  it("leaves a PayPal founder with SteamID alerts that no button clears all set", () => {
    // A SteamID Gramps found, or one another Discord account applied with, matters only for the whitelist later.
    const state = rowState(
      paypal(step("steam_available"), step("linked_steam_shared"), step("steam_differs_from_application")),
    );
    expect(state.state).toBe("set");
    expect(state.later).toHaveLength(3);
    // Another record holding the SteamID is a real conflict, on PayPal too.
    expect(rowState(paypal(step("steam_on_another_record"))).state).toBe("needs");
  });
});

describe("Use SteamID", () => {
  it("offers a SteamID another record holds, which its step asks staff to link when they are the same person", () => {
    const steam = { steamId: "76561198000000009", applicationId: "app-1", serverId: "primary" };
    const offered = (reason: "steam_on_another_record" | "steam_shared" | null) =>
      applicationSteamId({ ...record, steamId: null, match: { ...record.match, steam: { ...steam, reason } } });
    expect(offered("steam_on_another_record")).toBe(steam.steamId);
    expect(offered(null)).toBe(steam.steamId);
    expect(offered("steam_shared")).toBeNull();
  });
});

describe("Make founder", () => {
  const ready: Supporter = { ...record, founder: null, founderEligiblePayment: payment };
  it("follows the server's verdict", () => {
    expect(founderOffered(ready)).toBe(true);
    expect(founderOffered({ ...ready, founderBlockedReason: "outside_window" })).toBe(false);
    expect(founderOffered(record)).toBe(false);
  });
  it.each([
    ["steam_on_another_record", "steam"],
    ["founder_steam_on_another_record", "founder"],
    ["founder_earlier_payment_other_record", "info"],
  ] as const)("stays hidden while %s says another record may be the same person", (code, area) => {
    // The staff founder rule compares this record alone, so it could make the same person a founder twice.
    for (const provider of ["patreon", "paypal"] as const)
      expect(founderOffered({ ...ready, provider, nextSteps: [step(code, area)] })).toBe(false);
  });
});

describe("Add payment", () => {
  const patron = { ...record, founder: null };
  it("never shows on a Patreon record while the Patreon import runs, which brings in every payment", () => {
    for (const latestPayment of [null, payment])
      for (const nextSteps of [[step("founder_no_payment", "payment")], [step("founder_not_first_payment", "founder")]])
        expect(paymentOffered({ ...patron, latestPayment, nextSteps }, true)).toBe(false);
  });
  it("shows on a Patreon record with a payment step while the import is off", () => {
    expect(paymentOffered({ ...patron, nextSteps: [step("founder_no_payment", "payment")] }, false)).toBe(true);
    expect(paymentOffered({ ...patron, nextSteps: [step("founder_not_first_payment", "payment")] }, false)).toBe(true);
  });
  it("shows on a Patreon record with no paid payment while the import is off, whether or not the dates are set", () => {
    const unset = [step("founder_window_not_configured", "founder")];
    for (const latestPayment of [
      null,
      { ...payment, source: "signed_status" as const, amountCents: null, verificationState: "unverified" as const },
      { ...payment, verificationState: "unverified" as const },
    ])
      expect(paymentOffered({ ...patron, latestPayment, nextSteps: unset }, false)).toBe(true);
    // One paid payment is enough for the Supporter role, so it stays out of the way.
    expect(paymentOffered({ ...patron, nextSteps: unset }, false)).toBe(false);
    expect(paymentOffered({ ...patron, nextSteps: [step("founder_outside_window", "info")] }, false)).toBe(false);
  });
  it("never shows on a PayPal record, which records its payments in the PayPal form", () => {
    for (const importConfigured of [true, false])
      expect(
        paymentOffered(
          { ...patron, provider: "paypal", latestPayment: null, nextSteps: [step("x", "payment")] },
          importConfigured,
        ),
      ).toBe(false);
  });
});

describe("the Discord column", () => {
  const unlinked: Supporter = { ...record, discordId: null, discordSource: null };
  it.each([
    "discord_on_another_record",
    "discord_differs",
    "discord_reported_for_other_patron",
    "patron_link_conflict",
  ])("asks staff to check the account for %s, before anything else", (code) => {
    expect(discordCell(withSteps(step(code, "discord")))).toEqual({ text: "Check", warn: true, rank: 0 });
  });
  it("says where a linked account came from", () => {
    expect(discordCell(record)).toEqual({ text: "Linked", warn: false, detail: "Added by staff", rank: 4 });
    expect(discordCell({ ...record, discordSource: "patreon" }).detail).toBe("From Patreon");
    expect(discordCell({ ...record, discordSource: null }).detail).toBe("Added earlier");
  });
  it("says Linked by patron for an account the patron linked with Link Patreon", () => {
    const own: Supporter = { ...record, discordSource: "patron_signin", identityState: "patreon_linked" };
    expect(discordSource(own)).toBe("Linked by patron");
    expect(discordCell(own)).toEqual({ text: "Linked", warn: false, detail: "Linked by patron", rank: 4 });
    // Patreon reporting no account is the usual case for these links, so it is never a problem.
    expect(discordCell({ ...own, patreonDiscordId: null })).toMatchObject({ text: "Linked", warn: false });
    expect(rowState({ ...own, nextSteps: [] }).state).toBe("set");
  });
  it("puts a different account Patreon reports against a patron's own link under Needs you", () => {
    const conflict: Supporter = {
      ...record,
      discordSource: "patron_signin",
      patreonDiscordId: "34567890123456789",
      nextSteps: [step("discord_differs", "discord")],
    };
    expect(discordCell(conflict)).toEqual({ text: "Check", warn: true, rank: 0 });
    expect(rowState(conflict)).toMatchObject({ state: "needs", needs: ["Step discord_differs."] });
  });
  it("says an account is missing only on a PayPal record, where staff add it", () => {
    expect(discordCell({ ...unlinked, provider: "paypal", patreonMemberId: null })).toEqual({
      text: "Missing",
      warn: true,
      rank: 1,
    });
    // A Patreon account arrives from Patreon, so a founder without one, or a record waiting for the import, waits.
    const notConnected = { text: "Not connected", warn: false, rank: 2 };
    expect(discordCell({ ...unlinked, needsDiscordLink: true })).toEqual(notConnected);
    expect(discordCell({ ...unlinked, nextSteps: [step("link_discord_no_import", "discord")] })).toEqual(notConnected);
  });
  it("says Gramps links an account Patreon shows, and otherwise that none is connected", () => {
    expect(discordCell({ ...unlinked, patreonDiscordId: "34567890123456789" })).toEqual({
      text: "Linking soon",
      warn: false,
      rank: 3,
    });
    expect(discordCell(unlinked)).toEqual({ text: "Not connected", warn: false, rank: 2 });
  });
  it("shows a link Patreon no longer reports as linked, not as a problem", () => {
    expect(discordCell({ ...record, discordSource: "patreon", patreonDiscordId: null })).toMatchObject({
      text: "Linked",
      warn: false,
    });
  });
});

describe("the request body", () => {
  it("sends a founder award on the payment the server named", () => {
    const values = new FormData();
    values.set("reason", "Founder confirmed");
    const ready: Supporter = { ...record, founder: null, founderEligiblePayment: payment };
    expect(reviewInput(ready, "founder", "action-id", values)).toEqual({
      id: "action-id",
      version: record.version,
      confirm: record.confirmKey,
      reason: "Founder confirmed",
      paymentId: payment.id,
    });
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
