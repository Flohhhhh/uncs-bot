import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useGameApi } from "../../api/server-client";
import type { Overview } from "../../api/types";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Modal, ReasonField } from "../../components/ui";
import { errorMessage } from "../actions/policy";
import { reasonProblem } from "./review";
import type { ApplicationReviewResponse, WhitelistApplication } from "./types";

/**
 * "approved" is a confirmed approval. "attention" is any other answer. "queued" was never sent, or the
 * server refused it as too busy before reading it. "paused" is waiting to be sent again after that refusal.
 */
export type BulkItemState = "queued" | "sending" | "paused" | "approved" | "attention";
export type BulkItem = {
  /** The application's ID. */
  id: string;
  name: string;
  steamId: string;
  /** This approval's own review ID. It is sent again only after the server refused the request as too busy. */
  requestId: string;
  state: BulkItemState;
  /** The server's words for anything that is not a confirmed approval. */
  message: string;
};
export type BulkApproveResult = { items: BulkItem[] };

/**
 * The shortest pause between two approvals. The server refuses a second game action from the same person
 * within one second, and it does so after claiming the application, which leaves that application needing
 * review. This stays well clear of it, and keeps a batch under the server's 30 changes a minute for each person.
 */
export const APPROVAL_SPACING_MS = 2_200;
/**
 * The first approval waits until the dialog has been open this long. Any review this page sent before the
 * dialog opened has then had the server's one-second gap too.
 */
export const FIRST_APPROVAL_GAP_MS = 1_100;
/** The pause while the game has not said how many requests it allows. */
export const UNKNOWN_ALLOWANCE_SPACING_MS = 4_000;
/**
 * The most game requests one approval makes: it reads the whitelist and its saved copy, makes the change
 * (three requests when the game only takes an edit of its saved configuration) and reads the whitelist again.
 */
const GAME_REQUESTS_PER_APPROVAL = 6;
/** How often one approval is sent again after the server answers 429, which it does before reading the request. */
export const BUSY_RETRIES = 3;
/** The wait after a 429 that names no time. The server's own limits all clear within a minute. */
export const BUSY_WAIT_MS = 60_000;
/** A batch does not sit through a longer wait than this. It stops and leaves the rest selected. */
export const LONGEST_BUSY_WAIT_MS = 300_000;

/**
 * The pause before the next approval. When the game says how many requests it allows, a batch keeps to
 * half of that and leaves the rest for the staff-alerts and community workers that share it.
 */
function spacing(overview: Overview | null) {
  const allowance = overview?.capabilities.limits?.maxRequestsPerMinutePerIp;
  return allowance
    ? Math.max(APPROVAL_SPACING_MS, Math.ceil((60_000 * GAME_REQUESTS_PER_APPROVAL) / (allowance / 2)))
    : UNKNOWN_ALLOWANCE_SPACING_MS;
}

/** How long the server asked to wait with a 429, or null for any other failure. */
function busyWait(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 429) return null;
  const seconds = "retryAfter" in error && typeof error.retryAfter === "number" ? error.retryAfter : NaN;
  return Number.isFinite(seconds) ? Math.max(1_000, seconds * 1000) : BUSY_WAIT_MS;
}

export function bulkCounts(items: BulkItem[]) {
  const approved = items.filter((item) => item.state === "approved").length;
  const attention = items.filter((item) => item.state === "attention").length;
  return { approved, attention, unsent: items.length - approved - attention };
}

/** "3 approved. 1 needs a look. 4 not sent." Only a confirmed approval counts as approved. */
export function bulkSummary(items: BulkItem[]) {
  const { approved, attention, unsent } = bulkCounts(items);
  return `${[
    `${approved} approved`,
    attention ? `${attention} need${attention === 1 ? "s" : ""} a look` : "",
    unsent ? `${unsent} not sent` : "",
  ]
    .filter(Boolean)
    .join(". ")}.`;
}

/** The applications staff still have to look at, each with what the server said. */
export function bulkProblems(items: BulkItem[]) {
  return items.filter((item) => item.state === "attention" || item.message);
}

