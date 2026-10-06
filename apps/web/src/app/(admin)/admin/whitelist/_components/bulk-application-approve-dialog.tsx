"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import type { AdminServer } from "~/lib/admin-servers";

import { sendApplicationReview, WhitelistMutationError } from "./whitelist-api";
import {
  APPLICATION_APPROVAL_REASON,
  reasonProblem,
  type WhitelistApplication,
  type WhitelistOverview,
} from "./whitelist-data";

type BulkItemState = "queued" | "sending" | "paused" | "approved" | "attention";
export type BulkApprovalItem = {
  id: string;
  name: string;
  steamId: string;
  requestId: string;
  state: BulkItemState;
  message: string;
};

const APPROVAL_SPACING_MS = 2_200;
const FIRST_APPROVAL_GAP_MS = 1_100;
const UNKNOWN_ALLOWANCE_SPACING_MS = 4_000;
const GAME_REQUESTS_PER_APPROVAL = 6;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 60_000;
const LONGEST_BUSY_WAIT_MS = 300_000;

function spacing(overview: WhitelistOverview | undefined) {
  const allowance = overview?.capabilities.limits?.maxRequestsPerMinutePerIp;
  return allowance
    ? Math.max(APPROVAL_SPACING_MS, Math.ceil((60_000 * GAME_REQUESTS_PER_APPROVAL) / (allowance / 2)))
    : UNKNOWN_ALLOWANCE_SPACING_MS;
}

function busyWait(error: unknown) {
  if (!(error instanceof WhitelistMutationError) || error.status !== 429) return null;
  const seconds = error.retryAfter;
  return Number.isFinite(seconds) ? Math.max(1_000, (seconds ?? 0) * 1_000) : BUSY_WAIT_MS;
}

export function bulkApprovalSummary(items: BulkApprovalItem[]) {
  const approved = items.filter((item) => item.state === "approved").length;
  const attention = items.filter((item) => item.state === "attention").length;
  const unsent = items.length - approved - attention;
  return (
    [
      approved + " approved",
      attention ? attention + " need" + (attention === 1 ? "s" : "") + " a look" : "",
      unsent ? unsent + " not sent" : "",
    ]
      .filter(Boolean)
      .join(". ") + "."
  );
}

export function bulkApprovalProblems(items: BulkApprovalItem[]) {
  return items.filter((item) => item.state === "attention" || item.message);
}

