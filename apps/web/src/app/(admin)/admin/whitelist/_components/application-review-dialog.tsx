"use client";

import { useState, type FormEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
  applicationRelationships,
  applicationStatuses,
  APPLICATION_APPROVAL_REASON,
  reasonProblem,
  type ApplicationDecision,
  type WhitelistApplication,
} from "./whitelist-data";

type ReviewResult = {
  title: string;
  description: string;
  complete: boolean;
  state: string;
  reviewId: string;
};

const decisionCopy: Record<
  ApplicationDecision,
  { title: string; description: string; submit: string; confirmation: string; defaultReason: string }
> = {
  approve: {
    title: "Approve whitelist access",
    description:
      "Review the applicant’s Discord account and requested SteamID. Approval adds this SteamID to the existing whitelist.",
    submit: "Approve this SteamID",
    confirmation: "Grant whitelist access to",
    defaultReason: APPLICATION_APPROVAL_REASON,
  },
  decline: {
    title: "Decline application",
    description: "Record why this application is declined. This does not remove existing whitelist access.",
    submit: "Confirm decline",
    confirmation: "Decline the application from",
    defaultReason: "",
  },
  recheck: {
    title: "Recheck live whitelist",
    description:
      "Read the running whitelist to check whether this SteamID already has access. This does not add, remove, or resend anything to the game.",
    submit: "Check running whitelist",
    confirmation: "Recheck whitelist access for",
    defaultReason: "Recheck the existing application against the running whitelist.",
  },
};

function canReview(application: WhitelistApplication, decision: ApplicationDecision) {
  return decision === "recheck"
    ? ["processing", "needs_review"].includes(application.status)
    : application.status === "pending";
}

