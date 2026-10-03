import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { SupportersPage } from "./index";
import { applicationSteamId, founderReady, reviewInput } from "./policy";
import type { FounderPolicy, PaymentEvidence, Supporter, SupporterReviewResponse, SupportersResponse } from "./types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const context: AdminContextValue = {
  me: { id: "12345678901234567", name: "Admin", role: "admin", csrf: "fixture" },
  overview: null,
  stale: true,
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
  },
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
function data(record = supporter): SupportersResponse {
  return {
    enabled: true,
    configured: true,
    webhookConfigured: true,
    founderPolicy: policy,
    supporters: [record],
    note: "Private records",
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
  expect(
    screen.getByText(/No whitelist, priority tier, or Discord role is granted from this page/),
  ).toBeInTheDocument();
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
  expect(
    screen.getByText("Your review has been recorded. No game access or Discord role was changed."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save reviewed record" })).not.toBeInTheDocument();
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

it("fills in the SteamID an approved application offers only when none is linked, and says to check it", async () => {
  const offered = {
    ...supporter,
    steamId: null,
    steamSource: null,
    identityState: "partial" as const,
    match: { ...supporter.match, steam: automaticSteam },
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
  expect(screen.getByLabelText("SteamID64")).toHaveValue(automaticSteam.steamId);
  expect(screen.getByText(/Check it belongs to this supporter before saving/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Checked the applicant's SteamID." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({ steamId: automaticSteam.steamId });
  expect(JSON.parse(String(postCalls()[0][1]?.body))).not.toHaveProperty("discordId");
  // A linked SteamID is never replaced by the application's.
  const linked = { ...offered, steamId: "76561198000000001", steamSource: "staff" as const };
  expect(applicationSteamId(linked)).toBeNull();
});

function form(values: Record<string, string>) {
  const input = new FormData();
  input.set("reason", "Checked both accounts with the supporter");
  for (const [key, value] of Object.entries(values)) input.set(key, value);
  return input;
}

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
      nextSteps: [],
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
  const filter = screen.getByRole("combobox", { name: "Filter supporter records" });
  const shown = () => screen.getAllByRole("button", { name: "Review supporter" }).length;
  fireEvent.change(filter, { target: { value: "unlinked" } });
  expect(screen.getByText("Partly matched patron")).toBeInTheDocument();
  expect(shown()).toBe(1);
  fireEvent.change(filter, { target: { value: "automatic" } });
  expect(screen.getByText("Automatic founder")).toBeInTheDocument();
  expect(shown()).toBe(1);
  fireEvent.change(filter, { target: { value: "preview" } });
  expect(screen.getByText("Would be automatic")).toBeInTheDocument();
  expect(shown()).toBe(1);
  fireEvent.change(filter, { target: { value: "staff" } });
  expect(screen.getByText("Would be automatic")).toBeInTheDocument();
  expect(shown()).toBe(1);
});
