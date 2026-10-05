import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { FIRST_APPROVAL_GAP_MS } from "./bulk-approve";
import { ApplicationsPage } from "./index";
import type { ApplicationReviewResponse, ApplicationsResponse, WhitelistApplication } from "./types";

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
/** A dashboard that tracks `busy` as the real one does, so the page locks while a batch runs. */
function Live({ refreshVersion = 0 }: { refreshVersion?: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <AdminContext.Provider value={{ ...context, busy, setBusy, refreshVersion }}>
      <ApplicationsPage />
    </AdminContext.Provider>
  );
}
function named(index: number, name: string, status: WhitelistApplication["status"] = "pending"): WhitelistApplication {
  return {
    ...record,
    id: `01234567-89ab-4cde-8fab-00000000000${index}`,
    discordDisplayName: name,
    steamId: `7656119800000001${index}`,
    status,
  };
}
const approvePath = (application: WhitelistApplication) => `applications/${application.id}/approve`;
const reads = () => request.mock.calls.length - postCalls().length;
async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
/** Lets a held request answer, then lets the page react to it. */
async function settle(release: () => void) {
  await act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
});
afterEach(() => vi.useRealTimers());

it("announces a failed application read without announcing the read while it loads", async () => {
  request.mockRejectedValue(new Error("The dashboard could not be reached."));
  render(page());
  expect(screen.getByText("Loading applications…").closest("[role=alert]")).toBeNull();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Applications could not be loaded");
  expect(alert).toHaveTextContent("The dashboard could not be reached.");
});

