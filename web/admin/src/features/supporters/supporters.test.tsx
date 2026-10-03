import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { SupportersPage } from "./index";
import { PatreonImport, ago, ahead } from "./patreon-sync";
import { applicationSteamId, discordDescription, founderReady, founderWindowLabel, reviewInput } from "./policy";
import type {
  FounderPolicy,
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
  nextSteps: [
    {
      code: "founder_ready_staff",
      area: "founder",
      message: "Ready for staff to record. Not automatic: the Discord account was entered by staff.",
    },
  ],
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
  await screen.findByRole("button", { name: "Review supporter" });
  const search = screen.getByRole("searchbox", { name: "Search all supporter records" });
  fireEvent.change(search, { target: { value: "old%_member" } });
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Earlier donor from the full ledger")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Search all records" }));
  await screen.findByText("Earlier donor from the full ledger");
  expect(request).toHaveBeenLastCalledWith("supporters?search=old%25_member", expect.any(Object));
  expect(screen.getByText(/Up to 100 matching records/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await screen.findByText(supporter.displayName!);
  expect(request).toHaveBeenLastCalledWith("supporters", expect.any(Object));
});

it("announces a failed search to screen readers without announcing the search while it loads", async () => {
  request.mockImplementation(async (path) => {
    if (String(path).includes("?search=")) throw new Error("The dashboard could not be reached.");
    return data();
  });
  render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search all supporter records" }), {
    target: { value: "Earlier donor" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search all records" }));
  expect(screen.getByText("Loading supporters…").closest("[role=alert], [aria-live]")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("Supporter records could not be loaded");
});

it("keeps a failed search changeable and clearable", async () => {
  request.mockImplementation(async (path) => {
    if (String(path).includes("?search=")) throw new Error("The dashboard could not be reached.");
    return data();
  });
  render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search all supporter records" }), {
    target: { value: "Wait..." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search all records" }));
  await screen.findByText("Supporter records could not be loaded");
  expect(request).toHaveBeenLastCalledWith("supporters?search=Wait...", expect.any(Object));
  expect(screen.getByRole("searchbox", { name: "Search all supporter records" })).toHaveValue("Wait...");
  fireEvent.click(screen.getByRole("button", { name: "Search all records" }));
  await screen.findByText("Supporter records could not be loaded");
  expect(request.mock.calls.filter(([path]) => path === "supporters?search=Wait...")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await screen.findByRole("button", { name: "Review supporter" });
  expect(request).toHaveBeenLastCalledWith("supporters", expect.any(Object));
  expect(screen.getByRole("searchbox", { name: "Search all supporter records" })).toHaveValue("");
});

it("requires a checked campaign membership before creating an unverified donor record without webhook setup", async () => {
  const response = deferred<SupporterReviewResponse>();
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? response.promise : { ...data(), supporters: [], webhookConfigured: false },
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Record existing Patreon member" }));
  const checkbox = screen.getByRole("checkbox", { name: /I verified this membership belongs/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("Patreon membership ID"), { target: { value: "historic-member-123" } });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Checked historical member on the UNC Patreon page" },
  });
  const form = screen.getByRole("button", { name: "Save membership record" }).closest("form")!;
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
  await screen.findByRole("heading", { name: "Membership record saved" });
  expect(screen.getByText("No payment, founder promise, game access or Discord role was granted.")).toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("does not offer manual entry when private records are unavailable or to a moderator", async () => {
  request.mockResolvedValue({ ...data(), configured: false });
  const view = render(page());
  expect(await screen.findByRole("button", { name: "Record existing Patreon member" })).toBeDisabled();
  view.rerender(page({ ...context, me: { ...context.me, role: "moderator" } }));
  expect(screen.queryByRole("button", { name: "Record existing Patreon member" })).not.toBeInTheDocument();
});

it("keeps an uncertain manual entry out of the success state and never resubmits it", async () => {
  request.mockImplementation(async (_path, options) => (options?.method === "POST" ? { ok: true } : data()));
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Record existing Patreon member" }));
  fireEvent.change(screen.getByLabelText("Patreon membership ID"), { target: { value: "historic-member-123" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Checked the creator record" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I verified this membership belongs/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save membership record" }));
  await screen.findByRole("heading", { name: "Save result not confirmed" });
  expect(screen.queryByRole("button", { name: "Save membership record" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("waits for a refreshed supporter revision before opening a new review", async () => {
  const refreshed = deferred<SupportersResponse>();
  request
    .mockResolvedValueOnce(data())
    .mockReturnValueOnce(refreshed.promise)
    .mockImplementation(async (_path, options) =>
      options?.method === "POST"
        ? { ok: true, replayed: false, supporter: { ...supporter, version: 10, reviewState: "verified" } }
        : data({ ...supporter, version: 10 }),
    );
  const view = render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  view.rerender(page({ ...context, refreshVersion: 1 }));
  const open = screen.getByRole("button", { name: "Review supporter" });
  expect(open).toBeDisabled();
  fireEvent.click(open);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => refreshed.resolve(data({ ...supporter, version: 9 })));
  fireEvent.click(screen.getByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark observation reviewed" }));
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Checked the latest membership observation." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ version: 9 });
});

it("requires admin access and renders provider data as text, with no access-grant claims", async () => {
  const view = render(page({ ...context, me: { ...context.me, role: "viewer" } }));
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(data());
  view.rerender(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  expect(document.querySelector("img")).toBeNull();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(supporter.displayName!)).toBeInTheDocument();
  expect(within(dialog).getByText("Entered by staff; not verified through Discord sign-in.")).toBeInTheDocument();
  expect(
    within(dialog).getByText("Entered by staff; Steam ownership is not verified by this page."),
  ).toBeInTheDocument();
  // The Founder and Supporter Discord roles follow these records while Discord roles are switched on.
  expect(
    screen.getByText(
      "Records only. Grants no game access; with Discord roles switched on, the Founder and Supporter roles follow these records. A membership is not a verified payment.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Grants no game or Discord access/)).not.toBeInTheDocument();
});

it("states the record limits once and shows the founder window as one label", async () => {
  request.mockResolvedValue(data());
  render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  expect(screen.getAllByText(/Grants no game access/)).toHaveLength(1);
  expect(screen.queryByText(/THANK THE CREW/)).not.toBeInTheDocument();
  expect(screen.queryByText("Private records")).not.toBeInTheDocument();
  expect(screen.getByText(founderWindowLabel(policy))).toHaveAttribute(
    "title",
    expect.stringContaining("end not included"),
  );
  // The server knows the signing secret is set, not that Patreon delivers to it.
  expect(screen.getByText("Patreon webhook set up")).toBeInTheDocument();
  expect(screen.queryByText(/webhook connected/)).not.toBeInTheDocument();
});

it("filters loaded supporters with counted chips instead of a select", async () => {
  const founder = {
    ...supporter,
    id: "01234567-89ab-4cde-8fab-0123456789ff",
    patreonMemberId: "founder-member",
    displayName: "Founder supporter",
    reviewState: "verified" as const,
    founder: { awardedAt: policy.startsAt!, paymentId: payment.id },
  };
  request.mockResolvedValue({ ...data(), supporters: [supporter, founder] });
  render(page());
  await screen.findByText("Founder supporter");
  expect(screen.queryByRole("combobox", { name: "Filter supporter records" })).not.toBeInTheDocument();
  const chips = screen.getByRole("group", { name: "Filter supporter records" });
  expect(within(chips).getByRole("button", { name: "All 2" })).toHaveAttribute("aria-pressed", "true");
  expect(within(chips).getByRole("button", { name: "Awaiting review 1" })).toBeInTheDocument();
  expect(within(chips).getByRole("button", { name: "Accounts to match 0" })).toBeInTheDocument();
  fireEvent.click(within(chips).getByRole("button", { name: "Founder promises 1" }));
  expect(within(chips).getByRole("button", { name: "Founder promises 1" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Founder supporter")).toBeInTheDocument();
  expect(screen.queryByText(supporter.displayName!)).not.toBeInTheDocument();
  expect(screen.getByText("1 shown of 2 loaded")).toBeInTheDocument();
  fireEvent.click(within(chips).getByRole("button", { name: "Accounts to match 0" }));
  expect(screen.getByText("No matching supporters")).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
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

it("records a founder promise against a verified first payment from the Patreon import", async () => {
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
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Record founder promise" }));
  const notice = screen.getByText("Payment supporting this founder promise").parentElement!;
  expect(notice).toHaveTextContent("5.00 USD · checked by the Patreon import · first payment history checked");
  expect(notice).not.toHaveTextContent("provider status only");
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Imported first payment and matched accounts." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(postCalls()[0][0]).toBe(`supporters/${supporter.id}/founder`);
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ version: 7, paymentId: imported.id });
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

it("keeps the founder action off while the server names a blocking rule, and says which", async () => {
  const message = "Only a checked Patreon receipt, a Patreon API payment or a PayPal payment can qualify.";
  request.mockResolvedValue(
    data({
      ...supporter,
      founderEligiblePayment: null,
      founderBlockedReason: "source_not_qualifying",
      founderBlockedMessage: message,
    }),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  const founder = screen.getByRole("button", { name: "Record founder promise" });
  expect(founder).toBeDisabled();
  expect(founder).toHaveAttribute("title", message);
  expect(postCalls()).toHaveLength(0);
});

it("uses the qualifying payment rather than the latest renewal, preserving UUID, exact member and revision", async () => {
  const response = deferred<SupporterReviewResponse>();
  request.mockImplementation(async (_path, options) => (options?.method === "POST" ? response.promise : data()));
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Record founder promise" }));
  expect(screen.getByText("Payment supporting this founder promise").parentElement).toHaveTextContent(
    `Reference: ${payment.reference}`,
  );
  expect(screen.getByText(`Reference: ${supporter.latestPayment!.reference}`)).toBeInTheDocument();
  expect(screen.getByText("Payment supporting this founder promise")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Checked first payment and matched accounts." },
  });
  const form = screen.getByRole("button", { name: "Save reviewed record" }).closest("form")!;
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
  await act(async () =>
    response.resolve({
      ok: true,
      replayed: false,
      supporter: { ...supporter, version: 8, founder: { awardedAt: policy.startsAt!, paymentId: payment.id } },
    }),
  );
  expect(screen.getByRole("heading", { name: "Supporter record saved" })).toBeInTheDocument();
  // A founder award queues a Discord role check while Discord roles are switched on, so no role claim is made.
  expect(
    screen.getByText(
      "Your review has been recorded. No game access was changed. With Discord roles switched on, Gramps checks the linked Discord account’s roles next.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/No game access or Discord role was changed/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save reviewed record" })).not.toBeInTheDocument();
});

it("says a reviewed observation changes no Discord role, and a founder, link or payment save leads to a role check", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 8 } } : data(),
  );
  render(page());
  const open = async () => {
    const button = await screen.findByRole("button", { name: "Review supporter" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
  };
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Mark observation reviewed" }));
  expect(screen.getByText("This records staff evidence only. No game or Discord access changes.")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Membership observation reviewed." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(
    screen.getByText("Your review has been recorded. No game access or Discord role was changed."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  for (const action of ["Review account match", "Record checked payment", "Record founder promise"]) {
    await open();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(
      screen.getByText(
        "This records staff evidence only and changes no game access. With Discord roles switched on, Gramps then checks the linked Discord account’s roles.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No game or Discord access changes/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }
});

it("payment entry defaults first-payment attestation off and requires a completed-payment check", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 8 } } : data(),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Record checked payment" }));
  const first = screen.getByRole("checkbox", { name: /first successful payment/ });
  expect(first).not.toBeChecked();
  fireEvent.change(screen.getByLabelText(/Completed payment date and time/), { target: { value: "2020-10-01T12:30" } });
  fireEvent.change(screen.getByLabelText("Gross completed amount · USD"), { target: { value: "5.00" } });
  fireEvent.change(screen.getByLabelText("Patreon payment reference"), { target: { value: "receipt-123" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Payment receipt reviewed in Patreon." } });
  const form = screen.getByRole("button", { name: "Save reviewed record" }).closest("form")!;
  fireEvent.submit(form);
  expect(postCalls()).toHaveLength(0);
  expect(screen.getByRole("alert")).toHaveTextContent("Confirm that you checked the completed payment in Patreon.");
  fireEvent.click(screen.getByRole("checkbox", { name: /checked this completed payment/ }));
  fireEvent.submit(form);
  await screen.findByRole("heading", { name: "Supporter record saved" });
  const body = JSON.parse(String(postCalls()[0][1]?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    amountCents: 500,
    currency: "USD",
    reference: "receipt-123",
    completedPaymentVerified: true,
    firstSuccessfulPaymentVerified: false,
    version: 7,
    confirm: supporter.patreonMemberId,
  });
  expect(body.paidAt).toBe(new Date("2020-10-01T12:30").toISOString());
});

it("matches accounts with the reviewed member revision, sending only the identity that changed", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 8 } } : data(),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Review account match" }));
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Matched the member to the supplied accounts." },
  });
  const form = screen.getByRole("button", { name: "Save reviewed record" }).closest("form")!;
  fireEvent.submit(form);
  // Resending unchanged values would turn a Patreon or application link into a staff link.
  expect(screen.getByRole("alert")).toHaveTextContent("Unchanged values are kept");
  expect(postCalls()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: "76561198000000002" } });
  fireEvent.submit(form);
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(postCalls()[0][0]).toBe(`supporters/${supporter.id}/link`);
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toEqual({
    id: expect.any(String),
    version: 7,
    confirm: supporter.confirmKey,
    reason: "Matched the member to the supplied accounts.",
    steamId: "76561198000000002",
  });
});

it("a failed or mismatched save stays uncertain and cannot be retried from the same dialog", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 7 } } : data(),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark observation reviewed" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Membership observation reviewed." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Save result not confirmed" });
  expect(screen.queryByRole("button", { name: "Save reviewed record" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("unmounting during a save cannot repopulate private supporter data or start a refresh", async () => {
  const response = deferred<SupporterReviewResponse>();
  request.mockImplementation(async (_path, options) => (options?.method === "POST" ? response.promise : data()));
  const view = render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark observation reviewed" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Membership observation reviewed." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  const calls = request.mock.calls.length;
  view.rerender(page({ ...context, me: { ...context.me, role: "moderator" } }));
  await act(async () => response.resolve({ ok: true, replayed: false, supporter: { ...supporter, version: 8 } }));
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(screen.queryByText(supporter.patreonMemberId!)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(request.mock.calls).toHaveLength(calls);
});

it("shows where each identity came from and how the founder promise was recorded", async () => {
  request.mockResolvedValue(
    data({
      ...supporter,
      discordSource: "patreon",
      patreonDiscordId: "34567890123456789",
      steamSource: "application",
      steamApplicationId: "app-1",
      identityState: "patreon_linked",
      match: {
        ...supporter.match,
        sourceApplication: { id: "app-1", serverId: "primary", status: "revoked" },
        sourceApplicationRevoked: true,
      },
      founder: { awardedAt: policy.startsAt!, paymentId: payment.id, source: "patreon_api", automatic: true },
      nextSteps: [],
    }),
  );
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(within(row).getByText("Discord from Patreon")).toBeInTheDocument();
  expect(within(row).getByText("Discord: Patreon · SteamID: application")).toBeInTheDocument();
  expect(within(row).getByText("Recorded automatically")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Review supporter" }));
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByText(
      "From Patreon (the patron connected it). Patreon now reports a different account: 34567890123456789.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "Copied from the approved whitelist application on server primary. Steam ownership is not verified.",
    ),
  ).toBeInTheDocument();
  expect(within(dialog).getByText(/application it was copied from is no longer approved/)).toBeInTheDocument();
  expect(within(dialog).getByText("Recorded automatically by Gramps.")).toBeInTheDocument();
});

it("says another record links Patreon's Discord account only when the server says so", () => {
  const unlinked: Supporter = {
    ...supporter,
    discordId: null,
    discordSource: null,
    patreonDiscordId: "34567890123456789",
    identityState: "partial",
  };
  expect(discordDescription(unlinked)).toBe(
    "Patreon reports Discord account 34567890123456789. It is not linked to this record yet.",
  );
  expect(discordDescription({ ...unlinked, match: { ...unlinked.match, patreonDiscordElsewhere: true } })).toBe(
    "Patreon reports Discord account 34567890123456789, which another supporter record links.",
  );
  expect(discordDescription({ ...unlinked, patreonDiscordId: null })).toBe(
    "Record the account after confirming the member’s identity.",
  );
});

it("shows the first step still needed with a count in the table and every step in the record", async () => {
  const steps = [
    { code: "no_whitelist_application", area: "steam" as const, message: "No whitelist application yet." },
    { code: "founder_not_first_payment", area: "payment" as const, message: "First payment not confirmed." },
  ];
  request.mockResolvedValue(data({ ...supporter, steamId: null, identityState: "partial", nextSteps: steps }));
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(within(row).getByText("No whitelist application yet. (+1 more)")).toBeInTheDocument();
  expect(within(row).getByText("Partly matched")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Review supporter" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "Still needed" })).toBeInTheDocument();
  expect(within(dialog).getByRole("heading", { name: "Payment needs checking" })).toBeInTheDocument();
  expect(within(dialog).getByText("No whitelist application yet.")).toBeInTheDocument();
  expect(within(dialog).getByText("First payment not confirmed.")).toBeInTheDocument();
});

it("lets staff review a PayPal record, confirming with its record ID, even while Patreon is off", async () => {
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
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  expect(screen.queryByRole("button", { name: "Record checked payment" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Record founder promise" }));
  expect(screen.getByText("Payment supporting this founder promise").parentElement).toHaveTextContent(
    "PayPal payment checked by staff",
  );
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Checked the PayPal payment." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
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
        message:
          "The approved application on server primary names SteamID 76561198000000009. Check it and link it here.",
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
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Review account match" }));
  const steam = screen.getByLabelText("SteamID64");
  expect(steam).toHaveValue("");
  // The server's own step explains the SteamID next to the field.
  expect(steam).toHaveAccessibleDescription(/names SteamID 76561198000000009\. Check it and link it here\./);
  // Changing the Discord account withdraws the offer.
  const discord = screen.getByLabelText("Discord user ID");
  fireEvent.change(discord, { target: { value: "34567890123456789" } });
  expect(screen.queryByRole("button", { name: `Use SteamID ${automaticSteam.steamId}` })).not.toBeInTheDocument();
  expect(screen.getByText(/not offered for a new Discord account/)).toBeInTheDocument();
  fireEvent.change(discord, { target: { value: supporter.discordId } });
  fireEvent.click(screen.getByRole("button", { name: `Use SteamID ${automaticSteam.steamId}` }));
  expect(steam).toHaveValue(automaticSteam.steamId);
  expect(steam).toHaveFocus();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Checked the applicant's SteamID." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ steamId: automaticSteam.steamId });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).not.toHaveProperty("discordId");
  // A linked SteamID is never replaced by the application's.
  const linked = { ...offered, steamId: "76561198000000001", steamSource: "staff" as const };
  expect(applicationSteamId(linked)).toBeNull();
});

it("offers a SteamID approved without a recorded grant, never one the server flags, and says why in the server's words", async () => {
  const message =
    "Another Discord account has applied with this SteamID (76561198000000009). Check who owns it before linking.";
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
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Review account match" }));
  const steam = screen.getByLabelText("SteamID64");
  expect(steam).toHaveValue("");
  expect(steam).toHaveAccessibleDescription(message);
  expect(screen.queryByRole("button", { name: /^Use SteamID/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Filled in from this Discord account/)).not.toBeInTheDocument();
});

it("shows why no founder promise is possible as a note, not as a task", async () => {
  const note = "This payment was not made inside the founder window.";
  request.mockResolvedValue(
    data({
      ...supporter,
      founderEligiblePayment: null,
      founderBlockedReason: "outside_window",
      founderBlockedMessage: note,
      nextSteps: [{ code: "founder_outside_window", area: "info", message: note }],
    }),
  );
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(within(row).getByText("Nothing left to do")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Review supporter" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "Founder promise not possible" })).toBeInTheDocument();
  expect(within(dialog).queryByRole("heading", { name: "Still needed" })).not.toBeInTheDocument();
  expect(within(dialog).getByText(note, { selector: "li" })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Record founder promise" })).toBeDisabled();
});

it("words switched-on matching by the server's rule and says when Patreon leaves it idle", async () => {
  request.mockResolvedValue({
    ...data(),
    automation: { steamFill: true, founderAuto: true, holdHours: 48, configured: false },
  });
  render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  const line = screen.getByText(/Automatic matching:/).closest("p")!;
  expect(line.querySelector("strong")).toHaveTextContent("on");
  // Switched on but idle: the dot does not show it as working.
  expect(line).toHaveClass("status-line", "attention");
  expect(line).not.toHaveClass("good");
  expect(within(line).getByText("SteamID fill on")).toBeInTheDocument();
  expect(within(line).getByText("Automatic founders on")).toBeInTheDocument();
  const detail = line.nextElementSibling!;
  expect(detail).toHaveTextContent("Patreon is not configured, so nothing is matched automatically.");
  expect(detail).toHaveTextContent("has stood for 48 hours");
  expect(detail).not.toHaveTextContent("Staff can always record one");
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
    nextSteps: [{ code: reason, area: "steam", message: `Flagged: ${reason}. Check it before linking.` }],
  };
  expect(applicationSteamId(flagged)).toBeNull();
  request.mockResolvedValue(data(flagged));
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Review account match" }));
  expect(screen.getByLabelText("SteamID64")).toHaveValue("");
  expect(screen.getByLabelText("SteamID64")).toHaveAccessibleDescription(
    `Flagged: ${reason}. Check it before linking.`,
  );
  expect(screen.queryByRole("button", { name: /^Use SteamID/ })).not.toBeInTheDocument();
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
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Review account match" }));
  fireEvent.change(screen.getByLabelText("Discord user ID"), { target: { value: newDiscord } });
  fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: automaticSteam.steamId } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Both accounts belong to the supporter." } });
  const save = screen.getByRole("button", { name: "Save reviewed record" });
  fireEvent.click(save);
  expect(screen.getByRole("alert")).toHaveTextContent("Confirm it belongs to the new Discord account too");
  expect(postCalls()).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox", { name: /belongs to the new Discord account too/ }));
  fireEvent.click(save);
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({
    discordId: newDiscord,
    steamId: automaticSteam.steamId,
    steamConfirmed: true,
  });
});

it("says whether another record links the Discord account Patreon reports, and when Patreon stops reporting one", () => {
  const unlinked: Supporter = {
    ...supporter,
    discordId: null,
    discordSource: null,
    patreonDiscordId: "34567890123456789",
  };
  expect(discordDescription(unlinked)).toBe(
    "Patreon reports Discord account 34567890123456789. It is not linked to this record yet.",
  );
  expect(discordDescription({ ...unlinked, match: { ...unlinked.match, patreonDiscordElsewhere: true } })).toBe(
    "Patreon reports Discord account 34567890123456789, which another supporter record links.",
  );
  const fromPatreon: Supporter = { ...supporter, discordSource: "patreon", patreonDiscordId: null };
  expect(discordDescription(fromPatreon)).toBe("From Patreon (the patron connected it).");
  expect(
    discordDescription({
      ...fromPatreon,
      nextSteps: [{ code: "discord_not_reported", area: "discord", message: "Patreon no longer reports it." }],
    }),
  ).toBe("From Patreon (the patron connected it). Patreon does not currently report this account.");
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

it("filters accounts to match, records ready for staff, automatic previews and automatic founders", async () => {
  const records: Supporter[] = [
    {
      ...supporter,
      id: "a",
      displayName: "Partly matched patron",
      steamId: null,
      identityState: "partial",
      nextSteps: [{ code: "no_whitelist_application", area: "steam", message: "No whitelist application yet." }],
    },
    {
      ...supporter,
      id: "d",
      displayName: "Patron after the window",
      steamId: null,
      identityState: "partial",
      nextSteps: [
        {
          code: "founder_outside_window",
          area: "info",
          message: "This payment was not made inside the founder window.",
        },
      ],
    },
    {
      ...supporter,
      id: "b",
      displayName: "Automatic founder",
      identityState: "patreon_linked",
      founder: { awardedAt: policy.startsAt!, paymentId: payment.id, automatic: true },
      nextSteps: [],
    },
    {
      ...supporter,
      id: "c",
      displayName: "Would be automatic",
      identityState: "patreon_linked",
      nextSteps: [{ code: "founder_ready_automatic_off", area: "founder", message: "Ready for staff to record." }],
    },
  ];
  request.mockResolvedValue({ ...data(), supporters: records, automation: { steamFill: false, founderAuto: false } });
  render(page());
  await screen.findByText("Partly matched patron");
  expect(screen.getByText(/Automatic founder recording is off/)).toBeInTheDocument();
  expect(screen.getByText("SteamID fill off")).toBeInTheDocument();
  expect(screen.getByText("Automatic founders off")).toBeInTheDocument();
  expect(
    screen
      .getByText(/Automatic matching:/)
      .closest("p")!
      .querySelector("strong"),
  ).toHaveTextContent("off");
  const chips = screen.getByRole("group", { name: "Filter supporter records" });
  const shown = () => screen.getAllByRole("button", { name: "Review supporter" }).length;
  // Only a record with a Discord or SteamID step is an account to match, and only it gets the warning badge.
  const after = screen.getByText("Patron after the window").closest("tr")!;
  expect(within(after).getByText("Partly matched")).toHaveClass("neutral");
  expect(within(after).getByText("Nothing left to do")).toBeInTheDocument();
  expect(within(screen.getByText("Partly matched patron").closest("tr")!).getByText("Partly matched")).toHaveClass(
    "warn",
  );
  fireEvent.click(within(chips).getByRole("button", { name: "Accounts to match 1" }));
  expect(screen.getByText("Partly matched patron")).toBeInTheDocument();
  expect(shown()).toBe(1);
  fireEvent.click(within(chips).getByRole("button", { name: "Recorded automatically 1" }));
  expect(screen.getByText("Automatic founder")).toBeInTheDocument();
  expect(shown()).toBe(1);
  fireEvent.click(within(chips).getByRole("button", { name: "Would be recorded automatically 1" }));
  expect(screen.getByText("Would be automatic")).toBeInTheDocument();
  expect(shown()).toBe(1);
  fireEvent.click(within(chips).getByRole("button", { name: "Ready for staff 1" }));
  expect(screen.getByText("Would be automatic")).toBeInTheDocument();
  expect(shown()).toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
});

/** The Patreon import status line. */
function importLine() {
  return screen.getByText(/Patreon import:/).closest("p")!;
}
function getCalls() {
  return request.mock.calls.filter(([, options]) => !options?.method);
}

it("shows the Patreon import as one status line with the last import's details on demand", async () => {
  request.mockResolvedValue(data());
  render(page());
  expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
  const line = importLine();
  expect(line).toHaveClass("status-line", "good");
  // The page is a polite live region, and these relative times change every minute.
  expect(line).toHaveAttribute("aria-live", "off");
  expect(line).not.toHaveAttribute("aria-busy");
  expect(line.querySelector("strong")).toHaveTextContent("last synced 5 min ago");
  expect(within(line).getByText("12 members")).toBeInTheDocument();
  expect(within(line).getByText("3 new payments")).toBeInTheDocument();
  expect(within(line).getByText(/^next/)).toHaveTextContent("next in 25 min");
  expect(within(line).getByText(/^next/)).toHaveAttribute("title", "Runs every 30 min");
  expect(within(line).queryByText(/last tried|to recheck|Discord conflict/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Patreon import needs attention|Patreon rejected the access token/),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Last import"));
  expect(screen.getByText("New payments").nextElementSibling).toHaveTextContent("3");
  expect(screen.getByText("Discord conflicts", { selector: "dt" }).nextElementSibling).toHaveTextContent("0");
  expect(screen.queryByRole("heading", { name: /Discord conflicts|Founder records/ })).not.toBeInTheDocument();
});

it("puts founder records to recheck and Discord conflicts on the status line", async () => {
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
  expect(line.querySelector("strong")).toHaveTextContent("last synced 5 min ago");
  expect(within(line).getByText("1 founder record to recheck")).toBeInTheDocument();
  expect(within(line).getByText("2 Discord conflicts")).toBeInTheDocument();
  expect(screen.queryByText(/Patreon import needs attention/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Last import"));
  expect(screen.getByRole("heading", { level: 3, name: "Discord conflicts" })).toBeVisible();
  expect(within(screen.getByRole("list", { name: "Discord conflicts" })).getByText("conflict-member")).toBeVisible();
  expect(screen.getByText("Patreon's Discord account is already on another supporter record")).toBeVisible();
  expect(screen.getByText("Patreon reports a different Discord account than the one recorded")).toBeVisible();
  expect(screen.getByRole("heading", { level: 3, name: "Founder records to recheck" })).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "Founder records to recheck" })).getByText("founder-member"),
  ).toBeVisible();
  expect(screen.getByText("Payment refunded-charge is not verified")).toBeVisible();
});

it("says when a founder's own payment is no longer marked as the first payment", async () => {
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
  expect(within(importLine()).getByText("1 founder record to recheck")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Last import"));
  expect(screen.getByText("Payment first-charge is no longer marked as the first payment")).toBeVisible();
  expect(screen.queryByText(/is not verified/)).not.toBeInTheDocument();
});

it("offers Sync now only to administrators", () => {
  const status = (role: AdminContextValue["me"]["role"]) => (
    <AdminContext.Provider value={{ ...context, me: { ...context.me, role } }}>
      <PatreonImport sync={syncStatus()} unavailable={false} disabled={false} onSynced={vi.fn()} />
    </AdminContext.Provider>
  );
  const view = render(status("moderator"));
  expect(importLine().querySelector("strong")).toHaveTextContent("last synced 5 min ago");
  expect(screen.queryByRole("button", { name: /Sync now|Syncing/ })).not.toBeInTheDocument();
  view.rerender(status("viewer"));
  expect(importLine()).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Sync now|Syncing/ })).not.toBeInTheDocument();
  view.rerender(status("admin"));
  expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
});

it("says the Patreon import is not configured and offers no sync", async () => {
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
  await screen.findByRole("button", { name: "Review supporter" });
  const line = importLine();
  expect(line).toHaveClass("quiet");
  expect(line).toHaveTextContent(/^Patreon import: Not configured$/);
  expect(line).not.toHaveAttribute("title");
  // Setup guidance is visible text, not a tooltip.
  expect(
    screen.getByText(
      "Set PATREON_ENABLED, PATREON_CAMPAIGN_ID and PATREON_CREATOR_ACCESS_TOKEN in Railway to import members.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /Sync now|Syncing/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Last import")).not.toBeInTheDocument();
  expect(screen.queryByText(/Patreon import needs attention/)).not.toBeInTheDocument();
});

it("explains a token problem found before any request while the import is not configured", async () => {
  const malformed =
    "PATREON_CREATOR_ACCESS_TOKEN does not look like a Patreon access token. Copy the Creator's Access Token again.";
  request.mockResolvedValue(
    data(supporter, syncStatus({ configured: false, lastSuccessAt: null, lastAttemptAt: null, lastError: malformed })),
  );
  render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  expect(importLine()).toHaveClass("attention");
  expect(importLine()).toHaveTextContent(/^Patreon import: Not configured$/);
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
  expect(line.querySelector("strong")).toHaveTextContent("last synced 5 min ago");
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
  expect(within(line).getByText(/^last synced/)).toHaveTextContent("last synced 5 min ago");
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
  await waitFor(() => expect(importLine().querySelector("strong")).toHaveTextContent("last synced just now"));
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
  await screen.findByText(/Supporter records could not be refreshed/);
  const line = importLine();
  expect(line).toHaveTextContent(/^Patreon import: Status unavailable$/);
  expect(line).toHaveClass("attention");
  expect(screen.queryByText("Patreon rejected the access token.")).not.toBeInTheDocument();
  expect(screen.queryByText("Last import")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
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

it("keeps a note that no founder promise is possible apart from the steps still needed", async () => {
  const note = { code: "founder_outside_window", area: "info" as const, message: "Not inside the founder window." };
  const discordStep = { code: "connect_discord_in_patreon", area: "discord" as const, message: "Connect Discord." };
  request.mockResolvedValue(data({ ...supporter, nextSteps: [discordStep, note] }));
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  expect(within(row).getByText("Connect Discord.")).toBeInTheDocument();
  expect(within(row).queryByText(/more\)/)).not.toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Review supporter" }));
  const dialog = screen.getByRole("dialog");
  const still = within(dialog).getByRole("heading", { name: "Still needed" });
  const notPossible = within(dialog).getByRole("heading", { name: "Founder promise not possible" });
  expect(still.nextElementSibling).toHaveTextContent("Connect Discord.");
  expect(still.nextElementSibling).not.toHaveTextContent("Not inside the founder window.");
  expect(notPossible.nextElementSibling).toHaveTextContent("Not inside the founder window.");
});

it("puts the step still needed in its own wrapping column", async () => {
  request.mockResolvedValue(data());
  render(page());
  const row = (await screen.findByText(supporter.displayName!)).closest("tr")!;
  const headers = screen.getAllByRole("columnheader").map((header) => header.textContent ?? "");
  const column = (label: string) => headers.findIndex((header) => header.includes(label));
  expect(column("Still needed")).toBeGreaterThan(column("Founder record"));
  const cells = within(row).getAllByRole("cell");
  const step = within(row).getByText(supporter.nextSteps[0].message);
  expect(cells[column("Still needed")]).toContainElement(step);
  expect(step).toHaveClass("supporter-wrap");
  expect(cells[column("Founder record")]).not.toHaveTextContent(supporter.nextSteps[0].message);
});

it("sorts the account match column from not linked to matched through Patreon", async () => {
  const states = ["patreon_linked", "unlinked", "staff_linked", "partial"] as const;
  request.mockResolvedValue({
    ...data(),
    supporters: states.map((identityState, index) => ({
      ...supporter,
      id: `record-${index}`,
      displayName: `Record ${identityState}`,
      identityState,
    })),
  });
  render(page());
  await screen.findByText("Record unlinked");
  fireEvent.click(screen.getByRole("button", { name: /Account match/ }));
  const order = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getByText(/^Record /).textContent);
  expect(order).toEqual(["Record unlinked", "Record partial", "Record staff_linked", "Record patreon_linked"]);
});

it("shows a matching run that could not finish, an idle switch, the refund wait and the last run", async () => {
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
  const line = screen.getByText(/Automatic matching:/).closest("p")!;
  expect(line).toHaveClass("status-line", "attention");
  expect(line.querySelector("strong")).toHaveTextContent("partly on");
  const detail = line.nextElementSibling!;
  expect(detail).toHaveTextContent("Patreon is not configured, so nothing is matched automatically.");
  expect(detail).toHaveTextContent("Switched on, it waits 72 hours after the first payment for refunds.");
  expect(detail).toHaveTextContent("Choose the “Would be recorded automatically” filter");
  expect(detail).toHaveTextContent("Last run");
});

it("shows no matching problem while the last run finished", async () => {
  request.mockResolvedValue({
    ...data(),
    automation: { steamFill: true, founderAuto: true, holdHours: 24, configured: true, lastError: null },
  });
  render(page());
  await screen.findByText(supporter.displayName!);
  expect(screen.queryByText("Automatic matching needs attention.")).not.toBeInTheDocument();
  expect(screen.queryByText(/Patreon is not configured/)).not.toBeInTheDocument();
  const line = screen.getByText(/Automatic matching:/).closest("p")!;
  expect(line).toHaveClass("status-line", "good");
  expect(line.nextElementSibling).not.toHaveTextContent("Last run");
});
