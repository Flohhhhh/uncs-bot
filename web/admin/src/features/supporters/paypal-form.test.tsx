import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { founderBlocker, paypalSchema } from "../../../../../src/supporters/supporters.types";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { SupportersPage } from "./index";
import { AddPaypalSupporter, localMinute, paypalEntry, type PaypalResponse } from "./paypal-form";
import type { FounderPolicy, PaymentEvidence, Supporter, SupportersResponse } from "./types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const context: AdminContextValue = {
  me: { id: "12345678901234567", name: "Admin", role: "admin", csrf: "fixture" },
  overview: null,
  stale: true,
  checking: false,
  watchRoster: vi.fn(),
  busy: false,
  dialogOpen: false,
  refreshVersion: 0,
  setBusy: vi.fn(),
  setDialogOpen: vi.fn(),
  setUnsavedChanges: vi.fn(),
  refresh: vi.fn(),
  invalidateOverview: vi.fn(),
  openAction: vi.fn(),
};
const policy: FounderPolicy = {
  amountCents: 500,
  currency: "USD",
  startsAt: "2026-09-30T04:00:00Z",
  endsAt: "2026-10-15T04:00:00Z",
  configured: true,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const transactionId = "8AB12345CD678901E";
const payment: PaymentEvidence = {
  id: "11111111-1111-4111-8111-111111111111",
  paidAt: "2026-10-01T16:00:00.000Z",
  amountCents: 500,
  currency: "USD",
  source: "paypal",
  reference: transactionId,
  verificationState: "verified",
  firstSuccessfulPaymentVerified: true,
  minimumConfirmed: false,
};
/** A PayPal founder as the server returns one after a save. */
const founder: Supporter = {
  id: "22222222-2222-4222-8222-222222222222",
  provider: "paypal",
  patreonMemberId: null,
  confirmKey: "22222222-2222-4222-8222-222222222222",
  displayName: "Dana Donor",
  patronStatus: null,
  lastChargeStatus: null,
  lastChargeAt: null,
  observedAt: "2026-10-04T15:00:00.000Z",
  reviewState: "verified",
  discordId: "123456789012345678",
  discordSource: "staff",
  patreonDiscordId: null,
  steamId: null,
  steamSource: null,
  steamApplicationId: null,
  identityState: "partial",
  version: 1,
  latestPayment: payment,
  founderEligiblePayment: payment,
  founder: { awardedAt: "2026-10-04T15:00:00.000Z", paymentId: payment.id, source: "paypal", automatic: false },
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
  automaticBlockedReason: "not_patreon",
  automaticBlockedMessage: "Only Patreon supporters are recorded automatically.",
  nextSteps: [
    {
      code: "no_whitelist_application",
      area: "steam",
      message: "No whitelist application from this Discord account.",
    },
  ],
};
const outsideWindow = "This payment was not made inside the founder window.";
/** The same donor saved without a founder, with the server's reason as a note. */
const notFounder: Supporter = {
  ...founder,
  founder: null,
  founderBlockedReason: "outside_window",
  founderBlockedMessage: outsideWindow,
  nextSteps: [{ code: "founder_outside_window", area: "info", message: outsideWindow }],
};
function saved(overrides: Partial<PaypalResponse> = {}): PaypalResponse {
  return {
    ok: true,
    replayed: false,
    supporter: founder,
    payment,
    founder: { awarded: true, eligible: true, blockedReason: null },
    ...overrides,
  };
}
const savedWithoutFounder = saved({
  supporter: notFounder,
  founder: { awarded: false, eligible: false, blockedReason: "outside_window" },
});
/** An error as the dashboard's API client throws it. */
const failure = (message: string, status: number, blockedReason?: string) =>
  Object.assign(new Error(message), { status }, blockedReason ? { blockedReason } : {});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** The JSON bodies posted to the PayPal endpoint, in order. */
function posted() {
  return request.mock.calls
    .filter(([path, options]) => path === "supporters/paypal" && options?.method === "POST")
    .map(([, options]) => JSON.parse(String(options?.body)) as Record<string, unknown>);
}

/** A complete, valid form. Each test changes only what it is about. */
const validFields = {
  displayName: "Dana Donor",
  discordId: "123456789012345678",
  amount: "5",
  currency: "USD",
  paidAt: "2026-10-01T12:00",
  transactionId: "8ab12345cd678901e",
  firstPayment: "yes",
  steamId: "",
  completedPaymentVerified: "on",
  reason: "Checked the payment in PayPal.",
};
function formData(changes: Record<string, string | null> = {}) {
  const values = new FormData();
  for (const [name, value] of Object.entries({ ...validFields, ...changes }))
    if (value !== null) values.set(name, value);
  return values;
}
const now = Date.parse("2026-10-04T15:00:00Z");
const requestId = "33333333-3333-4333-8333-333333333333";
/** Whether the server's own schema accepts this body. */
const serverAccepts = (body: object) => paypalSchema.safeParse({ id: requestId, ...body }).success;

describe("the PayPal entry the form builds", () => {
  it("is a body the server's schema accepts, with text tidied and local time sent as UTC", () => {
    const entry = paypalEntry(
      formData({
        displayName: "  Dana Donor ",
        steamId: " 76561198000000001 ",
        currency: "usd",
        minimumConfirmed: "on",
      }),
      true,
      now,
    );
    expect(entry).toEqual({
      displayName: "Dana Donor",
      discordId: "123456789012345678",
      steamId: "76561198000000001",
      paidAt: new Date("2026-10-01T12:00").toISOString(),
      amountCents: 500,
      currency: "USD",
      transactionId,
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: true,
      minimumConfirmed: true,
      awardFounder: true,
      reason: "Checked the payment in PayPal.",
    });
    expect(serverAccepts(entry)).toBe(true);
  });

  it("leaves out an empty Discord ID or SteamID and sends each answer as given", () => {
    const entry = paypalEntry(formData({ discordId: "", firstPayment: "no" }), false, now);
    expect(entry).not.toHaveProperty("discordId");
    expect(entry).not.toHaveProperty("steamId");
    expect(entry).toMatchObject({
      firstSuccessfulPaymentVerified: false,
      minimumConfirmed: false,
      awardFounder: false,
    });
    expect(serverAccepts(entry)).toBe(true);
  });

  it("asks for a founder only on a first payment, the only kind the server makes a founder from", () => {
    expect(paypalEntry(formData(), true, now).awardFounder).toBe(true);
    expect(paypalEntry(formData({ firstPayment: "no" }), true, now)).toMatchObject({
      firstSuccessfulPaymentVerified: false,
      awardFounder: false,
    });
    // Staff chose to save the payment alone after the server refused a founder.
    expect(paypalEntry(formData(), false, now)).toMatchObject({
      firstSuccessfulPaymentVerified: true,
      awardFounder: false,
    });
    // Skipping the request is right only while the server's own rule refuses every payment that is not the first.
    const facts = {
      source: "paypal",
      verificationState: "verified",
      paidAt: "2026-10-01T16:00:00Z",
      amountCents: 500,
      currency: "USD",
    };
    const serverPolicy = { ...policy, source: "SUPPORTER_FOUNDER" as const };
    const others = { earlierPayment: false, hasIdentity: true, otherFounder: false };
    expect(founderBlocker({ ...facts, firstSuccessfulPaymentVerified: true }, serverPolicy, others)).toBeNull();
    expect(founderBlocker({ ...facts, firstSuccessfulPaymentVerified: false }, serverPolicy, others)).toBe(
      "not_first_payment",
    );
  });

  it.each([
    ["a 120-character name", { displayName: "n".repeat(120) }],
    ["a 17-digit Discord ID", { discordId: "1".repeat(17) }],
    ["a 20-digit Discord ID", { discordId: "1".repeat(20) }],
    ["one cent", { amount: "0.01" }],
    ["an amount without a leading zero", { amount: ".5" }],
    ["the largest amount", { amount: "1000000.00" }],
    ["another currency", { currency: "eur" }],
    ["a 10-character transaction ID", { transactionId: "A1B2C3D4E5" }],
    ["a 30-character transaction ID", { transactionId: "A".repeat(30) }],
    ["a 3-character reason", { reason: "Yes" }],
    ["a 200-character reason", { reason: "r".repeat(200) }],
    ["a time five minutes ahead", { paidAt: localMinute(new Date(now + 5 * 60_000)) }],
  ])("accepts %s, as the server does", (_label, changes) => {
    expect(serverAccepts(paypalEntry(formData(changes), true, now))).toBe(true);
  });

  // Each row is what staff typed, and the same value as a request body. The form and the server refuse both.
  it.each([
    ["no name", { displayName: "   " }, { displayName: "   " }],
    ["a 121-character name", { displayName: "n".repeat(121) }, { displayName: "n".repeat(121) }],
    ["a control character in the name", { displayName: "Dana\u0007" }, { displayName: "Dana\u0007" }],
    ["a 16-digit Discord ID", { discordId: "1".repeat(16) }, { discordId: "1".repeat(16) }],
    ["a 21-digit Discord ID", { discordId: "1".repeat(21) }, { discordId: "1".repeat(21) }],
    ["a Discord name", { discordId: "dana#1234" }, { discordId: "dana#1234" }],
    ["a zero amount", { amount: "0" }, { amountCents: 0 }],
    ["an amount over the limit", { amount: "1000000.01" }, { amountCents: 100_000_001 }],
    ["a 2-letter currency", { currency: "US" }, { currency: "US" }],
    ["a currency symbol", { currency: "U$D" }, { currency: "U$D" }],
    ["a 9-character transaction ID", { transactionId: "A1B2C3D4E" }, { transactionId: "A1B2C3D4E" }],
    ["a 31-character transaction ID", { transactionId: "A".repeat(31) }, { transactionId: "A".repeat(31) }],
    ["a transaction ID with a dash", { transactionId: "ABC-1234567" }, { transactionId: "ABC-1234567" }],
    ["a transaction ID with a letter outside A to Z", { transactionId: "ABCDEFGHIß" }, { transactionId: "ABCDEFGHIß" }],
    ["no payment time", { paidAt: "" }, { paidAt: "" }],
    ["no first-payment answer", { firstPayment: "" }, { firstSuccessfulPaymentVerified: undefined }],
    ["an invalid SteamID", { steamId: "76561190000000001" }, { steamId: "76561190000000001" }],
    ["no completed-payment tick", { completedPaymentVerified: null }, { completedPaymentVerified: false }],
    ["a 2-character reason", { reason: "ok" }, { reason: "ok" }],
    ["a 201-character reason", { reason: "r".repeat(201) }, { reason: "r".repeat(201) }],
    ["a two-line reason", { reason: "Checked\nin PayPal" }, { reason: "Checked\nin PayPal" }],
  ])("refuses %s, as the server does", (_label, typed, sent) => {
    expect(() => paypalEntry(formData(typed), true, now)).toThrow(/^(Enter|Choose|Tick) /);
    expect(serverAccepts({ ...paypalEntry(formData(), true, now), ...sent })).toBe(false);
  });

  it("refuses an amount with more than two decimal places or anything that is not a number", () => {
    for (const amount of ["5.005", "5,00", "five", "-5", "1e3", ""])
      expect(() => paypalEntry(formData({ amount }), true, now)).toThrow("Enter an amount from 0.01 to 1000000.00.");
  });

  it("refuses a time more than five minutes ahead, the limit the server uses", () => {
    expect(() => paypalEntry(formData({ paidAt: localMinute(new Date(now + 6 * 60_000)) }), true, now)).toThrow(
      "Enter a payment time that is not in the future.",
    );
  });

  it("shows this minute in local time as the default payment time", () => {
    expect(localMinute(new Date(2026, 9, 4, 9, 5, 42))).toBe("2026-10-04T09:05");
    expect(new Date(localMinute(new Date(now))).getTime()).toBe(now);
  });
});

const field = (label: string) => screen.getByLabelText(new RegExp(`^${label.replace(/[?()]/g, "\\$&")}`));
/** Fills the open form with a valid entry, then applies the changes. */
function fill(changes: Record<string, string> = {}) {
  const typed = {
    Name: validFields.displayName,
    "Discord user ID": validFields.discordId,
    Amount: validFields.amount,
    "Paid on": validFields.paidAt,
    "PayPal transaction ID": validFields.transactionId,
    "First payment?": validFields.firstPayment,
    ...changes,
  };
  for (const [label, value] of Object.entries(typed)) fireEvent.change(field(label), { target: { value } });
  const completed = screen.getByLabelText<HTMLInputElement>("Shows Completed in PayPal");
  if (!completed.checked) fireEvent.click(completed);
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save supporter" }));

describe("Add PayPal supporter", () => {
  const onRecorded = vi.fn();
  const onOpen = vi.fn();
  function open(value: AdminContextValue = context, unavailable = false) {
    const view = render(
      <AdminContext.Provider value={value}>
        <AddPaypalSupporter unavailable={unavailable} policy={policy} onRecorded={onRecorded} onOpen={onOpen} />
      </AdminContext.Provider>,
    );
    const button = screen.queryByRole("button", { name: "Add PayPal supporter" });
    if (button && !button.hasAttribute("disabled")) fireEvent.click(button);
    return view;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockReset();
    // Only the clock is fixed; timers stay real so the screen queries can wait.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is for administrators only and waits for current records", () => {
    const { unmount } = open({ ...context, me: { ...context.me, role: "moderator" } });
    expect(screen.queryByRole("button", { name: "Add PayPal supporter" })).not.toBeInTheDocument();
    unmount();
    const stale = open(context, true);
    expect(screen.getByRole("button", { name: "Add PayPal supporter" })).toBeDisabled();
    stale.unmount();
    open({ ...context, busy: true });
    expect(screen.getByRole("button", { name: "Add PayPal supporter" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens ready to type, with USD, this minute and a reason filled in", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Add PayPal supporter" });
    expect(field("Name")).toHaveFocus();
    expect(field("Currency")).toHaveValue("USD");
    expect(field("Paid on")).toHaveValue(localMinute(new Date(now)));
    expect(field("First payment?")).toHaveValue("");
    expect(within(dialog).getByText("No saves it without a founder.")).toBeInTheDocument();
    expect(screen.getByLabelText("Reason")).toHaveValue("Checked the payment in PayPal.");
    expect(screen.getByLabelText("Shows Completed in PayPal")).not.toBeChecked();
    // A founder is the server's decision, so the form has nothing to tick for it.
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save without founder" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("saves one valid entry, asks for a founder, and shows the record with the server's verdict", async () => {
    request.mockResolvedValue(saved());
    open();
    fill();
    save();
    expect(await screen.findByRole("dialog", { name: "Supporter saved" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    const [body] = posted();
    expect(body).toEqual({
      id: expect.stringMatching(uuid),
      displayName: "Dana Donor",
      discordId: "123456789012345678",
      paidAt: new Date("2026-10-01T12:00").toISOString(),
      amountCents: 500,
      currency: "USD",
      transactionId,
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: true,
      minimumConfirmed: false,
      awardFounder: true,
      reason: "Checked the payment in PayPal.",
    });
    expect(paypalSchema.safeParse(body).success).toBe(true);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Saved as a founder.");
    // The result moves focus in an effect, which can run after the save's last render.
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.getByText("Dana Donor")).toBeInTheDocument();
    expect(screen.getByText(/^5\.00 USD · /)).toBeInTheDocument();
    expect(screen.getByText(`Transaction ${transactionId}`)).toBeInTheDocument();
    expect(screen.getByText("Discord 123456789012345678")).toBeInTheDocument();
    expect(screen.getByText("Founder")).toBeInTheDocument();
    expect(screen.getByText("With Discord roles on, Gramps checks their roles next.")).toBeInTheDocument();
    expect(screen.getByText("No whitelist application from this Discord account.")).toBeInTheDocument();
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(context.setBusy).toHaveBeenNthCalledWith(1, true);
    expect(context.setBusy).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Open record" }));
    expect(onOpen).toHaveBeenCalledWith(founder);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends one request however often Save is pressed while it is saving", async () => {
    const pending = deferred<PaypalResponse>();
    request.mockReturnValue(pending.promise);
    open();
    fill();
    const form = screen.getByRole("button", { name: "Save supporter" }).closest("form")!;
    // Two submits before the screen can update, as a double click sends them.
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(posted()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(field("Name")).toBeDisabled();
    fireEvent.submit(form);
    expect(posted()).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    pending.resolve(saved());
    expect(await screen.findByText("Saved as a founder.")).toBeInTheDocument();
    expect(posted()).toHaveLength(1);
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it("says what to fix before anything is sent", () => {
    open();
    fill({ "Discord user ID": "dana#1234" });
    save();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the Discord user ID, 17 to 20 digits.");
    fill({ "PayPal transaction ID": "ABC-1234567" });
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the PayPal transaction ID, 10 to 30 letters and digits.",
    );
    fill({ "Paid on": localMinute(new Date(now + 3_600_000)) });
    save();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a payment time that is not in the future.");
    expect(request).not.toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
    expect(context.setBusy).not.toHaveBeenCalled();
  });

  it("shows the server's own words when it refuses a founder, saves nothing, then saves the payment alone when asked", async () => {
    request.mockRejectedValue(failure(`${outsideWindow} Nothing was recorded.`, 409, "outside_window"));
    open();
    fill();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(`${outsideWindow} Nothing was recorded.`);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add PayPal supporter" })).toBeInTheDocument();
    // Saving the payment alone is the next step, so it is the main button and one more Enter finishes the entry.
    const alone = screen.getByRole("button", { name: "Save without founder" });
    expect(alone).toBeEnabled();
    await waitFor(() => expect(alone).toHaveFocus());
    expect(alone).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Save supporter" })).toHaveClass("secondary");
    // It takes focus right after a press meant for Save supporter. A held Enter or a double click does not press it.
    const held = createEvent.keyDown(alone, { key: "Enter", repeat: true });
    fireEvent(alone, held);
    expect(held.defaultPrevented).toBe(true);
    const pressed = createEvent.keyDown(alone, { key: "Enter" });
    fireEvent(alone, pressed);
    expect(pressed.defaultPrevented).toBe(false);
    fireEvent.click(alone, { detail: 2 });
    expect(posted()).toHaveLength(1);
    // The refusal was for that entry. An edited entry asks the server for a founder again.
    fireEvent.change(field("Paid on"), { target: { value: "2026-10-02T12:00" } });
    expect(screen.queryByRole("button", { name: "Save without founder" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save supporter" })).toHaveClass("primary");
    save();
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]).toMatchObject({ awardFounder: true, paidAt: new Date("2026-10-02T12:00").toISOString() });
    request.mockResolvedValue(savedWithoutFounder);
    fireEvent.click(await screen.findByRole("button", { name: "Save without founder" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/^Saved\.$/);
    const bodies = posted();
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual({ ...bodies[1], id: expect.stringMatching(uuid), awardFounder: false });
    expect(new Set(bodies.map((body) => body.id)).size).toBe(3);
    expect(paypalSchema.safeParse(bodies[2]).success).toBe(true);
    expect(screen.getByText("Not a founder")).toBeInTheDocument();
    expect(screen.getByText(outsideWindow)).toBeInTheDocument();
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // The refusal belonged to that entry, so the next one starts without it.
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));
    expect(screen.queryByRole("button", { name: "Save without founder" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save supporter" })).toHaveClass("primary");
  });

  it("saves a payment that is not the first in one step, without asking for a founder", async () => {
    const notFirst = "Staff have not confirmed this was the supporter's first successful payment.";
    request.mockResolvedValue(
      saved({
        supporter: {
          ...notFounder,
          founderBlockedReason: "not_first_payment",
          founderBlockedMessage: notFirst,
          nextSteps: [{ code: "founder_not_first_payment", area: "payment", message: notFirst }],
        },
        payment: { ...payment, firstSuccessfulPaymentVerified: false },
        founder: { awarded: false, eligible: false, blockedReason: "not_first_payment" },
      }),
    );
    open();
    fill({ "First payment?": "no" });
    save();
    expect(await screen.findByRole("status")).toHaveTextContent(/^Saved\.$/);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({ firstSuccessfulPaymentVerified: false, awardFounder: false });
    expect(paypalSchema.safeParse(posted()[0]).success).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The founder verdict and the next step are the server's, shown as it sent them.
    expect(screen.getByText("Not a founder")).toBeInTheDocument();
    expect(screen.getByText(notFirst)).toBeInTheDocument();
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it("keeps Save without founder until the entry is saved, and repeats an unconfirmed save as the same request", async () => {
    request.mockRejectedValueOnce(failure(`${outsideWindow} Nothing was recorded.`, 409, "outside_window"));
    open();
    fill();
    save();
    const alone = () => screen.getByRole("button", { name: "Save without founder" });
    await waitFor(() => expect(alone()).toHaveFocus());
    // A refusal that is not about the founder leaves the payment still to save alone.
    request.mockRejectedValueOnce(failure("Too many requests. Try again shortly.", 429));
    fireEvent.click(alone());
    expect(await screen.findByText("Too many requests. Try again shortly.")).toBeInTheDocument();
    await waitFor(() => expect(alone()).toHaveFocus());
    expect(onRecorded).not.toHaveBeenCalled();
    // The server may have saved the payment before the answer was lost.
    request.mockRejectedValueOnce(failure("The request timed out before confirmation.", 0));
    fireEvent.click(alone());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^The save could not be confirmed\. Save again to check\. The same payment never saves twice\.$/,
    );
    expect(alone()).toBeEnabled();
    await waitFor(() => expect(alone()).toHaveFocus());
    expect(alone()).toHaveClass("primary");
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // Save supporter asks for the founder again and is refused. Save without founder stays.
    request.mockRejectedValueOnce(failure("Already recorded; use the founder action.", 409));
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Already recorded; use the founder action\.$/);
    expect(alone()).toBeEnabled();
    request.mockResolvedValueOnce({ ...savedWithoutFounder, replayed: true });
    fireEvent.click(alone());
    expect(await screen.findByRole("dialog", { name: "Already saved" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This payment was already on record.");
    expect(screen.getByText("Not a founder")).toBeInTheDocument();
    const bodies = posted();
    expect(bodies.map((body) => body.awardFounder)).toEqual([true, false, false, true, false]);
    // Each choice keeps its own request ID, so the server sees every repeat as the request it already had.
    expect(bodies[2]).toEqual(bodies[1]);
    expect(bodies[4]).toEqual(bodies[1]);
    expect(bodies[3]).toEqual(bodies[0]);
    expect(bodies[1]).toEqual({ ...bodies[0], id: expect.stringMatching(uuid), awardFounder: false });
    expect(bodies[1].id).not.toBe(bodies[0].id);
    expect(onRecorded).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a bad request", 400, "Check the PayPal transaction ID, amount, currency, accounts, confirmations and reason."],
    [
      "a conflict",
      409,
      "This PayPal transaction is already recorded with different details. Search the transaction ID.",
    ],
    ["a busy server", 429, "Too many requests. Try again shortly."],
  ])("shows the server's own words for %s and keeps the entry", async (_label, status, message) => {
    request.mockRejectedValue(failure(message, status));
    open();
    fill();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(new RegExp(`^${message.replace(/\./g, "\\.")}$`));
    // Nothing was saved, so there is nothing to read again and no way round the refusal.
    expect(onRecorded).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save without founder" })).not.toBeInTheDocument();
    expect(field("Name")).toHaveValue("Dana Donor");
    expect(screen.getByRole("button", { name: "Save supporter" })).toBeEnabled();
    expect(context.setBusy).toHaveBeenLastCalledWith(false);
    save();
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]).toEqual(posted()[0]);
  });

  it("repeats the same request after an unconfirmed save, so the server cannot save the payment twice", async () => {
    request.mockRejectedValueOnce(failure("The request timed out before confirmation.", 0));
    open();
    fill();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^The save could not be confirmed\. Save again to check\. The same payment never saves twice\.$/,
    );
    // The payment may be saved, so the page reads its records again.
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // Saving took focus off the button. It is back, so Enter saves again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save supporter" })).toHaveFocus());
    request.mockRejectedValueOnce(failure("Supporter records are temporarily unavailable.", 503));
    save();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Supporter records are temporarily unavailable. Save again to check.",
      ),
    );
    request.mockResolvedValueOnce(saved({ replayed: true }));
    save();
    expect(await screen.findByRole("dialog", { name: "Already saved" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This payment was already on record.");
    expect(screen.queryByText(/Gramps checks their roles/)).not.toBeInTheDocument();
    const bodies = posted();
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(onRecorded).toHaveBeenCalledTimes(3);
  });

  it("reads the records again when the server saved but could not read the record back", async () => {
    request.mockRejectedValue(failure("The PayPal record could not be read back. Refresh.", 404));
    open();
    fill();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("The save could not be confirmed. Save again to check.");
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save without founder" })).not.toBeInTheDocument();
  });

  it.each([
    ["no record", saved({ supporter: null })],
    ["another transaction", saved({ payment: { ...payment, reference: "ANOTHERPAYMENT1" } })],
    ["no founder verdict", saved({ founder: null })],
    ["a failed flag", saved({ ok: false })],
  ])("does not call an answer with %s saved", async (_label, answer) => {
    request.mockResolvedValue(answer);
    open();
    fill();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("The save could not be confirmed. Save again to check.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it("asks about the US$5 minimum only for another currency", async () => {
    request.mockResolvedValue(saved());
    open();
    expect(screen.queryByLabelText("Worth US$5 or more")).not.toBeInTheDocument();
    fill({ Currency: "eur" });
    fireEvent.click(screen.getByLabelText("Worth US$5 or more"));
    save();
    expect(await screen.findByText("Saved as a founder.")).toBeInTheDocument();
    expect(posted()[0]).toMatchObject({ currency: "EUR", minimumConfirmed: true });
  });

  it("starts a fresh entry with its own request ID for Add another", async () => {
    request.mockResolvedValue(saved());
    open();
    fill({ Currency: "eur" });
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Add another" }));
    expect(screen.getByRole("dialog", { name: "Add PayPal supporter" })).toBeInTheDocument();
    expect(field("Name")).toHaveValue("");
    expect(field("Name")).toHaveFocus();
    expect(field("Currency")).toHaveValue("USD");
    expect(field("PayPal transaction ID")).toHaveValue("");
    expect(screen.getByLabelText("Shows Completed in PayPal")).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    request.mockResolvedValue(
      saved({ payment: { ...payment, reference: "9ZY98765XW432109V" }, supporter: { ...founder, discordId: null } }),
    );
    fill({ Name: "Eli Example", "Discord user ID": "", "PayPal transaction ID": "9zy98765xw432109v" });
    save();
    expect(await screen.findByText("No Discord account")).toBeInTheDocument();
    // Without a Discord account there is no role to check.
    expect(screen.queryByText(/Gramps checks their roles/)).not.toBeInTheDocument();
    const bodies = posted();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("discordId");
    expect(bodies[1].id).not.toBe(bodies[0].id);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("the Supporters page", () => {
  const list: SupportersResponse = {
    enabled: false,
    configured: false,
    webhookConfigured: false,
    founderPolicy: policy,
    supporters: [],
    note: "Private records",
    sync: {
      configured: false,
      running: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      tokenRejected: false,
      members: 0,
      newMembers: 0,
      updated: 0,
      payments: 0,
      discordLinks: 0,
      conflicts: 0,
      truncated: 0,
      revokedPayments: 0,
      paidMembers: 0,
      discordReported: 0,
      tierConfirmed: 0,
      tierConfirmedNew: 0,
      tierUnconfirmed: 0,
      tierPrices: "not_requested",
      memberListComplete: true,
      intervalMinutes: 30,
      nextAttemptAt: null,
      conflictDetails: [],
      founderReviews: [],
    },
  };
  const page = () =>
    render(
      <AdminContext.Provider value={context}>
        <SupportersPage />
      </AdminContext.Provider>,
    );
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockReset();
  });

  it("adds a PayPal supporter without Patreon, reads the records again and opens the new record", async () => {
    let recorded = false;
    request.mockImplementation(async (path, options) => {
      if (options?.method !== "POST") return recorded ? { ...list, supporters: [founder] } : list;
      recorded = true;
      return saved();
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Add PayPal supporter" }));
    expect(screen.getByRole("button", { name: "Record existing Patreon member" })).toBeDisabled();
    fill({ "Paid on": localMinute(new Date(Date.now() - 3_600_000)) });
    save();
    expect(await screen.findByText("Saved as a founder.")).toBeInTheDocument();
    expect(posted()).toHaveLength(1);
    // The list behind the dialog is read again and shows the new record.
    expect(await screen.findByRole("button", { name: "Review supporter" })).toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path === "supporters")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open record" }));
    const review = await screen.findByRole("dialog", { name: "Supporter record" });
    expect(within(review).getByText("PAYPAL SUPPORTER RECORD")).toBeInTheDocument();
    expect(within(review).getByText("Dana Donor")).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("saves again from the open dialog while the list behind it cannot be read", async () => {
    const down = "Supporter records are temporarily unavailable.";
    const refreshFailed = "Supporter records could not be refreshed. Refresh before recording another review.";
    const reads = () => request.mock.calls.filter(([path]) => path === "supporters").length;
    request.mockImplementation(async (path, options) => {
      if (options?.method === "POST") {
        // The first save is lost with the server. The repeat finds the payment saved.
        const sent = posted();
        if (sent.length === 1) throw failure(down, 503);
        const reference = String(sent[sent.length - 1].transactionId);
        return saved({ replayed: sent.length === 2, payment: { ...payment, reference } });
      }
      // Only the first read of the list works.
      if (reads() > 1) throw failure(down, 503);
      return list;
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Add PayPal supporter" }));
    fill({ "Paid on": localMinute(new Date(Date.now() - 3_600_000)) });
    save();
    const dialog = screen.getByRole("dialog", { name: "Add PayPal supporter" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      `${down} Save again to check. The same payment never saves twice.`,
    );
    // The page read its records again and could not, so its own buttons wait. The open entry does not.
    expect(await screen.findByText(refreshFailed)).toBeInTheDocument();
    expect(reads()).toBe(2);
    expect(screen.getByRole("button", { name: "Add PayPal supporter" })).toBeDisabled();
    const again = within(dialog).getByRole("button", { name: "Save supporter" });
    expect(again).toBeEnabled();
    await waitFor(() => expect(again).toHaveFocus());
    expect(field("Name")).toHaveValue("Dana Donor");
    fireEvent.click(again);
    expect(await screen.findByRole("dialog", { name: "Already saved" })).toBeInTheDocument();
    const bodies = posted();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].id).toMatch(uuid);
    // The next entry can be saved too, although the list still cannot be read.
    await waitFor(() => expect(reads()).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));
    expect(screen.getByText(refreshFailed)).toBeInTheDocument();
    fill({
      Name: "Eli Example",
      "Paid on": localMinute(new Date(Date.now() - 3_600_000)),
      "PayPal transaction ID": "9zy98765xw432109v",
    });
    expect(screen.getByRole("button", { name: "Save supporter" })).toBeEnabled();
    save();
    expect(await screen.findByRole("dialog", { name: "Supporter saved" })).toBeInTheDocument();
    expect(posted()).toHaveLength(3);
    expect(posted()[2]).toMatchObject({ displayName: "Eli Example", transactionId: "9ZY98765XW432109V" });
    expect(posted()[2].id).not.toBe(bodies[0].id);
  });
});
