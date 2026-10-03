import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { SupportersPage } from "./index";
import { founderReady, founderWindowLabel, reviewInput } from "./policy";
import type { FounderPolicy, PaymentEvidence, Supporter, SupporterReviewResponse, SupportersResponse } from "./types";

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
  patreonMemberId: "patreon-member-1",
  displayName: "<img src=x onerror=alert(1)>",
  patronStatus: "active_patron",
  lastChargeStatus: "Paid",
  lastChargeAt: "2026-10-30T15:00:00Z",
  observedAt: "2026-10-30T15:00:00Z",
  reviewState: "pending",
  discordId: "23456789012345678",
  steamId: "76561198000000001",
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
};
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
  expect(within(dialog).getByText("Matched by staff; not verified through Discord sign-in.")).toBeInTheDocument();
  expect(within(dialog).getByText("Staff-entered; Steam ownership is not verified by this page.")).toBeInTheDocument();
  expect(
    screen.getByText("Records only. Grants no game or Discord access. A membership is not a verified payment."),
  ).toBeInTheDocument();
});

it("states the record limits once and shows the founder window as one label", async () => {
  request.mockResolvedValue(data());
  render(page());
  await screen.findByRole("button", { name: "Review supporter" });
  expect(screen.getAllByText(/Grants no game or Discord access/)).toHaveLength(1);
  expect(screen.queryByText(/THANK THE CREW/)).not.toBeInTheDocument();
  expect(screen.queryByText("Private records")).not.toBeInTheDocument();
  expect(screen.getByText(founderWindowLabel(policy))).toHaveAttribute(
    "title",
    expect.stringContaining("end not included"),
  );
  expect(screen.getByText("Patreon webhook connected")).toBeInTheDocument();
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

it("founder eligibility requires first checked payment, linked identities, amount/currency and the exact date window", () => {
  expect(founderReady(supporter, policy)).toBe(true);
  const invalidPayments: Partial<PaymentEvidence>[] = [
    { source: "signed_status" },
    { verificationState: "unverified" },
    { firstSuccessfulPaymentVerified: false },
    { currency: "CAD" },
    { amountCents: null },
    { amountCents: 499 },
    { paidAt: "2026-09-30T03:59:59.999Z" },
    { paidAt: policy.endsAt! },
    { paidAt: "not-a-date" },
  ];
  for (const invalid of invalidPayments)
    expect(founderReady({ ...supporter, founderEligiblePayment: { ...payment, ...invalid } }, policy)).toBe(false);
  for (const invalid of [
    { identityState: "unlinked" as const },
    { discordId: null },
    { steamId: null },
    { steamId: "76561190000000001" },
    { founderEligiblePayment: null },
    { founder: { awardedAt: policy.startsAt!, paymentId: payment.id } },
  ])
    expect(founderReady({ ...supporter, ...invalid }, policy)).toBe(false);
  expect(founderReady(supporter, { ...policy, configured: false })).toBe(false);
  expect(
    founderReady({ ...supporter, founderEligiblePayment: { ...payment, paidAt: "2026-10-15T03:59:59.999Z" } }, policy),
  ).toBe(true);
});

it("records a founder promise against a verified first payment from the Patreon import", async () => {
  const imported: PaymentEvidence = { ...payment, source: "patreon_api", reference: "patreon-event-1" };
  const record = { ...supporter, founderEligiblePayment: imported };
  expect(founderReady(record, policy)).toBe(true);
  for (const invalid of [{ verificationState: "unverified" as const }, { firstSuccessfulPaymentVerified: false }])
    expect(founderReady({ ...record, founderEligiblePayment: { ...imported, ...invalid } }, policy)).toBe(false);
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
    expect(reviewInput(supporter, "link", "review-id", input, policy)).toMatchObject({ steamId });
  }
  for (const steamId of ["76561190000000001", "76561197960265728", "76561202255233024"]) {
    input.set("steamId", steamId);
    expect(() => reviewInput(supporter, "link", "review-id", input, policy)).toThrow("SteamID64");
  }
});

it("active membership and signed payment status do not unlock founder recognition", async () => {
  request.mockResolvedValue(data({ ...supporter, founderEligiblePayment: { ...payment, source: "signed_status" } }));
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  expect(screen.getByRole("button", { name: "Record founder promise" })).toBeDisabled();
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

it("matches accounts with the reviewed member revision and explicit IDs", async () => {
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? { ok: true, replayed: false, supporter: { ...supporter, version: 8 } } : data(),
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Review supporter" }));
  fireEvent.click(screen.getByRole("button", { name: "Review account match" }));
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Matched the member to the supplied accounts." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed record" }));
  await screen.findByRole("heading", { name: "Supporter record saved" });
  expect(postCalls()[0][0]).toBe(`supporters/${supporter.id}/link`);
  expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({
    version: 7,
    confirm: supporter.patreonMemberId,
    discordId: supporter.discordId,
    steamId: supporter.steamId,
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
  expect(screen.queryByText(supporter.patreonMemberId)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(request.mock.calls).toHaveLength(calls);
});
