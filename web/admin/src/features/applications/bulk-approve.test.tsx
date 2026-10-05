import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Overview } from "../../api/types";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { pressEscape } from "../../test/dialog";
import { overview } from "../players/test-fixtures";
import {
  APPROVAL_SPACING_MS,
  BUSY_RETRIES,
  BUSY_WAIT_MS,
  BulkApproveDialog,
  FIRST_APPROVAL_GAP_MS,
  LONGEST_BUSY_WAIT_MS,
  UNKNOWN_ALLOWANCE_SPACING_MS,
  bulkSummary,
  type BulkApproveResult,
  type BulkItem,
} from "./bulk-approve";
import { approveReason } from "./review";
import type { ApplicationReviewResponse, WhitelistApplication } from "./types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function application(index: number): WhitelistApplication {
  return {
    id: `01234567-89ab-4cde-8fab-00000000000${index}`,
    discordUserId: `2345678901234567${index}`,
    discordDisplayName: `Applicant ${index}`,
    steamId: `7656119800000000${index}`,
    steamOwnershipVerified: false,
    relationship: "unc_member",
    email: null,
    emailVerified: false,
    contactConsent: false,
    consentVersion: "fixture-v1",
    contactConsentAt: null,
    rulesAcceptedAt: "2026-09-30T15:00:00Z",
    status: "pending",
    submittedAt: `2026-09-30T15:0${index}:00Z`,
    updatedAt: `2026-09-30T15:0${index}:00Z`,
    reviewedAt: null,
    reviewedBy: null,
    reviewReason: null,
    reviewKind: null,
    reviewId: null,
    actionId: null,
    lastActionState: null,
    lastActionMessage: null,
  };
}
const [one, two, three] = [1, 2, 3].map(application);
function context(overrides: Partial<AdminContextValue> = {}): AdminContextValue {
  return {
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
    ...overrides,
  };
}
function open(admin = context(), applications = [one, two, three], unavailable = false) {
  const finished = vi.fn<(result: BulkApproveResult) => void>();
  const onClose = vi.fn();
  const view = render(
    <AdminContext.Provider value={admin}>
      <BulkApproveDialog
        applications={applications}
        defaultReason={approveReason}
        unavailable={unavailable}
        onClose={onClose}
        onComplete={finished}
      />
    </AdminContext.Provider>,
  );
  return { admin, finished, onClose, ...view };
}
const sent = () => request.mock.calls.filter(([, options]) => options?.method === "POST");
const body = (index: number) => JSON.parse(String(sent()[index][1]?.body)) as { id: string; reason: string };
const target = (index: number) => sent()[index][0];
const approvePath = (record: WhitelistApplication) => `applications/${record.id}/approve`;
const progress = () => screen.getByRole("status", { name: "Approval progress" });
const states = (finished: { mock: { calls: [BulkApproveResult][] } }) =>
  finished.mock.calls[0][0].items.map((item) => item.state);
