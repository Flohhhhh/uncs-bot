import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { SupportersPage } from "./index";
import { PatreonImport, ago, ahead } from "./patreon-sync";
import { applicationSteamId, founderReady, founderWindowLabel, reviewInput } from "./policy";
import type {
  FounderPolicy,
  NextStep,
  PatreonSyncResponse,
  PatreonSyncStatus,
  PaymentEvidence,
  SteamMatchBlock,
  Supporter,
  SupporterReviewResponse,
  SupportersResponse,
} from "./types";

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
const payment: PaymentEvidence = {
  id: "01234567-89ab-4cde-8fab-0123456789ac",
  paidAt: policy.startsAt!,
  amountCents: 500,
  currency: "USD",
  source: "manual_receipt",
  reference: "first-payment-receipt",
  verificationState: "verified",
  firstSuccessfulPaymentVerified: true,
};
/** Ready for staff to make a founder: both accounts added by staff, so Gramps would not do it itself. */
const supporter: Supporter = {
  id: "01234567-89ab-4cde-8fab-0123456789ab",
  provider: "patreon",
  patreonMemberId: "patreon-member-1",
  confirmKey: "patreon-member-1",
  displayName: "<img src=x onerror=alert(1)>",
  patronStatus: "active_patron",
  lastChargeStatus: "Paid",
  lastChargeAt: "2026-10-30T15:00:00Z",
  observedAt: "2026-10-30T15:00:00Z",
  reviewState: "pending",
  discordId: "23456789012345678",
  discordSource: "staff",
  patreonDiscordId: null,
  steamId: "76561198000000001",
  steamSource: "staff",
  steamApplicationId: null,
  identityState: "staff_linked",
  version: 7,
  latestPayment: {
    ...payment,
    id: "01234567-89ab-4cde-8fab-0123456789ad",
    paidAt: "2026-10-30T15:00:00Z",
    reference: "renewal-receipt",
    firstSuccessfulPaymentVerified: false,
  },
  founderEligiblePayment: payment,
  founder: null,
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
  automaticBlockedReason: "discord_not_from_patreon",
  automaticBlockedMessage: "The Discord account was entered by staff.",
  nextSteps: [{ code: "founder_ready_staff", area: "founder", message: "Ready to be made a founder." }],
};
/** The same patron with an unconfirmed first payment: not a founder, and a payment to add. */
const unpaid: Supporter = {
  ...supporter,
  founderEligiblePayment: null,
  founderBlockedReason: "not_first_payment",
  founderBlockedMessage: "Not confirmed as their first payment.",
  nextSteps: [{ code: "founder_not_first_payment", area: "payment", message: "Not confirmed as their first payment." }],
};
const automaticSteam = { reason: null, steamId: "76561198000000009", applicationId: "app-1", serverId: "primary" };
const minute = 60_000;
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * minute).toISOString();
/** Last synced 5 min ago, next in 25 min. */
function syncStatus(overrides: Partial<PatreonSyncStatus> = {}): PatreonSyncStatus {
  return {
    configured: true,
    running: false,
    lastAttemptAt: minutesFromNow(-5.1),
    lastSuccessAt: minutesFromNow(-5),
    lastError: null,
    tokenRejected: false,
    members: 12,
    newMembers: 1,
    updated: 2,
    payments: 3,
    discordLinks: 1,
    conflicts: 0,
    truncated: 0,
    revokedPayments: 0,
    paidMembers: 10,
    discordReported: 1,
    tierConfirmed: 0,
    tierConfirmedNew: 0,
    tierUnconfirmed: 0,
    tierPrices: "not_requested",
    memberListComplete: true,
    intervalMinutes: 30,
    nextAttemptAt: minutesFromNow(25),
    conflictDetails: [],
    founderReviews: [],
    ...overrides,
  };
}
function data(record = supporter, sync = syncStatus()): SupportersResponse {
  return {
    enabled: true,
    configured: true,
    webhookConfigured: true,
    founderPolicy: policy,
    supporters: [record],
    note: "Private records",
    sync,
  };
}
function page(value = context) {
  return (
    <AdminContext.Provider value={value}>
      <SupportersPage />
    </AdminContext.Provider>
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function postCalls() {
  return request.mock.calls.filter(([, options]) => options?.method === "POST");
}
/** The row's Open button, once the list has loaded. */
const openButton = (name = supporter.displayName!) => screen.findByRole("button", { name: `Open ${name}` });
/** Opens a record's dialog and returns it. */
async function openRecord(name = supporter.displayName!) {
  fireEvent.click(await openButton(name));
  return screen.getByRole("dialog");
}
const rowOf = (name: string) => screen.getByText(name, { selector: "td strong" }).closest("tr")!;
/** The cell under a column heading in a table row. */
function cell(row: HTMLElement, label: string) {
  const headers = screen.getAllByRole("columnheader").map((header) => header.textContent ?? "");
  return within(row).getAllByRole("cell")[headers.findIndex((header) => header.includes(label))];
}
const openDetails = () => fireEvent.click(screen.getByText("Details", { selector: "summary" }));
/** The dialog's section under a heading. */
const section = (dialog: HTMLElement, heading: string) =>
  within(dialog).getByRole("heading", { name: heading }).parentElement!;
/** A fact in the dialog, by its label. */
const fact = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
});

it("searches all stored supporters on explicit submit rather than filtering only the newest records", async () => {
  request.mockImplementation(async (path) =>
    path.includes("?search=")
      ? data({ ...supporter, displayName: "Earlier donor from the full ledger", patreonMemberId: "older-member" })
      : data(),
  );
  render(page());
  await openButton();
  const search = screen.getByRole("searchbox", { name: "Search supporters" });
  expect(search).toHaveAttribute("placeholder", "Name or any ID");
  expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "old%_member" } });
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Earlier donor from the full ledger")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Earlier donor from the full ledger");
  expect(request).toHaveBeenLastCalledWith("supporters?search=old%25_member", expect.any(Object));
  // Fewer than 100 rows came back, so nothing was cut off.
  expect(screen.queryByText("Showing the newest 100.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await screen.findByText(supporter.displayName!);
  expect(request).toHaveBeenLastCalledWith("supporters", expect.any(Object));
});

it("says the list stops at the newest 100 only when it does", async () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    ...supporter,
    id: `record-${index}`,
    displayName: `Supporter ${index}`,
  }));
  request.mockResolvedValue({ ...data(), supporters: records });
  render(page());
  await openButton("Supporter 0");
  expect(screen.getByText("Showing the newest 100.")).toHaveClass("filter-note");
});

it("announces a failed search to screen readers without announcing the search while it loads", async () => {
  request.mockImplementation(async (path) => {
    if (String(path).includes("?search=")) throw new Error("The dashboard could not be reached.");
    return data();
  });
  render(page());
  await openButton();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search supporters" }), {
    target: { value: "Earlier donor" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(screen.getByText("Loading supporters…").closest("[role=alert], [aria-live]")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("Supporter records could not be loaded");
});

it("keeps a failed search changeable and clearable", async () => {
  request.mockImplementation(async (path) => {
    if (String(path).includes("?search=")) throw new Error("The dashboard could not be reached.");
    return data();
  });
  render(page());
  await openButton();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search supporters" }), {
    target: { value: "Wait..." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Supporter records could not be loaded");
  expect(request).toHaveBeenLastCalledWith("supporters?search=Wait...", expect.any(Object));
  expect(screen.getByRole("searchbox", { name: "Search supporters" })).toHaveValue("Wait...");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Supporter records could not be loaded");
  expect(request.mock.calls.filter(([path]) => path === "supporters?search=Wait...")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await openButton();
  expect(request).toHaveBeenLastCalledWith("supporters", expect.any(Object));
  expect(screen.getByRole("searchbox", { name: "Search supporters" })).toHaveValue("");
});

it("adds a Patreon member from Details only after the campaign membership is ticked", async () => {
  const response = deferred<SupporterReviewResponse>();
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? response.promise : { ...data(), supporters: [], webhookConfigured: false },
  );
  render(page());
  await screen.findByText("No supporters yet.");
  expect(screen.getByText("They appear after the next Patreon sync.")).toBeInTheDocument();
  // Only in Details, not in the toolbar.
  expect(screen.getByText("Add Patreon member").closest("details")).not.toBeNull();
  openDetails();
  fireEvent.click(screen.getByRole("button", { name: "Add Patreon member" }));
  const dialog = screen.getByRole("dialog", { name: "Add Patreon member" });
  expect(within(dialog).getByText("Patreon", { selector: ".eyebrow" })).toBeInTheDocument();
  expect(within(dialog).queryByText(/unverified record|Check their membership on/)).not.toBeInTheDocument();
  const checkbox = screen.getByRole("checkbox", { name: /I verified this membership belongs/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("Patreon membership ID"), { target: { value: "historic-member-123" } });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Checked historical member on the UNC Patreon page" },
  });
  const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
  fireEvent.submit(form);
  expect(postCalls()).toHaveLength(0);
  expect(screen.getByRole("alert")).toHaveTextContent("campaign confirmation");
  fireEvent.click(checkbox);
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(postCalls()).toHaveLength(1);
  const [path, options] = postCalls()[0];
  expect(path).toBe("supporters/manual-member");
  expect(JSON.parse(String(options?.body))).toEqual({
    id: expect.any(String),
    patreonMemberId: "historic-member-123",
    displayName: null,
    campaignMembershipVerified: true,
    reason: "Checked historical member on the UNC Patreon page",
  });
  expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await act(async () =>
    response.resolve({
      ok: true,
      replayed: false,
      supporter: {
        ...supporter,
        patreonMemberId: "historic-member-123",
        version: 1,
        reviewState: "unverified",
        patronStatus: null,
        lastChargeStatus: null,
        latestPayment: null,
        founderEligiblePayment: null,
        founder: null,
      },
    }),
  );
  await screen.findByRole("heading", { name: "Saved" });
  expect(screen.getByRole("status")).toHaveTextContent(/^Nothing else changed\.$/);
  expect(postCalls()).toHaveLength(1);
});

it("does not offer manual entry when Patreon is not configured or to a moderator", async () => {
  request.mockResolvedValue({ ...data(), configured: false });
  const view = render(page());
  await openButton();
  openDetails();
  expect(screen.getByRole("button", { name: "Add Patreon member" })).toBeDisabled();
  view.rerender(page({ ...context, me: { ...context.me, role: "moderator" } }));
  expect(screen.queryByRole("button", { name: "Add Patreon member" })).not.toBeInTheDocument();
});

it("keeps an uncertain manual entry out of the success state and never resubmits it", async () => {
  request.mockImplementation(async (_path, options) => (options?.method === "POST" ? { ok: true } : data()));
  render(page());
  await openButton();
  openDetails();
  fireEvent.click(screen.getByRole("button", { name: "Add Patreon member" }));
  fireEvent.change(screen.getByLabelText("Patreon membership ID"), { target: { value: "historic-member-123" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Checked the creator record" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I verified this membership belongs/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Not sure it saved" });
  expect(screen.getByText("Close and reload before trying again.")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/^The save could not be confirmed\. Review ID: [0-9a-f-]{36}$/);
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("waits for a refreshed supporter revision before opening a record", async () => {
  const refreshed = deferred<SupportersResponse>();
  request
    .mockResolvedValueOnce(data())
    .mockReturnValueOnce(refreshed.promise)
    .mockImplementation(async (_path, options) =>
      options?.method === "POST"
        ? { ok: true, replayed: false, supporter: { ...supporter, version: 10 } }
        : data({ ...supporter, version: 10 }),
    );
  const view = render(page());
  await openButton();
  view.rerender(page({ ...context, refreshVersion: 1 }));
  const open = screen.getByRole("button", { name: `Open ${supporter.displayName}` });
  expect(open).toBeDisabled();
  fireEvent.click(open);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => refreshed.resolve(data({ ...supporter, version: 9 })));
  await openRecord();
  fireEvent.click(screen.getByRole("button", { name: "Change accounts" }));
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: "76561198000000002" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ version: 9, reason: "Accounts changed" });
});

it("requires admin access and renders provider data as text", async () => {
  const view = render(page({ ...context, me: { ...context.me, role: "viewer" } }));
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(data());
  view.rerender(page());
  const dialog = await openRecord();
  expect(document.querySelector("img")).toBeNull();
  // The name is the dialog's title, its provider the eyebrow and its member ID beneath.
  expect(screen.getByRole("dialog", { name: supporter.displayName! })).toBe(dialog);
  expect(within(dialog).getByText("Patreon", { selector: ".eyebrow" })).toBeInTheDocument();
  expect(within(dialog).getByText("patreon-member-1")).toHaveClass("supporter-member");
  // No description before a result, and none of the old explanations.
  expect(dialog.querySelector("h2 + p.muted")).toBeNull();
  expect(dialog).not.toHaveTextContent(/Record timestamp|observation|evidence|promise|ADMIN ONLY/i);
});

it("keeps the page to a status line, a toolbar, chips and one card", async () => {
  request.mockResolvedValue(data());
  render(page());
  await openButton();
  expect(screen.queryByText(/Grants no game access|Records only/)).not.toBeInTheDocument();
  expect(screen.queryByText("Private records")).not.toBeInTheDocument();
  expect(screen.queryByText("ADMIN ONLY")).not.toBeInTheDocument();
  expect(screen.queryByText(/Patreon not configured/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Record existing Patreon member|Review supporter/ })).toBeNull();
  // The founder window is the card's subtitle, with its exact times in Details.
  expect(screen.getByText(founderWindowLabel(policy)).closest(".card-header")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Add PayPal supporter" })).toBeEnabled();
  expect(screen.queryByText(/Founder dates are not set/)).not.toBeInTheDocument();
  expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Supporter↕",
    "Discord↕",
    "Next↕",
    "Open",
  ]);
  expect(screen.getByText("Open", { selector: "th span" })).toHaveClass("sr-only");
});