export function ApplicationReviewDialog({
  application: initialApplication,
  server,
  csrf,
  unavailable,
  onClose,
  onReviewed,
}: {
  application: WhitelistApplication;
  server: AdminServer;
  csrf: string;
  unavailable: boolean;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const [application, setApplication] = useState(initialApplication);
  const [decision, setDecision] = useState<ApplicationDecision | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState("");
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [sending, setSending] = useState(false);

  function choose(nextDecision: ApplicationDecision) {
    if (unavailable || sending || result || !canReview(application, nextDecision)) return;
    setDecision(nextDecision);
    setReviewId(crypto.randomUUID());
    setReason(decisionCopy[nextDecision].defaultReason);
    setValidation("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decision || !reviewId || unavailable || sending || result || !canReview(application, decision)) return;
    const problem = reasonProblem(reason.trim());
    if (problem) {
      setValidation(problem);
      return;
    }

    setSending(true);
    setValidation("");
    try {
      const response = await sendApplicationReview({
        server,
        csrf,
        application,
        decision,
        reviewId,
        reason: reason.trim(),
      });
      if (response.application.id !== application.id || response.outcome.id !== reviewId) {
        throw new Error("The review receipt did not match this request.");
      }

      const approved =
        ["approve", "recheck"].includes(decision) &&
        response.application.status === "approved" &&
        response.outcome.state === "applied";
      const declined =
        decision === "decline" && response.application.status === "declined" && response.outcome.state === "applied";
      setApplication(response.application);
      setResult({
        title: approved ? "Whitelist access confirmed" : declined ? "Application declined" : "Application needs review",
        description:
          approved || declined
            ? response.outcome.message
            : "The result was not confirmed. Check the refreshed application and Action history before trying again.",
        complete: approved || declined,
        state: response.outcome.state,
        reviewId,
      });
    } catch (error) {
      setResult({
        title: "Review result not confirmed",
        description: "Refresh this application and check Action history before repeating the request.",
        complete: false,
        state: error instanceof WhitelistMutationError ? error.state : "unknown",
        reviewId,
      });
    } finally {
      setSending(false);
      onReviewed();
    }
  }

  const selected = decision ? decisionCopy[decision] : null;
  const allowRecheck = canReview(application, "recheck");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => sending && event.preventDefault()}
        onPointerDownOutside={(event) => sending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{result?.title ?? selected?.title ?? "Whitelist application"}</DialogTitle>
          <DialogDescription>
            {result?.description ??
              selected?.description ??
              "Review the applicant and their request. Contact details are visible only to administrators."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-4">
          <div className="min-w-0">
            <p className="font-medium">{application.discordDisplayName}</p>
            <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{application.discordUserId}</p>
          </div>
          <Badge variant={application.status === "approved" ? "default" : "secondary"}>
            {applicationStatuses[application.status]}
          </Badge>
        </div>

        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">SteamID64</dt>
            <dd className="mt-1 font-mono text-sm break-all">{application.steamId}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">
              {application.steamOwnershipVerified ? "Ownership verified" : "Self-reported · ownership not verified"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Community connection</dt>
            <dd className="mt-1 text-sm">{applicationRelationships[application.relationship]}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">Self-reported; it does not assign a Discord role.</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Email · private</dt>
            <dd className="mt-1 text-sm break-all">{application.email || "Not provided"}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">
              {application.emailVerified ? "Verified by the application service" : "Unverified email address"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Application contact consent
            </dt>
            <dd className="mt-1 text-sm">
              {application.contactConsent
                ? "Given" +
                  (application.contactConsentAt ? " · " + new Date(application.contactConsentAt).toLocaleString() : "")
                : "Not given"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Rules accepted</dt>
            <dd className="mt-1 text-sm">{new Date(application.rulesAcceptedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Submitted</dt>
            <dd className="mt-1 text-sm">{new Date(application.submittedAt).toLocaleString()}</dd>
          </div>
          {application.reviewedAt ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Last staff review</dt>
              <dd className="mt-1 text-sm">
                {new Date(application.reviewedAt).toLocaleString()}
                {application.reviewReason ? (
                  <span className="mt-1 block text-muted-foreground">{application.reviewReason}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        {application.lastActionState ? (
          <Alert>
            <AlertTitle>Last review: {application.lastActionState}</AlertTitle>
            <AlertDescription>
              {application.lastActionMessage || "No additional details were recorded."}
              {application.reviewId || application.actionId ? (
                <span className="mt-2 block font-mono text-xs">
                  Review ID: {application.reviewId || application.actionId}
                </span>
              ) : null}
              {application.actionId && application.reviewKind !== "decline" && application.status !== "declined" ? (
                <span className="mt-1 block font-mono text-xs">
                  Original whitelist action ID: {application.actionId}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {result ? (
          <Alert variant={result.complete ? "default" : "destructive"} role="status">
            <AlertTitle>
              <Badge variant={result.complete ? "default" : "secondary"}>{result.state}</Badge>
            </AlertTitle>
            <AlertDescription className="mt-2">
              {result.complete ? "The recorded result was confirmed." : "Do not resend until the result is checked."}
              <span className="mt-1 block font-mono text-xs">Review ID: {result.reviewId}</span>
            </AlertDescription>
          </Alert>
        ) : null}

        {selected && !result ? (
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <div className="space-y-2">
              <Label htmlFor="application-review-reason">Review reason</Label>
              <Textarea
                id="application-review-reason"
                value={reason}
                maxLength={200}
                disabled={sending}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">Use 3–200 characters on one line.</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">
                {selected.confirmation} {application.discordDisplayName}
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">SteamID64 {application.steamId}</p>
            </div>
            {validation ? (
              <p role="alert" className="text-sm text-destructive">
                {validation}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={sending} onClick={() => setDecision(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={unavailable || sending}>
                {sending ? "Recording decision…" : selected.submit}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            {result ? (
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                {application.status === "pending" ? (
                  <>
                    <Button type="button" variant="outline" disabled={unavailable} onClick={() => choose("decline")}>
                      Decline request
                    </Button>
                    <Button type="button" disabled={unavailable} onClick={() => choose("approve")}>
                      Review approval
                    </Button>
                  </>
                ) : null}
                {allowRecheck ? (
                  <Button type="button" variant="outline" disabled={unavailable} onClick={() => choose("recheck")}>
                    Recheck live whitelist
                  </Button>
                ) : null}
                {!canReview(application, "approve") && !allowRecheck ? (
                  <Button type="button" variant="outline" onClick={onClose}>
                    Close
                  </Button>
                ) : null}
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
