"use client";

import { useRef, useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";

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
import type { AdminServer } from "~/lib/admin-servers";

import { AnnouncementMutationError, sendAnnouncement, type AnnouncementResult } from "./announcement-api";

function isUncertain(result: AnnouncementResult) {
  return result.state === "unknown" || result.state === "pending" || result.state === "accepted";
}

export function AnnouncementReviewDialog({
  server,
  csrf,
  message,
  playerCount,
  allowed,
  onStarted,
  onRefresh,
  onEdit,
  onClose,
}: {
  server: AdminServer;
  csrf: string;
  message: string;
  playerCount?: number;
  allowed: boolean;
  onStarted: () => void;
  onRefresh: () => void;
  onEdit: (message: string) => void;
  onClose: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<AnnouncementResult | null>(null);
  const submitted = useRef(false);

  async function send() {
    if (!allowed || sending || submitted.current || result) return;
    submitted.current = true;
    setSending(true);
    onStarted();
    try {
      setResult(await sendAnnouncement({ server, csrf, message }));
    } catch (error) {
      setResult({
        state: error instanceof AnnouncementMutationError ? error.state : "unknown",
        message: error instanceof Error ? error.message : "The announcement result could not be confirmed.",
      });
    } finally {
      setSending(false);
      onRefresh();
    }
  }

  const uncertain = result ? isUncertain(result) : false;

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl"
        onEscapeKeyDown={(event) => sending && event.preventDefault()}
        onPointerDownOutside={(event) => sending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{result ? "Announcement result" : "Review announcement"}</DialogTitle>
          <DialogDescription>
            {result
              ? "This result is tied to the selected server."
              : `This message will be broadcast to ${playerCount === undefined ? "everyone currently connected" : `${playerCount} ${playerCount === 1 ? "player" : "players"}`} immediately.`}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
          {message}
        </div>

        {result ? (
          <Alert variant={result.state === "failed" ? "destructive" : "default"}>
            <AlertTitle className="flex items-center gap-2">
              <Badge variant={result.state === "failed" ? "destructive" : "secondary"}>{result.state}</Badge>
            </AlertTitle>
            <AlertDescription className="mt-2 space-y-2">
              <p>{result.message}</p>
              {uncertain ? (
                <p>
                  Do not resend until you verify the result in{" "}
                  <Link
                    className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
                    href={`/admin/audit-logs?server=${encodeURIComponent(server.id)}&view=actions`}
                    onClick={onClose}
                  >
                    Audit Logs <ArrowUpRightIcon className="size-3" />
                  </Link>
                  .
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {result?.state === "failed" ? (
            <Button
              variant="outline"
              onClick={() => {
                onEdit(message);
                onClose();
              }}
            >
              Back to message
            </Button>
          ) : null}
          <Button variant="outline" disabled={sending} onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result ? (
            <Button disabled={!allowed || sending} onClick={() => void send()}>
              {sending ? "Sending…" : "Send announcement"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