it("warns when the founder dates are not set", async () => {
  request.mockResolvedValue({
    ...data(),
    founderPolicy: { ...policy, configured: false, startsAt: null, endsAt: null },
  });
  render(page());
  await openButton();
  expect(screen.getByText("Founder dates are not set.")).toHaveClass("notice", "warning");
  expect(screen.getByText("Founder window · dates not set")).toBeInTheDocument();
  openDetails();
  expect(screen.getByText("Founder window", { selector: "dt" }).nextElementSibling).toHaveTextContent(/^Not set$/);
});

it("filters loaded supporters with counted chips", async () => {
  const founder: Supporter = {
    ...supporter,
    id: "01234567-89ab-4cde-8fab-0123456789ff",
    patreonMemberId: "founder-member",
    displayName: "Founder supporter",
    founder: { awardedAt: policy.startsAt!, paymentId: payment.id },
    founderEligiblePayment: null,
    nextSteps: [],
  };
  const waiting: Supporter = {
    ...supporter,
    id: "01234567-89ab-4cde-8fab-0123456789fe",
    displayName: "Waiting supporter",
    nextSteps: [{ code: "founder_ready_automatic", area: "founder", message: "Gramps makes them a founder." }],
  };
  request.mockResolvedValue({ ...data(), supporters: [founder, waiting, supporter] });
  render(page());
  await screen.findByText("Founder supporter");
  const chips = screen.getByRole("group", { name: "Filter supporter records" });
  expect(
    within(chips)
      .getAllByRole("button")
      .map((chip) => chip.textContent),
  ).toEqual(["All 3", "Needs you 1", "Founders 1"]);
  expect(within(chips).getByRole("button", { name: "All 3" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(chips).getByRole("button", { name: "Founders 1" }));
  expect(within(chips).getByRole("button", { name: "Founders 1" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Founder supporter")).toBeInTheDocument();
  expect(screen.queryByText(supporter.displayName!)).not.toBeInTheDocument();
  fireEvent.click(within(chips).getByRole("button", { name: "Needs you 1" }));
  expect(screen.getByText(supporter.displayName!)).toBeInTheDocument();
  expect(screen.queryByText("Waiting supporter")).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

it("says no supporter matches a chip with nothing in it", async () => {
  request.mockResolvedValue(data({ ...supporter, nextSteps: [] }));
  render(page());
  await openButton();
  fireEvent.click(screen.getByRole("button", { name: "Needs you 0" }));
  expect(screen.getByText("No matching supporters")).toBeInTheDocument();
});

it("lists who needs staff first, then who is waiting, then who is all set", async () => {
  const set: Supporter = { ...supporter, id: "set", displayName: "Set supporter", nextSteps: [] };
  const waiting: Supporter = {
    ...supporter,
    id: "waiting",
    displayName: "Waiting supporter",
    nextSteps: [
      { code: "steam_ready_automatic", area: "steam", message: "Gramps adds their SteamID at the next sync." },
    ],
  };
  request.mockResolvedValue({ ...data(), supporters: [set, waiting, supporter] });
  render(page());
  await screen.findByText("Set supporter");
  const order = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td strong")!.textContent);
  expect(order()).toEqual([supporter.displayName, "Waiting supporter", "Set supporter"]);
  // The Next column sorts by the same order, both ways.
  fireEvent.click(screen.getByRole("button", { name: "Sort by Next" }));
  expect(order()).toEqual([supporter.displayName, "Waiting supporter", "Set supporter"]);
  fireEvent.click(screen.getByRole("button", { name: "Sort by Next" }));
  expect(order()).toEqual(["Set supporter", "Waiting supporter", supporter.displayName]);
  fireEvent.click(screen.getByRole("button", { name: "Sort by Supporter" }));
  expect(order()).toEqual([supporter.displayName, "Set supporter", "Waiting supporter"]);
});

it("shows who acts next, the first thing to do and how many more", async () => {
  const steps: NextStep[] = [
    { code: "steam_shared", area: "steam", message: "Another Discord account applied with this SteamID." },
    { code: "founder_ready_staff", area: "founder", message: "Ready to be made a founder." },
    { code: "no_whitelist_application", area: "steam", message: "No approved whitelist application yet." },
  ];
  const waiting: Supporter = {
    ...supporter,
    id: "waiting",
    displayName: "Waiting supporter",
    nextSteps: [
      {
        code: "connect_discord_in_patreon",
        area: "discord",
        message: "Waiting for them to connect Discord on Patreon.",
      },
      { code: "founder_ready_automatic", area: "founder", message: "Gramps makes them a founder at the next sync." },
    ],
  };
  const set: Supporter = {
    ...supporter,
    id: "set",
    displayName: "Set supporter",
    nextSteps: [{ code: "no_whitelist_application", area: "steam", message: "No approved whitelist application yet." }],
  };
  request.mockResolvedValue({
    ...data(),
    supporters: [{ ...supporter, steamId: null, nextSteps: steps }, waiting, set],
  });
  render(page());
  await screen.findByText("Set supporter");
  const needs = cell(rowOf(supporter.displayName!), "Next");
  expect(within(needs).getByText("Needs you")).toHaveClass("pill", "warn");
  expect(within(needs).getByText("Another Discord account applied with this SteamID. +1 more")).toHaveClass(
    "supporter-wrap",
  );
  const later = cell(rowOf("Waiting supporter"), "Next");
  expect(within(later).getByText("Waiting")).toHaveClass("pill", "neutral");
  expect(later).toHaveTextContent("Waiting for them to connect Discord on Patreon. +1 more");
  const done = cell(rowOf("Set supporter"), "Next");
  expect(within(done).getByText("All set")).toHaveClass("pill", "good");
  // A whitelist application only matters later, so it stays out of the table.
  expect(done).toHaveTextContent(/^All set$/);
});

it("labels each supporter with their provider, a Founder badge and an unpaid last charge", async () => {
  const records: Supporter[] = [
    { ...supporter, id: "a", displayName: "Active patron" },
    {
      ...supporter,
      id: "b",
      displayName: "Refunded founder",
      lastChargeStatus: "Refunded",
      founder: { awardedAt: policy.startsAt!, paymentId: payment.id },
    },
    { ...supporter, id: "c", displayName: "PayPal donor", provider: "paypal", patreonMemberId: null },
    { ...supporter, id: "d", displayName: "Former patron", patronStatus: "former_patron" },
  ];
  request.mockResolvedValue({ ...data(), supporters: records });
  render(page());
  await screen.findByText("Active patron");
  const small = (name: string) => cell(rowOf(name), "Supporter").querySelector("small")!;
  expect(small("Active patron")).toHaveTextContent(/^Patreon$/);
  expect(small("Refunded founder")).toHaveTextContent("Patreon · last charge Refunded");
  expect(small("Refunded founder")).toHaveClass("warning-text");
  expect(small("PayPal donor")).toHaveTextContent(/^PayPal$/);
  expect(small("Former patron")).toHaveTextContent("Patreon · former");
  expect(within(cell(rowOf("Refunded founder"), "Supporter")).getByText("Founder")).toHaveClass("pill", "good");
  expect(within(cell(rowOf("Active patron"), "Supporter")).queryByText("Founder")).not.toBeInTheDocument();
});

it("shows the Discord column's first matching state, with problems sorted first", async () => {
  const unlinked = { ...supporter, discordId: null, discordSource: null, identityState: "partial" as const };
  const records: Supporter[] = [
    { ...supporter, id: "linked", displayName: "Linked patron", discordSource: "patreon" },
    { ...unlinked, id: "soon", displayName: "Soon patron", patreonDiscordId: "34567890123456789" },
    { ...unlinked, id: "none", displayName: "Unconnected patron" },
    { ...unlinked, id: "missing", displayName: "PayPal donor", provider: "paypal", patreonMemberId: null },
    {
      ...supporter,
      id: "check",
      displayName: "Differs patron",
      patreonDiscordId: "34567890123456789",
      nextSteps: [
        { code: "discord_differs", area: "discord", message: "Patreon now shows a different Discord account." },
      ],
    },
    { ...supporter, id: "conflict", displayName: "Conflict patron" },
  ];
  const sync = syncStatus({
    conflicts: 1,
    conflictDetails: [{ supporterId: "conflict", patreonMemberId: "conflict-member", reason: "discord-in-use" }],
  });
  request.mockResolvedValue({ ...data(supporter, sync), supporters: records });
  render(page());
  await screen.findByText("Linked patron");
  const discord = (name: string) => cell(rowOf(name), "Discord");
  expect(discord("Linked patron")).toHaveTextContent(/^LinkedFrom Patreon$/);
  expect(discord("Soon patron")).toHaveTextContent(/^Linking soon$/);
  expect(discord("Unconnected patron")).toHaveTextContent(/^Not connected$/);
  expect(within(discord("PayPal donor")).getByText("Missing")).toHaveClass("pill", "warn");
  expect(within(discord("Differs patron")).getByText("Check")).toHaveClass("pill", "warn");
  expect(within(discord("Conflict patron")).getByText("Check")).toHaveClass("pill", "warn");
  // The conflict also puts the record under Needs you.
  expect(cell(rowOf("Conflict patron"), "Next")).toHaveTextContent(
    "Their Discord account is already on another supporter.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Sort by Discord" }));
  const order = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td strong")!.textContent);
  expect(order).toEqual([
    "Differs patron",
    "Conflict patron",
    "PayPal donor",
    "Unconnected patron",
    "Soon patron",
    "Linked patron",
  ]);
});

it("keeps rows as cards with a labelled Open button for each supporter", async () => {
  request.mockResolvedValue(data());
  render(page());
  const open = await openButton();
  expect(open).toHaveTextContent(/^Open$/);
  expect(open.closest(".table-wrap")).toHaveAttribute("data-mobile", "cards");
  // The button's own actions wrapper drops the card label, and the step takes the card's full width.
  expect(open.closest("td")!.querySelector(".row-actions")).toContainElement(open);
  expect(cell(rowOf(supporter.displayName!), "Next")).toHaveClass("wide");
});

it("labels the founder window by its last included New York day", () => {
  const day = (value: string) =>
    new Date(value).toLocaleDateString(undefined, { timeZone: "America/New_York", month: "short", day: "numeric" });
  // Midnight to midnight, end exclusive: the last included day is October 14.
  expect(founderWindowLabel(policy)).toBe(
    `Founder window ${day("2026-09-30T12:00:00Z")}–${day("2026-10-14T12:00:00Z")} (EDT)`,
  );
  expect(founderWindowLabel({ ...policy, endsAt: "2026-10-15T16:00:00Z" })).toMatch(/ until .+ \(EDT\)$/);
  expect(founderWindowLabel({ ...policy, endsAt: "2026-11-15T05:00:00Z" })).toMatch(/\(New York time\)$/);
  expect(founderWindowLabel({ ...policy, configured: false })).toBe("Founder window · dates not set");
  expect(founderWindowLabel({ ...policy, endsAt: policy.startsAt })).toBe("Founder window · dates not set");
});

it("follows the server's founder verdict instead of judging eligibility in the browser", () => {
  expect(founderReady(supporter)).toBe(true);
  expect(founderReady({ ...supporter, founderBlockedReason: "earlier_payment" })).toBe(false);
  expect(founderReady({ ...supporter, founderEligiblePayment: null })).toBe(false);
  expect(founderReady({ ...supporter, founder: { awardedAt: policy.startsAt!, paymentId: payment.id } })).toBe(false);
  // The server accepts one linked identity, so a Discord-only record or a PayPal record can be ready.
  expect(founderReady({ ...supporter, steamId: null, identityState: "partial" })).toBe(true);
  expect(founderReady({ ...supporter, provider: "paypal", patreonMemberId: null, confirmKey: supporter.id })).toBe(
    true,
  );
});

it("makes a founder from a verified first payment from the Patreon import, as a confirmed second step", async () => {
  const imported: PaymentEvidence = { ...payment, source: "patreon_api", reference: "patreon-event-1" };
  const record = { ...supporter, founderEligiblePayment: imported };
  expect(founderReady(record)).toBe(true);
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? {
          ok: true,
          replayed: false,
          supporter: { ...record, version: 8, founder: { awardedAt: policy.startsAt!, paymentId: imported.id } },
        }
      : data(record),
  );
  render(page());
  const dialog = await openRecord();
  const make = within(dialog).getByRole("button", { name: "Make founder" });
  expect(make).toHaveClass("primary");
  fireEvent.click(make);
  expect(postCalls()).toHaveLength(0);
  expect(screen.getByRole("dialog", { name: "Make founder" })).toBe(dialog);
  expect(within(dialog).getByText(`${supporter.displayName} · patreon-member-1`)).toBeInTheDocument();
  const shown = section(dialog, "Payment");
  expect(shown).toHaveTextContent("5.00 USD · from Patreon · first payment");
  expect(shown).toHaveTextContent(new Date(imported.paidAt).toLocaleString());
  expect(shown).toHaveTextContent("Reference patreon-event-1");
  expect(within(dialog).getByText("This is permanent.")).toBeInTheDocument();
  expect(within(dialog).queryByText(/skips the refund wait/)).not.toBeInTheDocument();
  expect(within(dialog).getByText("Gramps updates their Discord roles after you save.")).toBeInTheDocument();
  expect(screen.getByLabelText("Reason")).toHaveValue("Founder confirmed");
  expect(screen.getByLabelText("Reason")).toHaveFocus();
  const footer = dialog.querySelector(".dialog-footer")!;
  expect(
    within(footer as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Cancel", "Make founder"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Make founder" }));
  await screen.findByRole("heading", { name: "Saved" });
  expect(postCalls()[0][0]).toBe(`supporters/${supporter.id}/founder`);
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({
    version: 7,
    paymentId: imported.id,
    reason: "Founder confirmed",
  });
});

it("says making a founder now skips the refund wait, and keeps the button secondary while Gramps will do it", async () => {
  const record: Supporter = {
    ...supporter,
    automaticBlockedReason: "payment_too_recent",
    automaticBlockedMessage: "The first payment is still inside the waiting period for refunds.",
    nextSteps: [
      {
        code: "founder_automatic_waiting",
        area: "founder",
        message: "Gramps makes them a founder after the refund wait (2026-10-03 12:00 UTC).",
      },
    ],
  };
  request.mockResolvedValue(data(record));
  render(page());
  await openButton();
  expect(cell(rowOf(supporter.displayName!), "Next")).toHaveTextContent("Waiting");
  const dialog = await openRecord();
  expect(section(dialog, "Waiting")).toHaveTextContent("Gramps makes them a founder after the refund wait");
  // The wait already says when, so the Founder fact does not call it skipped.
  expect(dialog).not.toHaveTextContent("Gramps skipped this");
  const make = within(dialog).getByRole("button", { name: "Make founder" });
  expect(make).toHaveClass("secondary");
  fireEvent.click(make);
  expect(within(dialog).getByText("This is permanent. This skips the refund wait.")).toHaveClass("notice", "warning");
});

it("keeps Make founder secondary when Gramps makes them a founder at the next sync", async () => {
  request.mockResolvedValue(
    data({
      ...supporter,
      automaticBlockedReason: null,
      automaticBlockedMessage: null,
      nextSteps: [{ code: "founder_ready_automatic", area: "founder", message: "Gramps makes them a founder." }],
    }),
  );
  render(page());
  const dialog = await openRecord();
  expect(within(dialog).getByRole("button", { name: "Make founder" })).toHaveClass("secondary");
  expect(within(dialog).queryByRole("button", { name: "Add payment" })).not.toBeInTheDocument();
});

it("checks linked Steam account structure rather than a decimal prefix", () => {
  const input = new FormData();
  input.set("reason", "Checked this supporter's player identity");
  input.set("discordId", "123456789012345678");
  for (const steamId of ["76561197960265729", "76561202255233023"]) {
    input.set("steamId", steamId);
    expect(reviewInput(supporter, "link", "review-id", input)).toMatchObject({ steamId });
  }
  for (const steamId of ["76561190000000001", "76561197960265728", "76561202255233024"]) {
    input.set("steamId", steamId);
    expect(() => reviewInput(supporter, "link", "review-id", input)).toThrow("SteamID64");
  }
});

it("shows a blocked founder's reason as text, with no founder button", async () => {
  const message = "Patreon has not confirmed a payment yet.";
  request.mockResolvedValue(
    data({
      ...supporter,
      founderEligiblePayment: null,
      founderBlockedReason: "source_not_qualifying",
      founderBlockedMessage: message,
      nextSteps: [{ code: "founder_source_not_qualifying", area: "payment", message }],
    }),
  );
  render(page());
  // A payment step grants nothing, so the row is all set.
  expect(await screen.findByText("All set")).toBeInTheDocument();
  const dialog = await openRecord();
  expect(section(dialog, "Not a founder")).toHaveTextContent(message);
  // Once, although both the step and the verdict say it.
  expect(within(dialog).getAllByText(message)).toHaveLength(1);
  expect(within(dialog).queryByRole("heading", { name: "Needs you" })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Make founder" })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Add payment" })).toBeEnabled();
  expect(postCalls()).toHaveLength(0);
});

it("shows the server's founder verdict even when no step gives it", async () => {
  request.mockResolvedValue(
    data({
      ...supporter,
      founderEligiblePayment: null,
      founderBlockedReason: "outside_window",
      founderBlockedMessage: "Paid outside the founder window.",
      nextSteps: [],
    }),
  );
  render(page());
  const dialog = await openRecord();
  expect(section(dialog, "Not a founder")).toHaveTextContent("Paid outside the founder window.");
  // Not a payment problem, so there is no payment to add.
  expect(within(dialog).queryByRole("button", { name: "Add payment" })).not.toBeInTheDocument();
});

it("makes a founder from the qualifying payment rather than the latest renewal, preserving UUID, member and revision", async () => {
  const response = deferred<SupporterReviewResponse>();
  request.mockImplementation(async (_path, options) => (options?.method === "POST" ? response.promise : data()));
  render(page());
  const dialog = await openRecord();
  // The record shows its latest payment; the founder form shows the one it is made on.
  expect(fact(dialog, "Payment")).toHaveTextContent(/^5\.00 USD · added by staff/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Make founder" }));
  expect(section(dialog, "Payment")).toHaveTextContent(`Reference ${payment.reference}`);
  expect(dialog).not.toHaveTextContent(supporter.latestPayment!.reference);
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Checked first payment and matched accounts." },
  });
  const form = within(dialog).getByRole("button", { name: "Make founder" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(postCalls()).toHaveLength(1);
  const [path, options] = postCalls()[0];
  const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
  expect(path).toBe(`supporters/${supporter.id}/founder`);
  expect(body).toMatchObject({
    version: 7,
    confirm: supporter.patreonMemberId,
    paymentId: payment.id,
    reason: "Checked first payment and matched accounts.",
  });
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await act(async () =>
    response.resolve({
      ok: true,
      replayed: false,
      supporter: {
        ...supporter,
        version: 8,
        founder: { awardedAt: policy.startsAt!, paymentId: payment.id },
        nextSteps: [],
      },
    }),
  );
  expect(screen.getByRole("dialog", { name: "Saved" })).toBe(dialog);
  expect(within(dialog).getByText("Gramps updates their Discord roles next.")).toBeInTheDocument();
  const status = within(dialog).getByRole("status");
  expect(status).toHaveTextContent(/^Saved\.$/);
  // The Save button is gone, so focus moves to the result.
  expect(status).toHaveFocus();
  // The record as saved.
  expect(fact(dialog, "Founder")).toHaveTextContent(/^Since .+Added by staff$/);
  expect(within(dialog).queryByRole("button", { name: /Make founder|Save/ })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
});

it("titles each form by its button, starts its reason and says Gramps updates roles after saving", async () => {
  request.mockResolvedValue({ ...data(), supporters: [supporter, { ...unpaid, id: "unpaid", displayName: "Unpaid" }] });
  render(page());
  const forms: [string, string, string, string][] = [
    [supporter.displayName!, "Make founder", "Founder confirmed", "Reason"],
    [supporter.displayName!, "Change accounts", "Accounts changed", "Discord user ID"],
    ["Unpaid", "Add payment", "Payment added", "Paid on"],
  ];
  for (const [name, action, reason, first] of forms) {
    const dialog = await openRecord(name);
    fireEvent.click(within(dialog).getByRole("button", { name: action }));
    expect(screen.getByRole("dialog", { name: action })).toBe(dialog);
    expect(within(dialog).getByText(`${name} · patreon-member-1`)).toBeInTheDocument();
    // The steps and facts make way for the form, whose first field takes focus.
    expect(within(dialog).queryByRole("heading", { name: /Needs you|Not a founder/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(`^${first}`))).toHaveFocus();
    expect(screen.getByLabelText("Reason")).toHaveValue(reason);
    expect(within(dialog).getByText("Gramps updates their Discord roles after you save.")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/staff evidence|game access/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }
});

it("adds a payment, with the first-payment box off and the payment check required", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...unpaid, version: 8 } } : data(unpaid),
  );
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Add payment" }));
  const first = screen.getByRole("checkbox", { name: /This was their first payment\./ });
  expect(first).not.toBeChecked();
  expect(within(dialog).getByText("Needed to make them a founder.")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/^Paid on/), { target: { value: "2020-10-01T12:30" } });
  fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "5.00" } });
  fireEvent.change(screen.getByLabelText("Patreon reference"), { target: { value: "receipt-123" } });
  const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
  fireEvent.submit(form);
  expect(postCalls()).toHaveLength(0);
  expect(screen.getByRole("alert")).toHaveTextContent("Confirm that you checked the completed payment in Patreon.");
  fireEvent.click(screen.getByRole("checkbox", { name: "I checked this payment in Patreon." }));
  fireEvent.submit(form);
  await screen.findByRole("heading", { name: "Saved" });
  const body = JSON.parse(String(postCalls()[0][1]?.body)) as Record<string, unknown>;
  expect(postCalls()[0][0]).toBe(`supporters/${supporter.id}/payment`);
  expect(body).toMatchObject({
    amountCents: 500,
    currency: "USD",
    reference: "receipt-123",
    completedPaymentVerified: true,
    firstSuccessfulPaymentVerified: false,
    version: 7,
    confirm: supporter.patreonMemberId,
    reason: "Payment added",
  });
  expect(body.paidAt).toBe(new Date("2020-10-01T12:30").toISOString());
});