export function BulkProblems({ items }: { items: BulkItem[] }) {
  if (!items.length) return null;
  return (
    <ul className="team-review-players bulk-approve-list" aria-label="Applications to check">
      {items.map((item) => (
        <li key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <small>SteamID64 {item.steamId}</small>
            {item.message && <p>{item.message}</p>}
            {item.state === "attention" && <small>Review ID: {item.requestId}</small>}
          </div>
          <span>
            <Badge kind={item.state === "attention" ? "warn" : "neutral"}>
              {item.state === "attention" ? "Needs a look" : "Not sent"}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Approves the listed applications one at a time through the single-approval request, in the listed order.
 * It stops at the first answer that is not a confirmed approval, and everything after that is never sent.
 *
 * The open dialog pauses the dashboard's 20-second refresh and blocks leaving the page, as every review
 * does. The batch also keeps its own copy of the list, so a refresh of the page behind it cannot reorder,
 * restart or repeat it.
 */
export function BulkApproveDialog({
  applications,
  defaultReason,
  unavailable,
  onClose,
  onComplete,
}: {
  applications: WhitelistApplication[];
  defaultReason: string;
  unavailable: boolean;
  onClose: () => void;
  onComplete: (result: BulkApproveResult) => void;
}) {
  const admin = useAdmin();
  const api = useGameApi();
  const current = useRef(admin);
  current.current = admin;
  const mounted = useRef(true);
  const submitted = useRef(false);
  const inFlight = useRef(false);
  const stopRequested = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  const opened = useRef(0);
  const stopButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const reviewList = useRef<HTMLUListElement>(null);
  const [listScrolls, setListScrolls] = useState(false);
  const [phase, setPhase] = useState<"review" | "running" | "done">("review");
  const [stopping, setStopping] = useState(false);
  const [validation, setValidation] = useState("");
  // The list is fixed when the dialog opens.
  const [items, setItems] = useState<BulkItem[]>(() =>
    applications.map((application) => ({
      id: application.id,
      name: application.discordDisplayName,
      steamId: application.steamId,
      requestId: "",
      state: "queued",
      message: "",
    })),
  );
  const { watchRoster, setBusy } = admin;
  // The Applications page does not read the game, and the pause between approvals depends on its allowance.
  useEffect(() => watchRoster(), [watchRoster]);
  useEffect(() => {
    mounted.current = true;
    opened.current = Date.now();
    return () => {
      mounted.current = false;
      wake.current?.();
      if (inFlight.current) setBusy(false);
    };
  }, [setBusy]);
  useLayoutEffect(() => {
    // A list taller than its box scrolls inside the dialog, so the keyboard has to be able to reach it. Long
    // names wrap on a phone, so this measures the list instead of counting names. The dialog is open by now.
    const measure = () => {
      const list = reviewList.current;
      if (list) setListScrolls(list.scrollHeight > list.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  useEffect(() => {
    // The button that started the batch is gone by now, so focus moves to the one that replaced it.
    if (phase === "running") stopButton.current?.focus();
    if (phase === "done") closeButton.current?.focus();
  }, [phase]);

  /** Waits, unless Stop or leaving the page ends the wait early. */
  function pause(milliseconds: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        wake.current = null;
        resolve();
      };
      const timer = window.setTimeout(done, milliseconds);
      wake.current = done;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || admin.busy || unavailable || !items.length) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    const problem = reasonProblem(reason);
    if (problem) {
      setValidation(problem);
      return;
    }
    submitted.current = true;
    inFlight.current = true;
    setValidation("");
    setPhase("running");
    setBusy(true);
    const batch = items.map((item) => ({ ...item, requestId: crypto.randomUUID() }));
    const publish = () => {
      if (mounted.current) setItems(batch.map((item) => ({ ...item })));
    };
    const halted = () => stopRequested.current || !mounted.current;
    /** Sends one approval and leaves its final state on the item. Only a 429 is ever sent again. */
    const send = async (item: BulkItem) => {
      for (let refusals = 0; ; refusals++) {
        item.state = "sending";
        item.message = "";
        publish();
        try {
          const response = await api<ApplicationReviewResponse>(`applications/${encodeURIComponent(item.id)}/approve`, {
            method: "POST",
            body: JSON.stringify({ id: item.requestId, reason }),
          });
          if (response.application?.id !== item.id || response.outcome?.id !== item.requestId)
            throw new Error("The review receipt did not match this request.");
          const approved = response.application.status === "approved" && response.outcome.state === "applied";
          item.state = approved ? "approved" : "attention";
          item.message = approved ? "" : response.outcome.message || "The server did not confirm this approval.";
          return;
        } catch (error) {
          const wait = busyWait(error);
          if (wait === null) {
            item.state = "attention";
            item.message = errorMessage(error);
            return;
          }
          // The server answers 429 before it reads the request, so nothing was approved. It keeps the same
          // review ID when it goes again, and it stays selected with the server's words when it cannot.
          if (refusals === BUSY_RETRIES || wait > LONGEST_BUSY_WAIT_MS) {
            item.state = "queued";
            item.message = errorMessage(error);
            return;
          }
          // Stop, or a closed dialog, while this request was out found no wait to end. So none starts now.
          if (!halted()) {
            const seconds = Math.ceil(wait / 1000);
            item.state = "paused";
            item.message = `Server busy. Trying again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
            publish();
            await pause(wait);
          }
          if (halted()) {
            item.state = "queued";
            item.message = "";
            return;
          }
        }
      }
    };
    try {
      // A clock that moved back while the dialog was open never makes this wait longer than the gap itself.
      const early = Math.min(FIRST_APPROVAL_GAP_MS, FIRST_APPROVAL_GAP_MS - (Date.now() - opened.current));
      if (early > 0) await pause(early);
      for (const [index, item] of batch.entries()) {
        if (halted()) break;
        if (index > 0) {
          await pause(spacing(current.current.overview));
          if (halted()) break;
        }
        await send(item);
        publish();
        if (item.state !== "approved") break;
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        setPhase("done");
        onComplete({ items: batch.map((item) => ({ ...item })) });
      }
    }
  }

  const total = items.length;
  const { approved, attention, unsent } = bulkCounts(items);
  const noun = `${total} application${total === 1 ? "" : "s"}`;
  // Approvals run in order, so the one in flight or next is the first that has no answer yet.
  const position = Math.min(approved + attention + 1, total);
  const active = items[position - 1];
  return (
    <Modal
      serverScoped
      className="application-dialog"
      title={
        phase === "done"
          ? attention || unsent
            ? "Approval stopped"
            : "All approved"
          : `${phase === "running" ? "Approving" : "Approve"} ${noun}`
      }
      description={
        phase === "review"
          ? "Check the names, then approve with one reason."
          : phase === "running"
            ? "Keep this page open until it finishes."
            : undefined
      }
      busy={phase === "running"}
      onClose={onClose}
      eyebrow={phase === "done" ? null : undefined}
    >
      <form onSubmit={(event) => void submit(event)}>
        {phase === "review" && (
          <>
            <ul
              ref={reviewList}
              className="team-review-players bulk-approve-list"
              aria-label="Applications to approve"
              tabIndex={listScrolls ? 0 : undefined}
            >
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>SteamID64 {item.steamId}</small>
                  </div>
                </li>
              ))}
            </ul>
            <fieldset className="review-fields">
              <ReasonField defaultValue={defaultReason} />
            </fieldset>
          </>
        )}
        {validation && (
          <p className="notice warning" role="alert">
            {validation}
          </p>
        )}
        {/* The region is in the dialog before it has anything to say, so screen readers announce each change. */}
        <div role="status" aria-label="Approval progress">
          {phase === "running" && (
            <p className="team-progress">
              Approving {position} of {total}: <strong>{active.name}</strong>.
              {active.state === "paused" && ` ${active.message}`}
              {stopping && " Stopping after this one."}
            </p>
          )}
          {phase === "done" && <p className="team-progress">{bulkSummary(items)}</p>}
        </div>
        {phase === "done" && (
          <>
            <BulkProblems items={bulkProblems(items)} />
            {unsent > 0 && <p className="muted">The rest are still selected.</p>}
          </>
        )}
        <div className="dialog-footer">
          {phase === "running" ? (
            // Nothing is left to stop once the last approval has been sent.
            items.some((item) => item.state === "queued" || item.state === "paused") && (
              <button
                ref={stopButton}
                type="button"
                className="button secondary"
                disabled={stopping}
                onClick={() => {
                  stopRequested.current = true;
                  setStopping(true);
                  wake.current?.();
                }}
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
            )
          ) : (
            <button ref={closeButton} type="button" className="button secondary" onClick={onClose}>
              {phase === "done" ? "Close" : "Cancel"}
            </button>
          )}
          {phase === "review" && (
            <button type="submit" className="button primary" disabled={admin.busy || unavailable}>
              Approve {total}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