export function BulkApplicationApproveDialog({
  applications,
  overview,
  server,
  csrf,
  unavailable,
  onBusyChange,
  onClose,
  onComplete,
}: {
  applications: WhitelistApplication[];
  overview: WhitelistOverview | undefined;
  server: AdminServer;
  csrf: string;
  unavailable: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onComplete: (items: BulkApprovalItem[]) => void;
}) {
  const mounted = useRef(true);
  const submitted = useRef(false);
  const inFlight = useRef(false);
  const stopRequested = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  const openedAt = useRef(0);
  const [items, setItems] = useState<BulkApprovalItem[]>(() =>
    applications.map((application) => ({
      id: application.id,
      name: application.discordDisplayName,
      steamId: application.steamId,
      requestId: "",
      state: "queued",
      message: "",
    })),
  );
  const [reason, setReason] = useState(APPLICATION_APPROVAL_REASON);
  const [validation, setValidation] = useState("");
  const [phase, setPhase] = useState<"review" | "running" | "done">("review");
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    mounted.current = true;
    openedAt.current = Date.now();
    return () => {
      mounted.current = false;
      stopRequested.current = true;
      wake.current?.();
      if (inFlight.current) onBusyChange(false);
    };
  }, [onBusyChange]);

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

  async function submit() {
    if (submitted.current || unavailable || !items.length) return;
    const cleanedReason = reason.trim();
    const problem = reasonProblem(cleanedReason);
    if (problem) {
      setValidation(problem);
      return;
    }

    submitted.current = true;
    inFlight.current = true;
    setValidation("");
    setPhase("running");
    onBusyChange(true);

    const batch = items.map((item) => ({ ...item, requestId: crypto.randomUUID() }));
    const publish = () => {
      if (mounted.current) setItems(batch.map((item) => ({ ...item })));
    };
    const halted = () => stopRequested.current || !mounted.current;

    async function send(item: BulkApprovalItem) {
      for (let refusals = 0; ; refusals++) {
        item.state = "sending";
        item.message = "";
        publish();
        try {
          const response = await sendApplicationReview({
            server,
            csrf,
            application: { id: item.id },
            decision: "approve",
            reviewId: item.requestId,
            reason: cleanedReason,
          });
          if (response.application.id !== item.id || response.outcome.id !== item.requestId) {
            throw new Error("The review receipt did not match this request.");
          }
          const approved = response.application.status === "approved" && response.outcome.state === "applied";
          item.state = approved ? "approved" : "attention";
          item.message = approved ? "" : response.outcome.message || "The server did not confirm this approval.";
          return;
        } catch (error) {
          const wait = busyWait(error);
          if (wait === null) {
            item.state = "attention";
            item.message = error instanceof Error ? error.message : "The review result could not be confirmed.";
            return;
          }
          if (refusals === BUSY_RETRIES || wait > LONGEST_BUSY_WAIT_MS) {
            item.state = "queued";
            item.message = error instanceof Error ? error.message : "The server is still busy.";
            return;
          }
          if (!halted()) {
            item.state = "paused";
            item.message = "Server busy. Trying again in " + Math.ceil(wait / 1_000) + " seconds.";
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
    }

    try {
      const early = Math.min(FIRST_APPROVAL_GAP_MS, FIRST_APPROVAL_GAP_MS - (Date.now() - openedAt.current));
      if (early > 0) await pause(early);
      for (const [index, item] of batch.entries()) {
        if (halted()) break;
        if (index > 0) {
          await pause(spacing(overview));
          if (halted()) break;
        }
        await send(item);
        publish();
        if (item.state !== "approved") break;
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        onBusyChange(false);
        setPhase("done");
        onComplete(batch.map((item) => ({ ...item })));
      }
    }
  }

  const total = items.length;
  const approved = items.filter((item) => item.state === "approved").length;
  const attention = items.filter((item) => item.state === "attention").length;
  const unsent = items.filter((item) => item.state === "queued").length;
  const position = Math.min(approved + attention + 1, total);
  const active = items[position - 1];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && phase !== "running") onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => phase === "running" && event.preventDefault()}
        onPointerDownOutside={(event) => phase === "running" && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {phase === "done"
              ? attention || unsent
                ? "Approval stopped"
                : "All approved"
              : "Approve " + total + " applications"}
          </DialogTitle>
          <DialogDescription>
            {phase === "review"
              ? "Review the selected applications. Approvals are sent one at a time."
              : phase === "running"
                ? "Keep this dialog open until the batch stops or finishes."
                : "Only confirmed approvals are marked complete."}
          </DialogDescription>
        </DialogHeader>

        {phase === "review" ? (
          <>
            <ul
              className="max-h-[35vh] space-y-2 overflow-y-auto rounded-md border p-3"
              aria-label="Applications to approve"
            >
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0 last:pb-0"
                >
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">SteamID64 {item.steamId}</p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="space-y-2">
              <Label htmlFor="bulk-application-reason">Review reason</Label>
              <Textarea
                id="bulk-application-reason"
                value={reason}
                maxLength={200}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">Use 3–200 characters on one line.</p>
            </div>
          </>
        ) : null}

        {validation ? (
          <p role="alert" className="text-sm text-destructive">
            {validation}
          </p>
        ) : null}

        <div role="status" aria-live="polite">
          {phase === "running" && active ? (
            <p className="rounded-md border bg-muted/30 p-3 text-sm">
              Approving {position} of {total}: <strong>{active.name}</strong>.
              {active.state === "paused" ? " " + active.message : ""}
              {stopping ? " Stopping after this request." : ""}
            </p>
          ) : null}
          {phase === "done" ? (
            <>
              <p className="font-medium">{bulkApprovalSummary(items)}</p>
              {bulkApprovalProblems(items).length ? (
                <ul className="mt-3 space-y-2" aria-label="Applications that need attention">
                  {bulkApprovalProblems(items).map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">{item.name}</p>
                        <p className="font-mono text-xs break-all text-muted-foreground">{item.steamId}</p>
                        {item.message ? <p className="mt-1 text-sm text-muted-foreground">{item.message}</p> : null}
                        {item.state === "attention" ? (
                          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                            Review ID: {item.requestId}
                          </p>
                        ) : null}
                      </div>
                      <Badge variant={item.state === "attention" ? "destructive" : "secondary"}>
                        {item.state === "attention" ? "Needs a look" : "Not sent"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              {unsent ? (
                <p className="mt-2 text-sm text-muted-foreground">The applications not sent remain selected.</p>
              ) : null}
            </>
          ) : null}
        </div>

        <DialogFooter>
          {phase === "running" ? (
            unsent > 0 || items.some((item) => item.state === "paused") ? (
              <Button
                type="button"
                variant="outline"
                disabled={stopping}
                onClick={() => {
                  stopRequested.current = true;
                  setStopping(true);
                  wake.current?.();
                }}
              >
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            ) : null
          ) : phase === "review" ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" disabled={unavailable} onClick={() => void submit()}>
                Approve {total}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