it("changes accounts with the record's revision, sending only the identity that changed", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 8 } } : data(),
  );
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  expect(dialog).not.toHaveTextContent(/Leave a field as it is/);
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Matched the member to the supplied accounts." },
  });
  const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
  fireEvent.submit(form);
  // Resending unchanged values would turn a Patreon or application link into a staff link.
  expect(screen.getByRole("alert")).toHaveTextContent("Unchanged values are kept");
  expect(postCalls()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: "76561198000000002" } });
  fireEvent.submit(form);
  await screen.findByRole("heading", { name: "Saved" });
  expect(postCalls()[0][0]).toBe(`supporters/${supporter.id}/link`);
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toEqual({
    id: expect.any(String),
    version: 7,
    confirm: supporter.confirmKey,
    reason: "Matched the member to the supplied accounts.",
    steamId: "76561198000000002",
  });
});

it("says when Gramps also added the SteamID on a save", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? {
          ok: true,
          replayed: false,
          supporter: { ...supporter, version: 8 },
          automatic: { steamFilled: true, founderRecorded: false },
        }
      : data(),
  );
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  fireEvent.change(screen.getByLabelText("Discord user ID"), { target: { value: "34567890123456789" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /belongs to the new Discord account too/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByRole("status")).toHaveTextContent(/^Saved\. Gramps also added their SteamID\.$/);
});