function submit() {
  fireEvent.submit(screen.getByRole("button", { name: /^Approve \d+$/ }).closest("form")!);
}
async function flush(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
/** Confirms the batch the moment the dialog opens, then waits out the gap before its first approval. */
async function start() {
  submit();
  await flush(FIRST_APPROVAL_GAP_MS);
}
/** Lets a held request answer, then lets the batch react to it. */
async function settle(release: () => void) {
  await act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
}
/** The server's answer to one approval. By default the game confirmed it. */
function answer(
  path: string,
  options: RequestInit | undefined,
  status: WhitelistApplication["status"] = "approved",
  state: ApplicationReviewResponse["outcome"]["state"] = "applied",
  message = "Whitelist access is active in the running game.",
): ApplicationReviewResponse {
  const record = [one, two, three].find((entry) => path === approvePath(entry))!;
  return {
    application: { ...record, status },
    outcome: { id: (JSON.parse(String(options?.body)) as { id: string }).id, state, message },
  };
}
/** What the API client throws for a 429, with the wait the server named, if it named one. */
function busy(retryAfter?: number) {
  return Object.assign(new Error("Too many dashboard requests. Wait a minute before trying again."), {
    status: 429,
    retryAfter,
  });
}

beforeEach(() => {
  request.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("approving several applications", () => {
  it("lists who will be approved with the usual reason filled in, and sends nothing until confirmed", () => {
    open();
    expect(screen.getByRole("heading", { name: "Approve 3 applications" })).toBeInTheDocument();
    const names = within(screen.getByRole("list", { name: "Applications to approve" })).getAllByRole("listitem");
    expect(names.map((entry) => entry.textContent)).toEqual(
      [one, two, three].map((record) => `${record.discordDisplayName}SteamID64 ${record.steamId}`),
    );
    expect(screen.getByLabelText("Reason")).toHaveValue("Website whitelist application reviewed and approved.");
    // The live region is there before it has anything to say.
    expect(progress()).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(request).not.toHaveBeenCalled();
  });

  it("makes the list of names a keyboard stop only while it scrolls", () => {
    const list = () => screen.getByRole("list", { name: "Applications to approve" });
    // Five names are taller than the list's box, and names that wrap on a phone get there with fewer.
    const height = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(335);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(299);
    open(context(), [one, two]);
    expect(list()).toHaveAttribute("tabindex", "0");
    height.mockReturnValue(299);
    fireEvent(window, new Event("resize"));
    expect(list()).not.toHaveAttribute("tabindex");
    height.mockReturnValue(300);
    fireEvent(window, new Event("resize"));
    expect(list()).toHaveAttribute("tabindex", "0");
  });

  it("approves one at a time in the listed order, each with its own review ID and the shared reason", async () => {
    const answers: (() => void)[] = [];
    request.mockImplementation(
      (path, options) => new Promise((resolve) => answers.push(() => resolve(answer(path, options)))),
    );
    const { admin, finished } = open();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  Checked in Discord.  " } });
    await start();
    expect(sent()).toHaveLength(1);
    expect(admin.setBusy).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("heading", { name: "Approving 3 applications" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("Approving 1 of 3: Applicant 1.");
    // Nothing else is sent while the first has no answer, however long it takes.
    await flush(120_000);
    expect(sent()).toHaveLength(1);
    await settle(answers[0]);
    expect(progress()).toHaveTextContent("Approving 2 of 3: Applicant 2.");
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS - 1);
    expect(sent()).toHaveLength(1);
    await flush(1);
    expect(sent()).toHaveLength(2);
    await settle(answers[1]);
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS);
    expect(sent()).toHaveLength(3);
    expect(progress()).toHaveTextContent("Approving 3 of 3: Applicant 3.");
    expect(finished).not.toHaveBeenCalled();
    await settle(answers[2]);
    expect(sent().map(([path]) => path)).toEqual([one, two, three].map(approvePath));
    const ids = [0, 1, 2].map((index) => body(index).id);
    for (const id of ids) expect(id).toMatch(uuid);
    expect(new Set(ids).size).toBe(3);
    expect([0, 1, 2].map((index) => body(index).reason)).toEqual(Array(3).fill("Checked in Discord."));
    expect(Object.keys(body(0)).sort()).toEqual(["id", "reason"]);
    expect(screen.getByRole("heading", { name: "All approved" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("3 approved.");
    expect(screen.queryByRole("list", { name: "Applications to check" })).not.toBeInTheDocument();
    expect(admin.setBusy).toHaveBeenLastCalledWith(false);
    expect(finished).toHaveBeenCalledOnce();
    expect(states(finished)).toEqual(["approved", "approved", "approved"]);
    expect(finished.mock.calls[0][0].items.map((item) => item.requestId)).toEqual(ids);
    await flush(600_000);
    expect(sent()).toHaveLength(3);
  });

  it.each<[string, Overview["capabilities"]["limits"] | null, number]>([
    ["has not been read", null, UNKNOWN_ALLOWANCE_SPACING_MS],
    ["names no allowance", {}, UNKNOWN_ALLOWANCE_SPACING_MS],
    ["allows 120 requests a minute", { maxRequestsPerMinutePerIp: 120 }, 6_000],
    ["allows 60 requests a minute", { maxRequestsPerMinutePerIp: 60 }, 12_000],
    ["allows far more than a batch needs", { maxRequestsPerMinutePerIp: 6_000 }, APPROVAL_SPACING_MS],
  ])("paces approvals when the game %s", async (_name, limits, wait) => {
    request.mockImplementation(async (path, options) => answer(path, options));
    const live = overview();
    if (limits) live.capabilities.limits = limits;
    const admin = context({ overview: limits === null ? null : live });
    open(admin);
    // The Applications page does not read the game, so the dialog asks for the read that carries the allowance.
    expect(admin.watchRoster).toHaveBeenCalledOnce();
    await start();
    await flush(wait - 1);
    expect(sent()).toHaveLength(1);
    await flush(1);
    expect(sent()).toHaveLength(2);
    await flush(wait - 1);
    expect(sent()).toHaveLength(2);
    await flush(1);
    expect(sent()).toHaveLength(3);
    // Even the fastest pace stays under the server's 30 changes a minute for each person.
    expect(60_000 / wait).toBeLessThan(30);
  });

  it("waits as long as a 429 asks, then sends the same approval again and carries on", async () => {
    let refuse = true;
    request.mockImplementation(async (path, options) => {
      if (path === approvePath(two) && refuse) {
        refuse = false;
        throw busy(7);
      }
      return answer(path, options);
    });
    const { finished } = open();
    await start();
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS);
    expect(sent()).toHaveLength(2);
    expect(progress()).toHaveTextContent("Approving 2 of 3: Applicant 2. Server busy. Trying again in 7 seconds.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    await flush(6_999);
    expect(sent()).toHaveLength(2);
    await flush(1);
    expect(sent()).toHaveLength(3);
    expect(target(2)).toBe(approvePath(two));
    expect(body(2)).toEqual(body(1));
    expect(progress()).toHaveTextContent("Approving 3 of 3: Applicant 3.");
    expect(progress()).not.toHaveTextContent("Server busy");
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS);
    expect(sent().map(([path]) => path)).toEqual([one, two, two, three].map(approvePath));
    expect(states(finished)).toEqual(["approved", "approved", "approved"]);
    expect(progress()).toHaveTextContent("3 approved.");
  });

  it("waits a minute after a 429 that names no time", async () => {
    let refuse = true;
    request.mockImplementation(async (path, options) => {
      if (refuse) {
        refuse = false;
        throw busy();
      }
      return answer(path, options);
    });
    open();
    await start();
    expect(progress()).toHaveTextContent("Approving 1 of 3: Applicant 1. Server busy. Trying again in 60 seconds.");
    await flush(BUSY_WAIT_MS - 1);
    expect(sent()).toHaveLength(1);
    await flush(1);
    expect(sent()).toHaveLength(2);
    expect(body(1)).toEqual(body(0));
  });

  it("stops after one approval is refused as busy too often, and leaves it selected with the server's words", async () => {
    request.mockImplementation(async (path, options) => {
      if (path === approvePath(two)) throw busy(5);
      return answer(path, options);
    });
    const { finished } = open();
    await start();
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS);
    for (let retry = 0; retry < BUSY_RETRIES; retry++) await flush(5_000);
    expect(sent().map(([path]) => path)).toEqual([one, ...Array(BUSY_RETRIES + 1).fill(two)].map(approvePath));
    expect(new Set(sent().map((_, index) => body(index).id)).size).toBe(2);
    expect(screen.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("1 approved. 2 not sent.");
    const check = within(screen.getByRole("list", { name: "Applications to check" }));
    expect(check.getAllByRole("listitem")).toHaveLength(1);
    expect(check.getByText("Applicant 2")).toBeInTheDocument();
    expect(check.getByText("Too many dashboard requests. Wait a minute before trying again.")).toBeInTheDocument();
    expect(check.getByText("Not sent")).toBeInTheDocument();
    expect(screen.getByText("The rest are still selected.")).toBeInTheDocument();
    expect(states(finished)).toEqual(["approved", "queued", "queued"]);
    await flush(600_000);
    expect(sent()).toHaveLength(BUSY_RETRIES + 2);
  });

  it("does not sit through a wait longer than five minutes", async () => {
    request.mockImplementation(async () => {
      throw busy(LONGEST_BUSY_WAIT_MS / 1000 + 1);
    });
    const { finished } = open();
    await start();
    expect(screen.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("0 approved. 3 not sent.");
    expect(states(finished)).toEqual(["queued", "queued", "queued"]);
    await flush(3_600_000);
    expect(sent()).toHaveLength(1);
  });

  it("stops in the pause between approvals without sending another", async () => {
    request.mockImplementation(async (path, options) => answer(path, options));
    const { admin, finished } = open();
    await start();
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS - 1);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("1 approved. 2 not sent.");
    expect(screen.getByText("The rest are still selected.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Applications to check" })).not.toBeInTheDocument();
    expect(states(finished)).toEqual(["approved", "queued", "queued"]);
    expect(admin.setBusy).toHaveBeenLastCalledWith(false);
    await flush(600_000);
    expect(sent()).toHaveLength(1);
  });

  it.each<[string, WhitelistApplication["status"], ApplicationReviewResponse["outcome"]["state"], string, string]>([
    ["a confirmed approval", "approved", "applied", "1 approved. 2 not sent.", "approved"],
    ["an unconfirmed one", "needs_review", "accepted", "0 approved. 1 needs a look. 2 not sent.", "attention"],
  ])(
    "lets a request already sent finish as %s when stopped, and sends nothing after it",
    async (_name, status, state, summary, result) => {
      let finish!: () => void;
      request.mockImplementation(
        (path, options) =>
          new Promise((resolve) => {
            finish = () => resolve(answer(path, options, status, state, "The game answered."));
          }),
      );
      const { finished } = open();
      await start();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
      expect(progress()).toHaveTextContent("Approving 1 of 3: Applicant 1. Stopping after this one.");
      // Stop never cancels a request that was already sent.
      expect(sent()[0][1]?.signal).toBeUndefined();
      expect(finished).not.toHaveBeenCalled();
      await settle(finish);
      expect(screen.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
      expect(progress()).toHaveTextContent(summary);
      expect(states(finished)).toEqual([result, "queued", "queued"]);
      await flush(600_000);
      expect(sent()).toHaveLength(1);
    },
  );

  it("leaves an approval that was waiting out a 429 unsent when stopped", async () => {
    request.mockImplementation(async () => {
      throw busy(30);
    });
    const { finished } = open();
    await start();
    expect(progress()).toHaveTextContent("Trying again in 30 seconds.");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    expect(progress()).toHaveTextContent("0 approved. 3 not sent.");
    expect(screen.queryByRole("list", { name: "Applications to check" })).not.toBeInTheDocument();
    expect(states(finished)).toEqual(["queued", "queued", "queued"]);
    await flush(600_000);
    expect(sent()).toHaveLength(1);
  });

  it("stops at once when a request that was out when Stop was pressed comes back as a 429", async () => {
    let refuse!: () => void;
    request.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(busy());
        }),
    );
    const { admin, finished } = open();
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    // Stop had no wait to end when it was pressed, so the 429 must not start one.
    await settle(refuse);
    expect(screen.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("0 approved. 3 not sent.");
    expect(progress()).not.toHaveTextContent("Server busy");
    expect(screen.queryByRole("list", { name: "Applications to check" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(states(finished)).toEqual(["queued", "queued", "queued"]);
    expect(admin.setBusy).toHaveBeenLastCalledWith(false);
    await flush(600_000);
    expect(sent()).toHaveLength(1);
  });

  it("offers no Stop once the last approval has been sent", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    open(context(), [one]);
    expect(screen.getByRole("heading", { name: "Approve 1 application" })).toBeInTheDocument();
    await start();
    expect(progress()).toHaveTextContent("Approving 1 of 1: Applicant 1.");
    for (const name of ["Stop", "Close", "Cancel"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
  });

  it.each<[string, (path: string, options?: RequestInit) => ApplicationReviewResponse, string]>([
    [
      "the game only accepted it",
      (path, options) => answer(path, options, "needs_review", "accepted", "Accepted; confirmation pending."),
      "Accepted; confirmation pending.",
    ],
    [
      "the game left it pending",
      (path, options) => answer(path, options, "approved", "pending", "Saved, but not running yet."),
      "Saved, but not running yet.",
    ],
    [
      "the application was not marked approved",
      (path, options) => answer(path, options, "needs_review", "applied", "The result could not be saved."),
      "The result could not be saved.",
    ],
    [
      "the server gave no message",
      (path, options) => answer(path, options, "needs_review", "unknown", ""),
      "The server did not confirm this approval.",
    ],
    [
      "the receipt is for another review",
      (path, options) => ({ ...answer(path, options), outcome: { id: "someone-else", state: "applied", message: "" } }),
      "The review receipt did not match this request.",
    ],
    [
      "the receipt is for another application",
      (path, options) => ({ ...answer(path, options), application: { ...three, status: "approved" } }),
      "The review receipt did not match this request.",
    ],
    [
      "the connection ended first",
      () => {
        throw Object.assign(new Error("The connection ended before confirmation. Check Action history."), {
          status: 0,
        });
      },
      "The connection ended before confirmation. Check Action history.",
    ],
    [
      "the server refused it",
      () => {
        throw Object.assign(new Error("This SteamID is already on the running whitelist."), { status: 409 });
      },
      "This SteamID is already on the running whitelist.",
    ],
  ])("never shows an approval as approved when %s, and sends nothing after it", async (_name, second, message) => {
    request.mockImplementation(async (path, options) =>
      path === approvePath(two) ? second(path, options) : answer(path, options),
    );
    const { finished } = open();
    await start();
    await flush(UNKNOWN_ALLOWANCE_SPACING_MS);
    expect(screen.getByRole("heading", { name: "Approval stopped" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "All approved" })).not.toBeInTheDocument();
    expect(progress()).toHaveTextContent("1 approved. 1 needs a look. 1 not sent.");
    const check = within(screen.getByRole("list", { name: "Applications to check" }));
    expect(check.getAllByRole("listitem")).toHaveLength(1);
    expect(check.getByText("Applicant 2")).toBeInTheDocument();
    expect(check.getByText(`SteamID64 ${two.steamId}`)).toBeInTheDocument();
    expect(check.getByText(message)).toBeInTheDocument();
    expect(check.getByText("Needs a look")).toBeInTheDocument();
    expect(check.getByText(`Review ID: ${body(1).id}`)).toBeInTheDocument();
    expect(states(finished)).toEqual(["approved", "attention", "queued"]);
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    await flush(600_000);
    expect(sent().map(([path]) => path)).toEqual([one, two].map(approvePath));
  });

  it("never sends twice on a double submission, and checks the reason first", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    open();
    const form = screen.getByRole("button", { name: "Approve 3" }).closest("form")!;
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "ok" } });
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a single-line review reason");
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewed together." } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await flush(FIRST_APPROVAL_GAP_MS);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sent()).toHaveLength(1);
  });

  it("holds the first approval until the dialog has been open for the server's one-second gap", async () => {
    request.mockImplementation(async (path, options) => answer(path, options));
    open();
    submit();
    await flush(FIRST_APPROVAL_GAP_MS - 1);
    expect(sent()).toHaveLength(0);
    expect(progress()).toHaveTextContent("Approving 1 of 3: Applicant 1.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    await flush(1);
    expect(sent()).toHaveLength(1);
    expect(FIRST_APPROVAL_GAP_MS).toBeGreaterThan(1_000);
  });

  it("sends the first approval at once when the dialog has been open a while", async () => {
    request.mockImplementation(async (path, options) => answer(path, options));
    open();
    await flush(FIRST_APPROVAL_GAP_MS);
    submit();
    await flush();
    expect(sent()).toHaveLength(1);
  });

  it("sends nothing when stopped before the first approval", async () => {
    request.mockImplementation(async (path, options) => answer(path, options));
    const { finished } = open();
    submit();
    await flush(FIRST_APPROVAL_GAP_MS - 1);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush(600_000);
    expect(sent()).toHaveLength(0);
    expect(progress()).toHaveTextContent("0 approved. 3 not sent.");
    expect(states(finished)).toEqual(["queued", "queued", "queued"]);
  });

  it.each([
    ["the list is being read again", context(), true],
    ["another action is running", context({ busy: true }), false],
  ])("does not start while %s", (_name, admin, unavailable) => {
    open(admin, [one, two], unavailable);
    expect(screen.getByRole("button", { name: "Approve 2" })).toBeDisabled();
    submit();
    expect(request).not.toHaveBeenCalled();
    expect(admin.setBusy).not.toHaveBeenCalled();
  });

  it("keeps a running batch and its Stop button on screen when Escape is pressed", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    const { onClose } = open();
    await start();
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    expect(dialog).toHaveAttribute("closedby", "none");
    pressEscape(dialog);
    pressEscape(dialog, { cancelable: false });
    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("moves keyboard focus to Stop while it runs and to Close when it ends", async () => {
    request.mockImplementation(async (path, options) => answer(path, options));
    const { onClose } = open();
    await start();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends nothing more once its dialog is gone, and releases the dashboard", async () => {
    request.mockImplementation(async (path, options) => answer(path, options));
    const { admin, finished, unmount } = open();
    await start();
    expect(sent()).toHaveLength(1);
    unmount();
    expect(admin.setBusy).toHaveBeenLastCalledWith(false);
    await flush(600_000);
    expect(sent()).toHaveLength(1);
    expect(finished).not.toHaveBeenCalled();
  });

  it("ignores an answer that arrives after its dialog is gone", async () => {
    let finish!: () => void;
    request.mockImplementation(
      (path, options) =>
        new Promise((resolve) => {
          finish = () => resolve(answer(path, options));
        }),
    );
    const { admin, finished, unmount } = open();
    await start();
    unmount();
    expect(admin.setBusy).toHaveBeenLastCalledWith(false);
    const calls = vi.mocked(admin.setBusy).mock.calls.length;
    await settle(finish);
    await flush(600_000);
    expect(sent()).toHaveLength(1);
    expect(finished).not.toHaveBeenCalled();
    expect(admin.setBusy).toHaveBeenCalledTimes(calls);
  });
});

describe("the plain summary", () => {
  const item = (state: BulkItem["state"]): BulkItem => ({
    id: state,
    name: state,
    steamId: "76561198000000001",
    requestId: "",
    state,
    message: "",
  });
  it.each<[BulkItem["state"][], string]>([
    [["approved", "approved"], "2 approved."],
    [["approved"], "1 approved."],
    [["approved", "attention", "queued", "queued"], "1 approved. 1 needs a look. 2 not sent."],
    [["attention", "attention"], "0 approved. 2 need a look."],
    [["queued"], "0 approved. 1 not sent."],
    // An approval still in flight or waiting has no confirmed result, so it is never counted as approved.
    [["approved", "sending", "paused"], "1 approved. 2 not sent."],
  ])("reads %j as %s", (itemStates, text) => {
    expect(bulkSummary(itemStates.map(item))).toBe(text);
  });
});