it("says applications are turned off instead of reporting a load failure", async () => {
  request.mockResolvedValue({ enabled: false, serverId: "primary", applications: [] });
  const view = render(page());
  expect(await screen.findByText("Website applications are turned off")).toBeInTheDocument();
  expect(screen.getByText(/WHITELIST_APPLICATIONS_ENABLED=true/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("No applications yet")).not.toBeInTheDocument();
  request.mockRejectedValue(new Error("The dashboard request timed out. Try refreshing this page."));
  view.rerender(page({ ...context, refreshVersion: 1 }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The dashboard request timed out.");
  expect(screen.queryByText("Website applications are turned off")).not.toBeInTheDocument();
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
  await act(async () => refreshed.resolve({ enabled: true, applications: [{ ...record, status: "processing" }] }));
  fireEvent.click(screen.getByRole("button", { name: "View request" }));
  expect(within(screen.getByRole("dialog")).getByText("Awaiting confirmation")).toBeInTheDocument();
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
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: `  ${record.steamId}  ` } });
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

it("offers only read-only recheck for uncertain grants, including interrupted processing", async () => {
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
  await waitFor(() =>
    expect(
      within(screen.getByRole("table", { name: "Community requests" })).getByText("Awaiting confirmation"),
    ).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "View request" }));
  expect(
    within(screen.getByRole("dialog")).queryByRole("button", {
      name: /Review approval|Decline request/,
    }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Recheck live whitelist" }));
  fireEvent.click(screen.getByRole("button", { name: "Check running whitelist" }));
  await screen.findByRole("heading", { name: "Application needs review" });
  expect(postCalls().map(([path]) => path)).toEqual([
    `applications/${record.id}/recheck`,
    `applications/${record.id}/recheck`,
  ]);
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

it("filters loaded requests with counted status chips", async () => {
  const second = { ...record, id: "01234567-89ab-4cde-8fab-0123456789ac", discordDisplayName: "Follow-up player" };
  const third = { ...record, id: "01234567-89ab-4cde-8fab-0123456789ad", discordDisplayName: "Approved player" };
  request.mockResolvedValue({
    applications: [record, { ...second, status: "needs_review" }, { ...third, status: "approved" }],
  });
  render(page());
  await screen.findByText("Follow-up player");
  expect(screen.queryByRole("combobox", { name: "Application status" })).not.toBeInTheDocument();
  const chips = screen.getByRole("group", { name: "Application status" });
  expect(within(chips).getByRole("button", { name: "All 3" })).toHaveAttribute("aria-pressed", "true");
  expect(within(chips).getByRole("button", { name: "Awaiting review 1" })).toBeInTheDocument();
  expect(within(chips).getByRole("button", { name: "Declined 0" })).toBeInTheDocument();
  fireEvent.click(within(chips).getByRole("button", { name: "Need follow-up 1" }));
  const table = screen.getByRole("table", { name: "Community requests" });
  expect(within(table).getByText("Follow-up player")).toBeInTheDocument();
  expect(within(table).queryByText("Approved player")).not.toBeInTheDocument();
  expect(screen.getByText(/^1 shown of 3 loaded/)).toBeInTheDocument();
  fireEvent.click(within(chips).getByRole("button", { name: "All 3" }));
  expect(within(screen.getByRole("table", { name: "Community requests" })).getAllByRole("row")).toHaveLength(4);
  expect(postCalls()).toHaveLength(0);
});

it("lets only requests awaiting review be ticked, and selects all pending in the shown list", async () => {
  request.mockResolvedValue({
    enabled: true,
    applications: [
      named(1, "Pending one"),
      named(2, "Pending two"),
      named(3, "Follow-up", "needs_review"),
      named(4, "In progress", "processing"),
      named(5, "Already in", "approved"),
      named(6, "Turned down", "declined"),
    ],
  });
  render(<Live />);
  await screen.findByText("Pending one");
  const boxes = () =>
    within(screen.getByRole("table", { name: "Community requests" }))
      .queryAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label"));
  const approve = () => screen.queryByRole("button", { name: /^Approve \d+$/ });
  expect(boxes()).toEqual(["Select Pending one", "Select Pending two"]);
  expect(approve()).not.toBeInTheDocument();
  const all = screen.getByRole("checkbox", { name: "Select all pending" });
  fireEvent.click(all);
  expect(all).toBeChecked();
  expect(screen.getByText("2 selected")).toBeInTheDocument();
  expect(approve()).toHaveTextContent("Approve 2");
  expect(approve()).toBeEnabled();
  fireEvent.click(all);
  expect(approve()).not.toBeInTheDocument();
  // With a search, "Select all pending" covers only the requests that are shown.
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "two" } });
  fireEvent.click(all);
  expect(approve()).toHaveTextContent("Approve 1");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  expect(screen.getByRole("checkbox", { name: "Select Pending two" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select Pending one" })).not.toBeChecked();
  expect(all).not.toBeChecked();
  // A list with nothing awaiting review has nothing to tick. A selection made elsewhere is kept and counted.
  fireEvent.click(screen.getByRole("button", { name: "Need follow-up 2" }));
  expect(boxes()).toEqual([]);
  expect(all).toBeDisabled();
  expect(screen.getByText("1 selected (1 not shown)")).toBeInTheDocument();
  expect(approve()).toHaveTextContent("Approve 1");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(approve()).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(0);
});

it("starts a batch only from a list that was just read, without a request that is no longer pending", async () => {
  const refreshed = deferred<ApplicationsResponse>();
  const first = named(1, "Pending one");
  const second = named(2, "Pending two");
  request
    .mockResolvedValueOnce({ enabled: true, applications: [first, second] })
    .mockReturnValueOnce(refreshed.promise);
  const view = render(<Live />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select all pending" }));
  view.rerender(<Live refreshVersion={1} />);
  const approve = screen.getByRole("button", { name: "Approve 2" });
  expect(approve).toBeDisabled();
  fireEvent.click(approve);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => refreshed.resolve({ enabled: true, applications: [{ ...first, status: "approved" }, second] }));
  fireEvent.click(screen.getByRole("button", { name: "Approve 1" }));
  const names = within(screen.getByRole("list", { name: "Applications to approve" })).getAllByRole("listitem");
  expect(names.map((entry) => entry.textContent)).toEqual([`Pending twoSteamID64 ${second.steamId}`]);
  expect(postCalls()).toHaveLength(0);
});

it("approves every ticked request with the usual reason, then reads the list again with nothing selected", async () => {
  vi.useFakeTimers();
  const first = named(1, "First");
  const second = named(2, "Second");
  const approved = new Set<string>();
  request.mockImplementation(async (path, options) => {
    const target = [first, second].find((entry) => path === approvePath(entry));
    if (options?.method !== "POST" || !target)
      return {
        enabled: true,
        applications: [first, second].map((entry) =>
          approved.has(entry.id) ? { ...entry, status: "approved" } : entry,
        ),
      };
    approved.add(target.id);
    return {
      application: { ...target, status: "approved" },
      outcome: { id: (JSON.parse(String(options.body)) as { id: string }).id, state: "applied", message: "Active." },
    };
  });
  render(<Live />);
  await flush();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByLabelText("Reason")).toHaveValue("Website whitelist application reviewed and approved.");
  expect(postCalls()).toHaveLength(0);
  fireEvent.click(dialog.getByRole("button", { name: "Approve 2" }));
  await flush(FIRST_APPROVAL_GAP_MS);
  expect(postCalls()).toHaveLength(1);
  // The page behind the dialog is locked while the batch runs.
  expect(screen.getByRole("checkbox", { name: "Select Second" })).toBeDisabled();
  await flush(4_000);
  expect(postCalls().map(([path]) => path)).toEqual([first, second].map(approvePath));
  const bodies = postCalls().map(([, options]) => JSON.parse(String(options?.body)) as { id: string; reason: string });
  expect(bodies.map((body) => body.reason)).toEqual(
    Array(2).fill("Website whitelist application reviewed and approved."),
  );
  expect(bodies[0].id).not.toBe(bodies[1].id);
  expect(dialog.getByRole("heading", { name: "All approved" })).toBeInTheDocument();
  expect(dialog.getByRole("status", { name: "Approval progress" })).toHaveTextContent("2 approved.");
  expect(reads()).toBe(2);
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  await flush(600_000);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Last bulk approval" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Approve \d+$/ })).not.toBeInTheDocument();
  expect(within(screen.getByRole("table", { name: "Community requests" })).getAllByText("Approved")).toHaveLength(2);
  expect(postCalls()).toHaveLength(2);
});

it("leaves a refused request for its own review, and keeps the ones after it selected", async () => {
  vi.useFakeTimers();
  const [first, second, third] = [named(1, "First"), named(2, "Second"), named(3, "Third")];
  const refusal = "This SteamID is already on the running whitelist. Confirm this Discord member owns it.";
  // The server refuses before it claims anything, so every request is still pending when the list is read again.
  request.mockImplementation(async (path, options) => {
    if (options?.method !== "POST") return { enabled: true, applications: [first, second, third] };
    throw Object.assign(new Error(refusal), { status: 409 });
  });
  render(<Live />);
  await flush();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Second" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Third" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Approve 2" }));
  await flush(600_000);
  expect(postCalls().map(([path]) => path)).toEqual([approvePath(second)]);
  expect(dialog.getByRole("status", { name: "Approval progress" })).toHaveTextContent(
    "0 approved. 1 needs a look. 1 not sent.",
  );
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  await flush();
  expect(within(screen.getByRole("region", { name: "Last bulk approval" })).getByText(refusal)).toBeInTheDocument();
  expect(screen.getByText("1 selected")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Select First" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select Second" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select Third" })).toBeChecked();
  // The refused request keeps the single review, exactly as before.
  const table = within(screen.getByRole("table", { name: "Community requests" }));
  fireEvent.click(table.getAllByRole("button", { name: "View request" })[1]);
  expect(screen.getByRole("button", { name: "Review approval" })).toBeEnabled();
  expect(postCalls()).toHaveLength(1);
});

it("keeps a running batch in its order through a refresh, then keeps what was never sent selected", async () => {
  vi.useFakeTimers();
  const [first, second, third] = [named(1, "First"), named(2, "Second"), named(3, "Third")];
  let listed = [first, second, third];
  const answers: (() => void)[] = [];
  request.mockImplementation((path, options) => {
    const target = [first, second, third].find((entry) => path === approvePath(entry));
    if (options?.method !== "POST" || !target) return Promise.resolve({ enabled: true, applications: listed });
    const id = (JSON.parse(String(options.body)) as { id: string }).id;
    return new Promise((resolve) =>
      answers.push(() =>
        resolve(
          target === second
            ? {
                application: { ...second, status: "needs_review" },
                outcome: { id, state: "unknown", message: "Approval could not be confirmed." },
              }
            : { application: { ...target, status: "approved" }, outcome: { id, state: "applied", message: "Active." } },
        ),
      ),
    );
  });
  const view = render(<Live />);
  await flush();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve 3" }));
  const dialog = within(screen.getByRole("dialog"));
  const progress = () => dialog.getByRole("status", { name: "Approval progress" });
  fireEvent.click(dialog.getByRole("button", { name: "Approve 3" }));
  await flush(FIRST_APPROVAL_GAP_MS);
  expect(postCalls()).toHaveLength(1);
  // The list is read again mid-batch, in another order and with the first request already claimed.
  listed = [third, second, { ...first, status: "processing" }];
  const before = reads();
  view.rerender(<Live refreshVersion={1} />);
  await flush();
  expect(reads()).toBe(before + 1);
  expect(postCalls()).toHaveLength(1);
  expect(progress()).toHaveTextContent("Approving 1 of 3: First.");
  await settle(answers[0]);
  expect(progress()).toHaveTextContent("Approving 2 of 3: Second.");
  await flush(4_000);
  expect(postCalls().map(([path]) => path)).toEqual([first, second].map(approvePath));
  listed = [third, { ...second, status: "needs_review" }, { ...first, status: "approved" }];
  await settle(answers[1]);
  expect(dialog.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
  expect(progress()).toHaveTextContent("1 approved. 1 needs a look. 1 not sent.");
  expect(dialog.getByText("The rest are still selected.")).toBeInTheDocument();
  await flush(600_000);
  expect(postCalls()).toHaveLength(2);
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  await flush();
  // The page keeps the result until it is dismissed. Nothing unconfirmed is called approved.
  const last = within(screen.getByRole("region", { name: "Last bulk approval" }));
  expect(last.getByText("1 approved. 1 needs a look. 1 not sent.", { exact: false })).toBeInTheDocument();
  expect(last.getAllByRole("listitem")).toHaveLength(1);
  expect(last.getByText("Second")).toBeInTheDocument();
  expect(last.getByText("Approval could not be confirmed.")).toBeInTheDocument();
  expect(last.getByText("Needs a look")).toBeInTheDocument();
  // Only the request that was never sent is still ticked. The other two left the pending list.
  expect(screen.getByText("1 selected")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Select Third" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "Select First" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Select Second" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Approve 1" }));
  const names = within(screen.getByRole("list", { name: "Applications to approve" })).getAllByRole("listitem");
  expect(names.map((entry) => entry.textContent)).toEqual([`ThirdSteamID64 ${third.steamId}`]);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  fireEvent.click(last.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("region", { name: "Last bulk approval" })).not.toBeInTheDocument();
  expect(postCalls()).toHaveLength(2);
});

it("moves keyboard focus to the page heading when Clear or Dismiss removes itself", async () => {
  vi.useFakeTimers();
  const [first, second] = [named(1, "First"), named(2, "Second")];
  request.mockImplementation(async (_path, options) => {
    if (options?.method !== "POST") return { enabled: true, applications: [first, second] };
    throw Object.assign(new Error("This SteamID is already on the running whitelist."), { status: 409 });
  });
  render(
    <main id="main-content" tabIndex={-1}>
      <h1 tabIndex={-1}>Applications</h1>
      <Live />
    </main>,
  );
  await flush();
  const heading = screen.getByRole("heading", { name: "Applications" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending" }));
  const clear = screen.getByRole("button", { name: "Clear" });
  clear.focus();
  fireEvent.click(clear);
  expect(clear).not.toBeInTheDocument();
  expect(heading).toHaveFocus();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select First" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve 1" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve 1" }));
  await flush(FIRST_APPROVAL_GAP_MS);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
  await flush();
  const dismiss = within(screen.getByRole("region", { name: "Last bulk approval" })).getByRole("button", {
    name: "Dismiss",
  });
  dismiss.focus();
  expect(dismiss).toHaveFocus();
  fireEvent.click(dismiss);
  expect(dismiss).not.toBeInTheDocument();
  expect(heading).toHaveFocus();
  expect(postCalls()).toHaveLength(1);
});