it("a failed or mismatched save stays uncertain, keeps its review ID and cannot be retried from the same dialog", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 7 } } : data(),
  );
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: "76561198000000002" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Not sure it saved" });
  const id = JSON.parse(String(postCalls()[0][1]?.body)).id as string;
  expect(within(dialog).getByRole("status")).toHaveTextContent(`The save could not be confirmed. Review ID: ${id}`);
  expect(within(dialog).getByText("Close and reload before trying again.")).toBeInTheDocument();
  // The record may not be what was saved, so its facts are not shown as current.
  expect(within(dialog).queryByText("Discord", { selector: "dt" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("unmounting during a save cannot repopulate private supporter data or start a refresh", async () => {
  const response = deferred<SupporterReviewResponse>();
  request.mockImplementation(async (_path, options) => (options?.method === "POST" ? response.promise : data()));
  const view = render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: "76561198000000002" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const calls = request.mock.calls.length;
  view.rerender(page({ ...context, me: { ...context.me, role: "moderator" } }));
  await act(async () => response.resolve({ ok: true, replayed: false, supporter: { ...supporter, version: 8 } }));
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(screen.queryByText(supporter.patreonMemberId!)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(request.mock.calls).toHaveLength(calls);
});

it("shows four facts: where each account came from, the payment and how the founder was made", async () => {
  request.mockResolvedValue(
    data({
      ...supporter,
      discordSource: "patreon",
      patreonDiscordId: supporter.discordId,
      steamSource: "application",
      steamApplicationId: "app-1",
      identityState: "patreon_linked",
      latestPayment: { ...payment, source: "patreon_api" },
      match: {
        ...supporter.match,
        sourceApplication: { id: "app-1", serverId: "primary", status: "revoked" },
        sourceApplicationRevoked: true,
      },
      founder: { awardedAt: policy.startsAt!, paymentId: payment.id, source: "patreon_api", automatic: true },
      nextSteps: [
        {
          code: "source_application_revoked",
          area: "steam",
          message: "The application this SteamID came from is no longer approved.",
        },
      ],
    }),
  );
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(cell(row, "Discord")).toHaveTextContent(/^LinkedFrom Patreon$/);
  const dialog = await openRecord();
  expect(within(dialog).getAllByText(/^(Discord|SteamID|Payment|Founder)$/, { selector: "dt" })).toHaveLength(4);
  expect(fact(dialog, "Discord")).toHaveTextContent(/^23456789012345678From Patreon$/);
  expect(fact(dialog, "SteamID")).toHaveTextContent(/^76561198000000001From their application$/);
  expect(fact(dialog, "Payment")).toHaveTextContent(
    `5.00 USD · from Patreon · first payment${new Date(payment.paidAt).toLocaleString()}`,
  );
  const since = new Date(policy.startsAt!).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  expect(fact(dialog, "Founder")).toHaveTextContent(`Since ${since}Added by Gramps`);
  expect(section(dialog, "Needs you")).toHaveTextContent(
    "The application this SteamID came from is no longer approved.",
  );
  // A founder has no founder button, but accounts can still change.
  expect(within(dialog).queryByRole("button", { name: "Make founder" })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Change accounts" })).toBeEnabled();
});

it("says what is missing when a fact is empty, and warns about an unpaid last charge", async () => {
  request.mockResolvedValue(
    data({
      ...supporter,
      discordId: null,
      discordSource: null,
      patreonDiscordId: "34567890123456789",
      steamId: null,
      steamSource: null,
      identityState: "unlinked",
      lastChargeStatus: "Declined",
      latestPayment: null,
      founderEligiblePayment: null,
      founderBlockedReason: "no_payment",
      founderBlockedMessage: "No payment yet.",
      nextSteps: [
        {
          code: "connect_discord_in_patreon",
          area: "discord",
          message: "Gramps links their Discord at the next sync.",
        },
        { code: "founder_no_payment", area: "payment", message: "No payment yet." },
      ],
    }),
  );
  render(page());
  const dialog = await openRecord();
  expect(fact(dialog, "Discord")).toHaveTextContent(/^Not connectedPatreon shows 34567890123456789\.$/);
  expect(fact(dialog, "SteamID")).toHaveTextContent(/^None yet$/);
  expect(fact(dialog, "Payment")).toHaveTextContent(/^No payment yetLast charge: Declined$/);
  expect(within(fact(dialog, "Payment")).getByText("Last charge: Declined")).toHaveClass("warning-text");
  expect(fact(dialog, "Founder")).toHaveTextContent(/^No$/);
  expect(section(dialog, "Waiting")).toHaveTextContent("Gramps links their Discord at the next sync.");
  expect(section(dialog, "Not a founder")).toHaveTextContent("No payment yet.");
});

it("says why Gramps skipped a record that is ready for staff, but not for PayPal", async () => {
  request.mockResolvedValue({
    ...data(),
    supporters: [
      supporter,
      {
        ...supporter,
        id: "paypal",
        displayName: "PayPal donor",
        provider: "paypal",
        patreonMemberId: null,
        automaticBlockedReason: "not_patreon",
        automaticBlockedMessage: "Only Patreon supporters are recorded automatically.",
      },
    ],
  });
  render(page());
  let dialog = await openRecord();
  const skipped = within(fact(dialog, "Founder")).getByText(
    "Gramps skipped this: The Discord account was entered by staff.",
  );
  expect(skipped).toHaveClass("warning-text");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  dialog = await openRecord("PayPal donor");
  expect(fact(dialog, "Founder")).toHaveTextContent(/^No$/);
});

it("offers Add payment only on a Patreon record with a payment step", async () => {
  request.mockResolvedValue({
    ...data(),
    supporters: [
      { ...unpaid, displayName: "Unpaid patron" },
      { ...unpaid, id: "paypal", displayName: "Unpaid donor", provider: "paypal", patreonMemberId: null },
      { ...supporter, id: "ready", displayName: "Ready patron" },
    ],
  });
  render(page());
  let dialog = await openRecord("Unpaid patron");
  expect(within(dialog).getByRole("button", { name: "Add payment" })).toHaveClass("secondary");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  for (const name of ["Unpaid donor", "Ready patron"]) {
    dialog = await openRecord(name);
    expect(within(dialog).queryByRole("button", { name: "Add payment" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Change accounts" })).toHaveClass("secondary");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  }
});

it("lets staff make a PayPal record a founder, confirming with its record ID, even while Patreon is off", async () => {
  const paypal: Supporter = {
    ...supporter,
    provider: "paypal",
    patreonMemberId: null,
    confirmKey: supporter.id,
    displayName: "PayPal donor",
    steamId: null,
    steamSource: null,
    identityState: "partial",
    founderEligiblePayment: { ...payment, source: "paypal", reference: "8AB12345CD678901E" },
    automaticBlockedReason: "not_patreon",
  };
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? {
          ok: true,
          replayed: false,
          supporter: { ...paypal, version: 8, founder: { awardedAt: policy.startsAt!, paymentId: payment.id } },
        }
      : { ...data(paypal), configured: false },
  );
  render(page());
  const dialog = await openRecord("PayPal donor");
  expect(within(dialog).getByText("PayPal", { selector: ".eyebrow" })).toBeInTheDocument();
  // No member ID under the title, and no Patreon payment to add.
  expect(dialog.querySelector(".supporter-member")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Add payment" })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Make founder" }));
  expect(within(dialog).getByText("PayPal donor")).toHaveClass("supporter-member");
  expect(section(dialog, "Payment")).toHaveTextContent("5.00 USD · PayPal · first payment");
  fireEvent.click(within(dialog).getByRole("button", { name: "Make founder" }));
  await screen.findByRole("heading", { name: "Saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ confirm: supporter.id, paymentId: payment.id });
});

function form(values: Record<string, string>) {
  const input = new FormData();
  input.set("reason", "Checked both accounts with the supporter");
  for (const [key, value] of Object.entries(values)) input.set(key, value);
  return input;
}

it("offers an approved application's SteamID without filling it in, only for the Discord account that applied", async () => {
  const offered = {
    ...supporter,
    steamId: null,
    steamSource: null,
    identityState: "partial" as const,
    match: { ...supporter.match, steam: automaticSteam },
    nextSteps: [
      {
        code: "steam_available",
        area: "steam" as const,
        message: "Add the SteamID (76561198000000009) from their application.",
      },
    ],
  };
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? {
          ok: true,
          replayed: false,
          supporter: { ...offered, version: 8, steamId: automaticSteam.steamId, steamSource: "staff" },
        }
      : data(offered),
  );
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  const steam = screen.getByLabelText("SteamID64");
  expect(steam).toHaveValue("");
  // The server's own step explains the SteamID next to the field.
  expect(steam).toHaveAccessibleDescription(/Add the SteamID \(76561198000000009\) from their application\./);
  // Changing the Discord account withdraws the offer.
  const discord = screen.getByLabelText("Discord user ID");
  fireEvent.change(discord, { target: { value: "34567890123456789" } });
  expect(screen.queryByRole("button", { name: `Use SteamID ${automaticSteam.steamId}` })).not.toBeInTheDocument();
  expect(
    screen.getByText(`SteamID ${automaticSteam.steamId} belongs with the current Discord account.`),
  ).toBeInTheDocument();
  // An emptied Discord field keeps the current account on save, so the offer stays.
  fireEvent.change(discord, { target: { value: "  " } });
  expect(screen.queryByText(/belongs with the current Discord account/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: `Use SteamID ${automaticSteam.steamId}` })).toBeInTheDocument();
  expect(reviewInput(offered, "link", "id", form({ discordId: "", steamId: automaticSteam.steamId }))).toEqual(
    expect.not.objectContaining({ discordId: expect.anything() }),
  );
  fireEvent.change(discord, { target: { value: supporter.discordId } });
  fireEvent.click(screen.getByRole("button", { name: `Use SteamID ${automaticSteam.steamId}` }));
  expect(steam).toHaveValue(automaticSteam.steamId);
  expect(steam).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ steamId: automaticSteam.steamId });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).not.toHaveProperty("discordId");
  // A linked SteamID is never replaced by the application's.
  const linked = { ...offered, steamId: "76561198000000001", steamSource: "staff" as const };
  expect(applicationSteamId(linked)).toBeNull();
});

it("offers a SteamID approved without a recorded grant, never one the server flags, and says why in the server's words", async () => {
  const message = "Another Discord account applied with this SteamID (76561198000000009).";
  const record = (reason: SteamMatchBlock): Supporter => ({
    ...supporter,
    steamId: null,
    steamSource: null,
    identityState: "partial",
    match: { ...supporter.match, steam: { ...automaticSteam, reason } },
    nextSteps: [{ code: reason, area: "steam", message }],
  });
  for (const reason of ["steam_shared", "application_in_progress"] as const)
    expect(applicationSteamId(record(reason))).toBeNull();
  // Offered for staff to check and use, never filled in.
  expect(applicationSteamId(record("application_not_confirmed"))).toBe(automaticSteam.steamId);
  request.mockResolvedValue(data(record("steam_shared")));
  render(page());
  const dialog = await openRecord();
  // A flagged SteamID needs staff, with its ID.
  expect(section(dialog, "Needs you")).toHaveTextContent(message);
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  const steam = screen.getByLabelText("SteamID64");
  expect(steam).toHaveValue("");
  expect(steam).toHaveAccessibleDescription(message);
  expect(screen.queryByRole("button", { name: /^Use SteamID/ })).not.toBeInTheDocument();
});

it.each([
  "application_in_progress",
  "application_pending",
  "steam_shared",
  "steam_rejected_before",
  "steam_on_another_record",
  "invalid_steam_id",
] as const)("never offers a SteamID flagged %s, and shows why", async (reason) => {
  const flagged: Supporter = {
    ...supporter,
    steamId: null,
    steamSource: null,
    identityState: "partial",
    match: { ...supporter.match, steam: { ...automaticSteam, reason } },
    nextSteps: [{ code: reason, area: "steam", message: `Flagged: ${reason}.` }],
  };
  expect(applicationSteamId(flagged)).toBeNull();
  request.mockResolvedValue(data(flagged));
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  expect(screen.getByLabelText("SteamID64")).toHaveValue("");
  expect(screen.getByLabelText("SteamID64")).toHaveAccessibleDescription(`Flagged: ${reason}.`);
  expect(screen.queryByRole("button", { name: /^Use SteamID/ })).not.toBeInTheDocument();
});

it("shows nothing from an application on a server the administrator cannot open, and keeps the new-account box", async () => {
  const hiddenStep = "Add the SteamID (on a server you cannot open) from their application.";
  // As the server sends it: only the reason is left of the application.
  const hidden: Supporter = {
    ...supporter,
    steamId: null,
    steamSource: null,
    identityState: "partial",
    match: {
      ...supporter.match,
      steam: { reason: null, steamId: null, applicationId: null, serverId: null },
      sourceApplication: null,
    },
    nextSteps: [{ code: "steam_available", area: "steam", message: hiddenStep }],
  };
  expect(applicationSteamId(hidden)).toBeNull();
  request.mockResolvedValue({
    ...data(),
    supporters: [
      hidden,
      {
        ...hidden,
        id: "copied",
        displayName: "Copied patron",
        steamId: "76561198000000002",
        steamSource: "application",
        nextSteps: [],
      },
    ],
  });
  render(page());
  let dialog = await openRecord();
  expect(section(dialog, "Needs you")).toHaveTextContent(hiddenStep);
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  const steam = screen.getByLabelText("SteamID64");
  expect(steam).toHaveValue("");
  expect(steam).toHaveAccessibleDescription(hiddenStep);
  expect(screen.queryByRole("button", { name: /^Use SteamID/ })).not.toBeInTheDocument();
  expect(dialog).not.toHaveTextContent(/on server |7656119800000000[0-9]/);
  // The server can still refuse a SteamID from that application, so the confirmation stays available.
  expect(screen.getByRole("checkbox", { name: /belongs to the new Discord account too/ })).toBeInTheDocument();
  expect(
    within(dialog).getByText("Needed when the Discord account changes and the SteamID stays."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  // A SteamID copied from that application names no server.
  dialog = await openRecord("Copied patron");
  expect(fact(dialog, "SteamID")).toHaveTextContent(/^76561198000000002From their application$/);
});

it("asks staff to confirm the current Discord account's SteamID before it goes with a new account", () => {
  const offered: Supporter = {
    ...supporter,
    steamId: null,
    steamSource: null,
    match: { ...supporter.match, steam: automaticSteam },
  };
  const newDiscord = "34567890123456789";
  expect(() =>
    reviewInput(offered, "link", "id", form({ discordId: newDiscord, steamId: automaticSteam.steamId })),
  ).toThrow("The current Discord account applied for the whitelist with this SteamID");
  // A flagged SteamID is not offered, but it is still the old account's.
  const flagged: Supporter = {
    ...offered,
    match: { ...offered.match, steam: { ...automaticSteam, reason: "steam_shared" } },
  };
  expect(() =>
    reviewInput(flagged, "link", "id", form({ discordId: newDiscord, steamId: automaticSteam.steamId })),
  ).toThrow("Confirm it belongs to the new Discord account too");
  expect(
    reviewInput(
      offered,
      "link",
      "id",
      form({ discordId: newDiscord, steamId: automaticSteam.steamId, steamConfirmed: "on" }),
    ),
  ).toMatchObject({ discordId: newDiscord, steamId: automaticSteam.steamId, steamConfirmed: true });
  expect(reviewInput(offered, "link", "id", form({ discordId: newDiscord, steamId: "76561198000000002" }))).toEqual(
    expect.not.objectContaining({ steamConfirmed: expect.anything() }),
  );
  // The box sent with a SteamID that stays covers an application the server knows of and this page cannot show.
  expect(reviewInput(supporter, "link", "id", form({ discordId: newDiscord, steamConfirmed: "on" }))).toMatchObject({
    discordId: newDiscord,
    steamConfirmed: true,
  });
  expect(reviewInput(offered, "link", "id", form({ steamId: "76561198000000002", steamConfirmed: "on" }))).toEqual(
    expect.not.objectContaining({ steamConfirmed: expect.anything() }),
  );
});

it("sends the new-account confirmation from the dialog with a SteamID the previous Discord account applied with", async () => {
  const offered: Supporter = {
    ...supporter,
    steamId: null,
    steamSource: null,
    identityState: "partial",
    match: { ...supporter.match, steam: automaticSteam },
  };
  const newDiscord = "34567890123456789";
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? {
          ok: true,
          replayed: false,
          supporter: { ...offered, version: 8, discordId: newDiscord, steamId: automaticSteam.steamId },
        }
      : data(offered),
  );
  render(page());
  const dialog = await openRecord();
  fireEvent.click(within(dialog).getByRole("button", { name: "Change accounts" }));
  fireEvent.change(screen.getByLabelText("Discord user ID"), { target: { value: newDiscord } });
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: automaticSteam.steamId } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Both accounts belong to the supporter." } });
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.click(save);
  expect(screen.getByRole("alert")).toHaveTextContent("Confirm it belongs to the new Discord account too");
  expect(postCalls()).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox", { name: /belongs to the new Discord account too/ }));
  fireEvent.click(save);
  await screen.findByRole("heading", { name: "Saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({
    discordId: newDiscord,
    steamId: automaticSteam.steamId,
    steamConfirmed: true,
  });
});

it("asks staff to restate a SteamID copied from an application before changing the Discord account", () => {
  const copied: Supporter = {
    ...supporter,
    discordSource: "patreon",
    steamSource: "application",
    steamApplicationId: "app-1",
  };
  const newDiscord = "34567890123456789";
  expect(() => reviewInput(copied, "link", "id", form({ discordId: newDiscord, steamId: copied.steamId! }))).toThrow(
    "copied from the old Discord account",
  );
  expect(
    reviewInput(copied, "link", "id", form({ discordId: newDiscord, steamId: copied.steamId!, steamConfirmed: "on" })),
  ).toMatchObject({ discordId: newDiscord, steamConfirmed: true, confirm: copied.confirmKey });
  expect(
    reviewInput(copied, "link", "id", form({ discordId: newDiscord, steamId: "76561198000000002" })),
  ).toMatchObject({ discordId: newDiscord, steamId: "76561198000000002" });
  expect(
    reviewInput(copied, "link", "id", form({ discordId: copied.discordId!, steamId: "76561198000000002" })),
  ).toEqual(expect.not.objectContaining({ discordId: expect.anything() }));
  expect(() => reviewInput(copied, "link", "id", form({}))).toThrow("Enter a Discord user ID or a SteamID64.");
  expect(() => reviewInput(copied, "link", "id", form({ discordId: "display name" }))).toThrow("not a display name");
});

it("puts founder payments to check and Discord conflicts on the row and in the record", async () => {
  request.mockResolvedValue(
    data(
      { ...supporter, nextSteps: [] },
      syncStatus({
        conflicts: 1,
        conflictDetails: [
          { supporterId: supporter.id, patreonMemberId: "patreon-member-1", reason: "discord-differs" },
        ],
        founderReviews: [
          {
            supporterId: supporter.id,
            patreonMemberId: "patreon-member-1",
            paymentId: payment.id,
            paymentSource: "patreon_api",
            reference: payment.reference,
            unverifiedPaymentId: payment.id,
            unverifiedReference: payment.reference,
            reviewReason: "unverified",
          },
        ],
      }),
    ),
  );
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(cell(row, "Next")).toHaveTextContent(
    "Needs youPatreon no longer shows their founder payment as paid. +1 more",
  );
  expect(cell(row, "Discord")).toHaveTextContent(/^Check$/);
  const dialog = await openRecord();
  const needs = section(dialog, "Needs you");
  expect(
    within(needs)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Patreon no longer shows their founder payment as paid.", "Patreon shows a different Discord account."]);
});

/** The Patreon status line. */
function importLine() {
  return screen.getByText("Patreon:").closest("p")!;
}
function getCalls() {
  return request.mock.calls.filter(([, options]) => !options?.method);
}

it("shows Patreon, the schedule and automatic matching as one status line, with Details closed", async () => {
  request.mockResolvedValue(data());
  render(page());
  expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
  const line = importLine();
  expect(line).toHaveClass("status-line", "good");
  // The page is a polite live region, and these relative times change every minute.
  expect(line).toHaveAttribute("aria-live", "off");
  expect(line).not.toHaveAttribute("aria-busy");
  expect(line.querySelector("strong")).toHaveTextContent(/^synced 5 min ago$/);
  expect(line).toHaveTextContent(/^Patreon: synced 5 min agonext in 25 minAutomatic: off$/);
  expect(within(line).getByText(/^next/)).toHaveAttribute("title", "Runs every 30 min");
  expect(within(line).queryByText(/members|new payments|to check|Discord conflict/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Patreon import needs attention|Patreon rejected the access token/),
  ).not.toBeInTheDocument();
  const details = screen.getByText("Details", { selector: "summary" }).closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(screen.getByText("New payments")).not.toBeVisible();
  openDetails();
  expect(details).toHaveAttribute("open");
  expect(screen.getByText("New payments").nextElementSibling).toHaveTextContent("3");
  expect(screen.getByText("Members listed").nextElementSibling).toHaveTextContent("12");
  expect(screen.getByText("Discord accounts from Patreon").nextElementSibling).toHaveTextContent("1");
  expect(screen.getByText("Discord conflicts", { selector: "dt" }).nextElementSibling).toHaveTextContent("0");
  expect(screen.getByText("Founder payments to check", { selector: "dt" }).nextElementSibling).toHaveTextContent("0");
  expect(screen.queryByRole("heading", { name: /Discord conflicts|Founder payments/ })).not.toBeInTheDocument();
  // Every payment is in US dollars, so the other-currency counts stay out of the way.
  expect(screen.queryByText(/Other-currency payments/)).not.toBeInTheDocument();
  expect(screen.queryByText(/not sharing Discord accounts/)).not.toBeInTheDocument();
  const setting = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;
  expect(setting("Automatic founders")).toHaveTextContent(/^off$/);
  expect(setting("SteamID fill")).toHaveTextContent(/^off$/);
  expect(setting("Refund wait")).toHaveTextContent(/^72 hours$/);
  expect(setting("Last run")).toHaveTextContent(/^Not yet$/);
  // The server knows the signing secret is set, not that Patreon delivers to it.
  expect(setting("Webhook")).toHaveTextContent(/^set up$/);
  const exact = (value: string) =>
    new Date(value).toLocaleString(undefined, { timeZone: "America/New_York", timeZoneName: "short" });
  expect(setting("Founder window")).toHaveTextContent(`${exact(policy.startsAt!)} until ${exact(policy.endsAt!)}`);
  expect(screen.getByRole("button", { name: "Add Patreon member" })).toBeEnabled();
});

it("words automatic matching as on, partly on or off, with its settings in Details", async () => {
  request
    .mockResolvedValueOnce({
      ...data(),
      webhookConfigured: false,
      automation: {
        steamFill: true,
        founderAuto: true,
        holdHours: 48,
        configured: true,
        lastRunAt: "2026-10-03T12:00:00Z",
      },
    })
    .mockResolvedValueOnce({ ...data(), automation: { steamFill: false, founderAuto: true } });
  const view = render(page());
  await screen.findByRole("button", { name: "Sync now" });
  expect(within(importLine()).getByText("Automatic: on")).toBeInTheDocument();
  openDetails();
  const setting = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;
  expect(setting("Automatic founders")).toHaveTextContent(/^on$/);
  expect(setting("SteamID fill")).toHaveTextContent(/^on$/);
  expect(setting("Refund wait")).toHaveTextContent(/^48 hours$/);
  expect(setting("Last run")).toHaveTextContent(new Date("2026-10-03T12:00:00Z").toLocaleString());
  expect(setting("Webhook")).toHaveTextContent(/^not set up$/);
  view.rerender(page({ ...context, refreshVersion: 1 }));
  expect(await within(importLine()).findByText("Automatic: partly on")).toBeInTheDocument();
});

it("shows how many payments in another currency the last import counted by tier price", async () => {
  request.mockResolvedValue(
    data(supporter, syncStatus({ tierConfirmed: 2, tierConfirmedNew: 2, tierUnconfirmed: 1, tierPrices: "read" })),
  );
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  // Counts only: nothing here needs attention on the status line.
  expect(importLine()).toHaveClass("status-line", "good");
  openDetails();
  expect(screen.getByText("Other-currency payments counted").nextElementSibling).toHaveTextContent("2");
  expect(screen.getByText("Other-currency payments not confirmed").nextElementSibling).toHaveTextContent("1");
});

it("shows the other-currency counts when none could be counted", async () => {
  request.mockResolvedValue(data(supporter, syncStatus({ tierUnconfirmed: 2, tierPrices: "unavailable" })));
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  openDetails();
  expect(screen.getByText("Other-currency payments counted").nextElementSibling).toHaveTextContent("0");
  expect(screen.getByText("Other-currency payments not confirmed").nextElementSibling).toHaveTextContent("2");
});

it("says in two short sentences when Patreon shares no Discord account for paying members", async () => {
  request.mockResolvedValue(data(supporter, syncStatus({ members: 16, paidMembers: 14, discordReported: 0 })));
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  const notice = screen.getByText("Patreon is not sharing Discord accounts.").closest("p")!;
  expect(notice).toHaveClass("notice", "info");
  expect(notice).toHaveTextContent(
    /^Patreon is not sharing Discord accounts\. Connect Discord on Patreon and add it as a benefit on each paid tier\.$/,
  );
  // A notice comes before the status line.
  expect(notice.compareDocumentPosition(importLine()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // It explains a setup step; the import itself worked.
  expect(importLine()).toHaveClass("status-line", "good");
  expect(screen.queryByText(/Patreon import needs attention/)).not.toBeInTheDocument();
  openDetails();
  expect(screen.getByText("Discord accounts from Patreon").nextElementSibling).toHaveTextContent("0");
});

it.each<[string, Partial<PatreonSyncStatus>]>([
  ["Patreon shared one", { paidMembers: 14, discordReported: 1 }],
  ["no member has paid", { paidMembers: 0, discordReported: 0 }],
  ["nothing has synced yet", { paidMembers: 0, discordReported: 0, lastSuccessAt: null, lastAttemptAt: null }],
  [
    "the import is not configured",
    { configured: false, paidMembers: 14, discordReported: 0, lastSuccessAt: null, lastAttemptAt: null },
  ],
])("says nothing about sharing Discord accounts when %s", async (_name, overrides) => {
  request.mockResolvedValue(data(supporter, syncStatus(overrides)));
  render(page());
  await openButton();
  expect(screen.queryByText(/not sharing Discord accounts/)).not.toBeInTheDocument();
});

it("keeps the Discord sharing notice out of a status that could not be read", () => {
  render(
    <AdminContext.Provider value={context}>
      <PatreonImport
        sync={syncStatus({ paidMembers: 14, discordReported: 0 })}
        unavailable
        disabled={false}
        onSynced={vi.fn()}
      />
    </AdminContext.Provider>,
  );
  expect(screen.queryByText(/not sharing Discord accounts/)).not.toBeInTheDocument();
});

it("puts founder payments to check and Discord conflicts on the status line, with their lists in Details", async () => {
  request.mockResolvedValue(
    data(
      supporter,
      syncStatus({
        conflicts: 2,
        conflictDetails: [
          { supporterId: supporter.id, patreonMemberId: "conflict-member", reason: "discord-in-use" },
          { supporterId: "other-supporter", patreonMemberId: "other-member", reason: "discord-differs" },
        ],
        founderReviews: [
          {
            supporterId: supporter.id,
            patreonMemberId: "founder-member",
            paymentId: payment.id,
            paymentSource: "manual_receipt",
            reference: payment.reference,
            unverifiedPaymentId: "01234567-89ab-4cde-8fab-0123456789ae",
            unverifiedReference: "refunded-charge",
            reviewReason: "unverified",
          },
        ],
      }),
    ),
  );
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  const line = importLine();
  expect(line).toHaveClass("attention");
  expect(line).toHaveTextContent(
    /^Patreon: synced 5 min agonext in 25 minAutomatic: off1 founder payment to check2 Discord conflicts$/,
  );
  expect(screen.queryByText(/Patreon import needs attention/)).not.toBeInTheDocument();
  openDetails();
  expect(screen.getByRole("heading", { level: 3, name: "Discord conflicts" })).toBeVisible();
  expect(within(screen.getByRole("list", { name: "Discord conflicts" })).getByText("conflict-member")).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "Discord conflicts" })).getByText(
      "Their Discord account is already on another supporter.",
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "Discord conflicts" })).getByText(
      "Patreon shows a different Discord account.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("heading", { level: 3, name: "Founder payments to check" })).toBeVisible();
  const reviews = screen.getByRole("list", { name: "Founder payments to check" });
  expect(within(reviews).getByText("founder-member")).toBeVisible();
  expect(within(reviews).getByText("Patreon no longer shows payment refunded-charge as paid")).toBeVisible();
});

it("says when a founder's own payment is no longer their first payment", async () => {
  request.mockResolvedValue(
    data(
      supporter,
      syncStatus({
        founderReviews: [
          {
            supporterId: supporter.id,
            patreonMemberId: "founder-member",
            paymentId: payment.id,
            paymentSource: "patreon_api",
            reference: "first-charge",
            unverifiedPaymentId: payment.id,
            unverifiedReference: "first-charge",
            reviewReason: "not_first_payment",
          },
        ],
      }),
    ),
  );
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  expect(within(importLine()).getByText("1 founder payment to check")).toBeInTheDocument();
  expect(cell(rowOf(supporter.displayName!), "Next")).toHaveTextContent(
    "Their founder payment is no longer their first payment.",
  );
  openDetails();
  expect(screen.getByText("Payment first-charge is no longer their first payment")).toBeVisible();
  expect(screen.queryByText(/as paid/)).not.toBeInTheDocument();
});

it("offers Sync now only to administrators", () => {
  const status = (role: AdminContextValue["me"]["role"]) => (
    <AdminContext.Provider value={{ ...context, me: { ...context.me, role } }}>
      <PatreonImport sync={syncStatus()} unavailable={false} disabled={false} onSynced={vi.fn()} />
    </AdminContext.Provider>
  );
  const view = render(status("moderator"));
  expect(importLine().querySelector("strong")).toHaveTextContent("synced 5 min ago");
  expect(screen.queryByRole("button", { name: /Sync now|Syncing/ })).not.toBeInTheDocument();
  view.rerender(status("viewer"));
  expect(importLine()).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Sync now|Syncing/ })).not.toBeInTheDocument();
  view.rerender(status("admin"));
  expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
});

