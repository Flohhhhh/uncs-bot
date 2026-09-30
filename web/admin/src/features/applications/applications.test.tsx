import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { ApplicationsPage } from "./index";
import type { ApplicationReviewResponse, ApplicationsResponse, WhitelistApplication } from "./types";

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
  refresh: vi.fn(),
  invalidateOverview: vi.fn(),
  notify: vi.fn(),
  openAction: vi.fn(),
};
const record: WhitelistApplication = {
  id: "01234567-89ab-4cde-8fab-0123456789ab",
  discordUserId: "23456789012345678",
  discordDisplayName: "<img src=x onerror=alert(1)>",
  steamId: "76561198000000001",
  steamOwnershipVerified: false,
  relationship: "unc_member",
  email: "private@example.com",
  emailVerified: false,
  contactConsent: true,
  consentVersion: "fixture-v1",
  contactConsentAt: "2026-09-30T15:00:00Z",
  rulesAcceptedAt: "2026-09-30T15:00:00Z",
  status: "pending",
  submittedAt: "2026-09-30T15:00:00Z",
  updatedAt: "2026-09-30T15:00:00Z",
  reviewedAt: null,
  reviewedBy: null,
  reviewReason: null,
  reviewKind: null,
  reviewId: null,
  actionId: null,
  lastActionState: null,
  lastActionMessage: null,
};
function page(value = context) {
  return (
    <AdminContext.Provider value={value}>
      <ApplicationsPage />
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

it("waits for a refreshed list before freezing an application for review", async () => {
  const refreshed = deferred<ApplicationsResponse>();
  request.mockResolvedValueOnce({ applications: [record] }).mockReturnValueOnce(refreshed.promise);
  const view = render(page());
  await screen.findByRole("button", { name: "View request" });
  view.rerender(page({ ...context, refreshVersion: 1 }));
  const open = screen.getByRole("button", { name: "View request" });
  expect(open).toBeDisabled();
  fireEvent.click(open);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => refreshed.resolve({ applications: [{ ...record, status: "processing" }] }));
  fireEvent.click(screen.getByRole("button", { name: "View request" }));
  expect(within(screen.getByRole("dialog")).getByText("Processing")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review approval" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(0);
});

it("keeps the latest read-only review receipt distinct from its original game action", async () => {
  const actionId = "01234567-89ab-4cde-8fab-0123456789ac";
  const reviewId = "01234567-89ab-4cde-8fab-0123456789ad";
  request.mockResolvedValue({
    applications: [
      {
        ...record,
        status: "needs_review",
        reviewKind: "recheck",
        actionId,
        reviewId,
        lastActionState: "pending",
        lastActionMessage: "No game change was sent.",
      },
    ],
  });
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "View request" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText(`Review ID: ${reviewId}`)).toBeInTheDocument();
  expect(dialog.getByText(`Original whitelist action ID: ${actionId}`)).toBeInTheDocument();
  expect(dialog.getByText("Last review: pending")).toBeInTheDocument();
});

it("does not fetch private records for a non-admin; contact details appear only inside the request", async () => {
  const view = render(page({ ...context, me: { ...context.me, role: "moderator" } }));
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue({ applications: [record] });
  view.rerender(page());
  await screen.findByRole("button", { name: "View request" });
  expect(screen.queryByText(record.email!)).not.toBeInTheDocument();
  expect(screen.getByText(record.discordDisplayName)).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View request" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(record.email!)).toBeInTheDocument();
  expect(within(dialog).getByText("Unverified email address")).toBeInTheDocument();
  expect(within(dialog).getByText("UNC member (self-reported)")).toBeInTheDocument();
  expect(within(dialog).getByText("Self-reported · ownership not verified")).toBeInTheDocument();
});

it("submits one UUID review after named-player confirmation and never calls accepted access confirmed", async () => {
  const response = deferred<ApplicationReviewResponse>();
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? response.promise : { applications: [record] },
  );
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "View request" }));
  fireEvent.click(screen.getByRole("button", { name: "Review approval" }));
  expect(screen.getByText(`Grant whitelist access to ${record.discordDisplayName}`)).toBeInTheDocument();
  expect(screen.getByText(`SteamID64 ${record.steamId}`)).toBeInTheDocument();
  const form = screen.getByRole("button", { name: "Approve this SteamID" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(postCalls()).toHaveLength(1);
  const [path, options] = postCalls()[0];
  const body = JSON.parse(String(options?.body)) as { id: string; reason: string };
  expect(path).toBe(`applications/${record.id}/approve`);
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.reason).toBe("Website whitelist application reviewed and approved.");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () =>
    response.resolve({
      application: { ...record, status: "needs_review" },
      outcome: { id: body.id, state: "accepted", message: "Accepted; confirmation pending." },
    }),
  );
  expect(screen.getByRole("heading", { name: "Application needs review" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Whitelist access confirmed" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve this SteamID" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it.each(["pending", "unknown", "applied"] as const)(
  "requires approved plus applied for a %s outcome",
  async (state) => {
    request.mockImplementation(async (_path, options) => {
      if (options?.method !== "POST") return { applications: [record] };
      const body = JSON.parse(String(options.body)) as { id: string };
      return {
        application: { ...record, status: "approved" },
        outcome: { id: body.id, state, message: "Read the outcome." },
      };
    });
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: "View request" }));
    fireEvent.click(screen.getByRole("button", { name: "Review approval" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve this SteamID" }));
    await screen.findByRole("heading", {
      name: state === "applied" ? "Whitelist access confirmed" : "Application needs review",
    });
  },
);

it("offers only read-only recheck for an uncertain grant and no actions for processing", async () => {
  request.mockResolvedValue({ applications: [{ ...record, status: "needs_review" }] });
  const view = render(page());
  fireEvent.click(await screen.findByRole("button", { name: "View request" }));
  expect(screen.queryByRole("button", { name: "Review approval" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Decline request" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Recheck live whitelist" }));
  expect(screen.getByText(/This does not add, remove, or resend anything to the game/)).toBeInTheDocument();
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST"
      ? {
          application: { ...record, status: "needs_review" },
          outcome: {
            id: (JSON.parse(String(options.body)) as { id: string }).id,
            state: "pending",
            message: "No game change was sent.",
          },
        }
      : { applications: [{ ...record, status: "processing" }] },
  );
  fireEvent.click(screen.getByRole("button", { name: "Check running whitelist" }));
  await screen.findByRole("heading", { name: "Application needs review" });
  expect(postCalls()[0][0]).toBe(`applications/${record.id}/recheck`);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  view.rerender(page({ ...context, refreshVersion: 1 }));
  await waitFor(() => expect(screen.getByText("Processing")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "View request" }));
  expect(
    within(screen.getByRole("dialog")).queryByRole("button", {
      name: /Review approval|Decline request|Recheck live whitelist/,
    }),
  ).not.toBeInTheDocument();
});

it("a failed mutation cannot be submitted again from its review", async () => {
  request.mockImplementation(async (_path, options) => {
    if (options?.method === "POST") throw new Error("Connection ended before confirmation");
    return { applications: [record] };
  });
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "View request" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline request" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Duplicate community request reviewed." } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm decline" }));
  await screen.findByRole("heading", { name: "Review result not confirmed" });
  expect(screen.queryByRole("button", { name: "Confirm decline" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(1);
});

it("drops private details immediately on role change and ignores an in-flight review completion", async () => {
  const response = deferred<ApplicationReviewResponse>();
  request.mockImplementation(async (_path, options) =>
    options?.method === "POST" ? response.promise : { applications: [record] },
  );
  const view = render(page());
  fireEvent.click(await screen.findByRole("button", { name: "View request" }));
  fireEvent.click(screen.getByRole("button", { name: "Review approval" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve this SteamID" }));
  const body = JSON.parse(String(postCalls()[0][1]?.body)) as { id: string };
  const callsBefore = request.mock.calls.length;
  view.rerender(page({ ...context, me: { ...context.me, role: "viewer" } }));
  expect(screen.queryByText(record.email!)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () =>
    response.resolve({
      application: { ...record, status: "approved" },
      outcome: { id: body.id, state: "applied", message: "Applied" },
    }),
  );
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(request.mock.calls).toHaveLength(callsBefore);
  expect(screen.queryByText(record.email!)).not.toBeInTheDocument();
});