it("says the Patreon import is not configured, offers no sync and still has Details", async () => {
  request.mockResolvedValue(
    data(
      supporter,
      syncStatus({
        configured: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextAttemptAt: null,
        members: 0,
        payments: 0,
      }),
    ),
  );
  render(page());
  await openButton();
  const line = importLine();
  expect(line).toHaveClass("quiet");
  expect(line).toHaveTextContent(/^Patreon: Not configuredAutomatic: off$/);
  expect(line).not.toHaveAttribute("title");
  // Setup guidance is visible text, not a tooltip.
  expect(
    screen.getByText(
      "Set PATREON_ENABLED, PATREON_CAMPAIGN_ID and PATREON_CREATOR_ACCESS_TOKEN in Railway to import members.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /Sync now|Syncing/ })).not.toBeInTheDocument();
  openDetails();
  expect(screen.queryByText("Members listed")).not.toBeInTheDocument();
  expect(screen.getByText("Automatic founders", { selector: "dt" })).toBeVisible();
  expect(screen.queryByText(/Patreon import needs attention/)).not.toBeInTheDocument();
});

it("explains a token problem found before any request while the import is not configured", async () => {
  const malformed =
    "PATREON_CREATOR_ACCESS_TOKEN does not look like a Patreon access token. Copy the Creator's Access Token again.";
  request.mockResolvedValue(
    data(supporter, syncStatus({ configured: false, lastSuccessAt: null, lastAttemptAt: null, lastError: malformed })),
  );
  render(page());
  await openButton();
  expect(importLine()).toHaveClass("attention");
  expect(importLine()).toHaveTextContent(/^Patreon: Not configured/);
  expect(screen.getByText("Patreon import needs attention.").parentElement).toHaveTextContent(malformed);
  expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
});

it("tells staff how to fix a rejected token in place of the recorded error", async () => {
  const recorded =
    "Patreon rejected the Creator's Access Token. Renew it on the Patreon client page (patreon.com/portal/registration/register-clients), update PATREON_CREATOR_ACCESS_TOKEN in Railway, and confirm PATREON_CAMPAIGN_ID belongs to that creator.";
  request.mockResolvedValue(
    data(
      supporter,
      syncStatus({
        tokenRejected: true,
        lastError: recorded,
        lastAttemptAt: minutesFromNow(-2),
        nextAttemptAt: minutesFromNow(360),
      }),
    ),
  );
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  // A 403 can also mean the campaign belongs to another creator, so both checks are named.
  expect(screen.getByText("Patreon rejected the access token.").parentElement).toHaveTextContent(
    "Patreon rejected the access token. Renew the Creator's Access Token on the Patreon client page, update PATREON_CREATOR_ACCESS_TOKEN in Railway, and check that PATREON_CAMPAIGN_ID belongs to that creator.",
  );
  // The fixed text replaces the recorded error rather than repeating it.
  expect(document.body).not.toHaveTextContent("register-clients");
  expect(screen.queryByText(/Patreon import needs attention/)).not.toBeInTheDocument();
  const line = importLine();
  expect(line).toHaveClass("attention");
  expect(line.querySelector("strong")).toHaveTextContent("synced 5 min ago");
  expect(within(line).getByText(/^last tried/)).toHaveTextContent("last tried 2 min ago");
  expect(within(line).getByText(/^next/)).toHaveTextContent("next in 6 h");
  // The longer wait after a rejected token is not the usual interval.
  expect(within(line).getByText(/^next/)).not.toHaveAttribute("title");
  // Staff can retry once Railway has the new token.
  expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
});

it("words the usual interval and leaves it out when Patreon pushed the next run later", async () => {
  const synced = minutesFromNow(-10);
  request
    .mockResolvedValueOnce(
      data(
        supporter,
        syncStatus({
          lastAttemptAt: minutesFromNow(-10.1),
          lastSuccessAt: synced,
          intervalMinutes: 1440,
          nextAttemptAt: new Date(Date.parse(synced) + 1440 * minute).toISOString(),
        }),
      ),
    )
    .mockResolvedValueOnce(
      data(
        supporter,
        syncStatus({
          lastError: "Patreon asked the sync to slow down. The next attempt waits 7200 seconds.",
          lastAttemptAt: minutesFromNow(-1),
          nextAttemptAt: minutesFromNow(119),
        }),
      ),
    );
  const view = render(page());
  await screen.findByRole("button", { name: "Sync now" });
  expect(within(importLine()).getByText(/^next/)).toHaveAttribute("title", "Runs every 24 h");
  view.rerender(page({ ...context, refreshVersion: 1 }));
  await waitFor(() => expect(within(importLine()).getByText(/^last tried/)).toBeInTheDocument());
  expect(within(importLine()).getByText(/^next/)).toHaveTextContent("next in 1 h 59 min");
  expect(within(importLine()).getByText(/^next/)).not.toHaveAttribute("title");
});

it("shows other import errors as they were recorded", async () => {
  const unavailable = "Patreon could not be reached. Existing supporter records were kept; the next sync will retry.";
  request.mockResolvedValue(data(supporter, syncStatus({ lastError: unavailable, lastAttemptAt: minutesFromNow(-1) })));
  render(page());
  await screen.findByRole("button", { name: "Sync now" });
  expect(screen.getByText("Patreon import needs attention.").parentElement).toHaveTextContent(unavailable);
  expect(screen.queryByText("Patreon rejected the access token.")).not.toBeInTheDocument();
  expect(importLine()).toHaveClass("attention");
  expect(within(importLine()).getByText(/^last tried/)).toHaveTextContent("last tried 1 min ago");
});

it("disables Sync now while an import is running", async () => {
  request.mockResolvedValue(data(supporter, syncStatus({ running: true, lastAttemptAt: minutesFromNow(0) })));
  render(page());
  expect(await screen.findByRole("button", { name: "Syncing…" })).toBeDisabled();
  const line = importLine();
  expect(line.querySelector("strong")).toHaveTextContent("Syncing now…");
  expect(within(line).getByText(/^synced/)).toHaveTextContent("synced 5 min ago");
  expect(within(line).queryByText(/^next/)).not.toBeInTheDocument();
  expect(within(line).queryByText(/last tried/)).not.toBeInTheDocument();
});

it("keeps Sync now disabled while the dashboard is busy or the page is refreshing", async () => {
  request.mockResolvedValueOnce(data());
  const view = render(page({ ...context, busy: true }));
  expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
  const refreshed = deferred<SupportersResponse>();
  request.mockReturnValueOnce(refreshed.promise);
  view.rerender(page({ ...context, refreshVersion: 1 }));
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await act(async () => refreshed.resolve(data()));
  expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  expect(postCalls()).toHaveLength(0);
});

it("starts one sync with the CSRF-protected client, then refreshes the page data", async () => {
  const response = deferred<PatreonSyncResponse>();
  const synced = data(supporter, syncStatus({ lastAttemptAt: minutesFromNow(-0.1), lastSuccessAt: minutesFromNow(0) }));
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? response.promise : getCalls().length > 1 ? synced : data(),
  );
  const view = render(page());
  const button = await screen.findByRole("button", { name: "Sync now" });
  // Both presses land before React re-renders, so the button is still enabled for the second one.
  act(() => {
    button.click();
    button.click();
  });
  // A body makes the shared client send the session's CSRF header.
  expect(postCalls()).toEqual([["supporters/sync", { method: "POST", body: "{}" }]]);
  expect(screen.getByRole("button", { name: "Syncing…" })).toBeDisabled();
  expect(importLine().querySelector("strong")).toHaveTextContent("Syncing now…");
  expect(getCalls()).toHaveLength(1);
  await act(async () => response.resolve({ ok: true, joined: false, sync: synced.sync }));
  expect(await screen.findByText("Patreon import finished.")).toHaveAttribute("role", "status");
  await waitFor(() => expect(getCalls()).toHaveLength(2));
  await waitFor(() => expect(importLine().querySelector("strong")).toHaveTextContent("synced just now"));
  expect(screen.getByText("Patreon import finished.")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled());
  // A second press within the cooldown reuses the import that just finished.
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, joined: false, recent: true, sync: synced.sync } : synced,
  );
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  expect(
    await screen.findByText("An import finished under 30 seconds ago, so it was not repeated."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Patreon import finished.")).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(2);
  // A later scheduled import's status replaces the result.
  await waitFor(() => expect(getCalls()).toHaveLength(3));
  request.mockResolvedValue(
    data(supporter, syncStatus({ lastAttemptAt: minutesFromNow(0), lastSuccessAt: minutesFromNow(0) })),
  );
  view.rerender(page({ ...context, refreshVersion: 1 }));
  await waitFor(() => expect(screen.queryByText(/An import finished under 30 seconds ago/)).not.toBeInTheDocument());
  expect(postCalls()).toHaveLength(2);
});

it("leaves a failed import to the refreshed status instead of reporting success", async () => {
  const rejected = syncStatus({ tokenRejected: true, lastError: "Patreon rejected the Creator's Access Token." });
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? { ok: true, joined: true, sync: rejected }
      : getCalls().length > 1
        ? data(supporter, rejected)
        : data(),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(await screen.findByText("Patreon rejected the access token.")).toBeInTheDocument();
  expect(screen.queryByText(/Patreon import finished|Joined the import/)).not.toBeInTheDocument();
});

it("does not report a reused import that failed as a success", async () => {
  const failed = syncStatus({
    lastAttemptAt: minutesFromNow(-0.2),
    lastError: "Patreon could not be reached. Existing supporter records were kept; the next sync will retry.",
  });
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, joined: false, recent: true, sync: failed } : data(supporter, failed),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(await screen.findByText("The last import failed under 30 seconds ago. Try again in a moment.")).toHaveClass(
    "notice",
    "warning",
  );
  expect(screen.queryByText(/so it was not repeated/)).not.toBeInTheDocument();
  expect(document.querySelector(".notice.success")).toBeNull();
  expect(screen.getByText("Patreon import needs attention.")).toBeInTheDocument();
});

it("says when Patreon's rate limit kept Sync now from running an import", async () => {
  const held = syncStatus({
    lastAttemptAt: minutesFromNow(-2),
    lastError: "Patreon asked the sync to slow down. The next attempt waits 600 seconds.",
    nextAttemptAt: minutesFromNow(8),
  });
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, joined: false, sync: held } : data(supporter, held),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(
    await screen.findByText("No import ran because Patreon asked the sync to slow down. It will retry automatically."),
  ).toHaveClass("notice", "warning");
  expect(screen.queryByText(/Patreon import finished/)).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("keeps an unconfirmed sync request uncertain and still refreshes", async () => {
  const current = data();
  request.mockImplementation(async (_path, options) => {
    if (options?.method === "POST")
      throw Object.assign(new Error("The request timed out before confirmation."), { status: 0 });
    return current;
  });
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(await screen.findByText(/The import may still be running/)).toHaveClass("notice", "warning");
  expect(screen.queryByText(/Check Action history/)).not.toBeInTheDocument();
  await waitFor(() => expect(getCalls()).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled());
  request.mockImplementation(async (_path, options) => {
    if (options?.method === "POST")
      throw Object.assign(new Error("Patreon sync is not configured. Set PATREON_ENABLED."), { status: 503 });
    return current;
  });
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  expect(await screen.findByText("Patreon sync is not configured. Set PATREON_ENABLED.")).toBeInTheDocument();
});

it("does not show the last import status as current after a failed refresh", async () => {
  request
    .mockResolvedValueOnce(data(supporter, syncStatus({ tokenRejected: true, lastError: "rejected" })))
    .mockRejectedValueOnce(new Error("Unavailable"));
  const view = render(page());
  await screen.findByText("Patreon rejected the access token.");
  view.rerender(page({ ...context, refreshVersion: 1 }));
  expect(await screen.findByText("Could not refresh, so reload before saving.")).toHaveAttribute("role", "alert");
  const line = importLine();
  expect(line).toHaveTextContent(/^Patreon: Status unavailable/);
  expect(line).toHaveClass("attention");
  expect(screen.queryByText("Patreon rejected the access token.")).not.toBeInTheDocument();
  openDetails();
  expect(screen.queryByText("Members listed")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add Patreon member" })).toBeDisabled();
  expect(screen.getByRole("button", { name: `Open ${supporter.displayName}` })).toBeEnabled();
});

it("words import times relative to now", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(ago("2026-10-02T11:59:45Z", now)).toBe("just now");
  expect(ago("2026-10-02T11:55:00Z", now)).toBe("5 min ago");
  expect(ago("2026-10-02T09:55:00Z", now)).toBe("2 h 5 min ago");
  expect(ago("2026-09-29T12:00:00Z", now)).toBe("3 days ago");
  expect(ahead("2026-10-02T12:25:00Z", now)).toBe("in 25 min");
  expect(ahead("2026-10-02T12:00:20Z", now)).toBe("in under a minute");
  expect(ahead("2026-10-02T18:00:00Z", now)).toBe("in 6 h");
  expect(ahead("2026-10-02T11:59:00Z", now)).toBe("due now");
});

it("lists a record's steps under Needs you, Waiting and Not a founder, each only with something in it", async () => {
  const note = { code: "founder_outside_window", area: "info" as const, message: "Paid outside the founder window." };
  const discordStep = {
    code: "connect_discord_in_patreon",
    area: "discord" as const,
    message: "Waiting for them to connect Discord on Patreon.",
  };
  const later = {
    code: "application_pending",
    area: "steam" as const,
    message: "Their whitelist application is waiting for review.",
  };
  request.mockResolvedValue(
    data({
      ...supporter,
      founderEligiblePayment: null,
      founderBlockedReason: "outside_window",
      founderBlockedMessage: note.message,
      nextSteps: [later, discordStep, note],
    }),
  );
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(cell(row, "Next")).toHaveTextContent(/^WaitingWaiting for them to connect Discord on Patreon\.$/);
  const dialog = await openRecord();
  expect(
    within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(["Waiting", "Not a founder"]);
  // Waiting lists what Gramps or the supporter does, then what matters only later.
  expect(
    within(section(dialog, "Waiting"))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([discordStep.message, later.message]);
  expect(section(dialog, "Not a founder")).toHaveTextContent(/^Not a founderPaid outside the founder window\.$/);
});

it("shows a matching run that could not finish as a notice, with the last run in Details", async () => {
  request.mockResolvedValue({
    ...data(),
    automation: {
      steamFill: true,
      founderAuto: false,
      holdHours: 72,
      configured: false,
      lastRunAt: "2026-10-03T12:00:00Z",
      lastError: "Automatic supporter matching could not finish.",
    },
  });
  render(page());
  const failed = (await screen.findByText("Automatic matching needs attention.")).parentElement!;
  expect(failed).toHaveClass("notice", "warning");
  expect(failed).toHaveTextContent("Automatic supporter matching could not finish.");
  expect(failed).toHaveTextContent(`Last attempt ${new Date("2026-10-03T12:00:00Z").toLocaleString()}.`);
  expect(failed.compareDocumentPosition(importLine()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(importLine()).getByText("Automatic: partly on")).toBeInTheDocument();
  openDetails();
  expect(screen.getByText("Last run", { selector: "dt" }).nextElementSibling).toHaveTextContent(
    new Date("2026-10-03T12:00:00Z").toLocaleString(),
  );
});

it("shows no matching problem while the last run finished", async () => {
  request.mockResolvedValue({
    ...data(),
    automation: { steamFill: true, founderAuto: true, holdHours: 24, configured: true, lastError: null },
  });
  render(page());
  await screen.findByText(supporter.displayName!);
  expect(screen.queryByText("Automatic matching needs attention.")).not.toBeInTheDocument();
  expect(within(importLine()).getByText("Automatic: on")).toBeInTheDocument();
});
