"use client";

import Link from "next/link";
import { useState } from "react";
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

import { SettingsMutationError, saveServerSettings } from "./settings-api";
import type { SettingsActionResult, SettingsChanges, SettingsSnapshot } from "./settings-data";

type ReviewGroup = { title: string; items: string[] };
type ReviewResult = SettingsActionResult | { id: string; state: "failed" | "unknown"; message: string };

export function SettingsReviewDialog({
  server,
  csrf,
  snapshot,
  changes,
  groups,
  unavailable,
  onClose,
  onComplete,
}: {
  server: AdminServer;
  csrf: string;
  snapshot: SettingsSnapshot;
  changes: SettingsChanges;
  groups: ReviewGroup[];
  unavailable: string;
  onClose: () => void;
  onComplete: (state: ReviewResult["state"]) => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [sending, setSending] = useState(false);
  const serverParam = `?server=${encodeURIComponent(server.id)}&view=actions&id=${encodeURIComponent(id)}`;

  async function submit() {
    if (sending || result || unavailable) return;
    setSending(true);
    try {
      const response = await saveServerSettings({
        server,
        csrf,
        id,
        revision: snapshot.revision,
        changes,
      });
      setResult(response);
      onComplete(response.state);
    } catch (error) {
      const state = error instanceof SettingsMutationError ? error.state : "unknown";
      const message = error instanceof Error ? error.message : "The result could not be confirmed.";
      setResult({ id, state, message });
      onComplete(state);
    } finally {
      setSending(false);
    }
  }

  function requestClose(open: boolean) {
    if (!open && !sending) onClose();
  }

  return (
    <Dialog open onOpenChange={requestClose}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => sending && event.preventDefault()}
        onPointerDownOutside={(event) => sending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{result ? "Settings save result" : "Review server changes"}</DialogTitle>
          <DialogDescription>
            {result
              ? `The save request has finished for ${server.name}. Check the result below before continuing.`
              : `Review these changes for ${server.name}. Some changes apply now; others wait for a match or restart.`}
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="grid gap-4">
            {groups.map((group) => (
              <section key={group.title} aria-label={group.title} className="grid gap-2">
                <h3 className="text-sm font-semibold">{group.title}</h3>
                <ul className="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm">
                  {group.items.map((item, index) => (
                    <li key={`${group.title}:${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            ))}
            {unavailable ? (
              <p className="text-sm text-destructive" role="alert">
                {unavailable}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 text-sm" role="status">
              <Badge
                variant={
                  result.state === "failed" ? "destructive" : result.state === "unknown" ? "outline" : "secondary"
                }
              >
                {result.state}
              </Badge>
              <span>{result.message}</span>
            </p>
            {result.state === "unknown" ? (
              <p className="text-sm text-muted-foreground">
                Do not submit this save again until its result has been checked.
              </p>
            ) : result.state === "failed" ? (
              <p className="text-sm text-muted-foreground">
                Your edits are still in the page and can be corrected or reviewed again.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">The settings will be re-read after this review is closed.</p>
            )}
            {result.state === "unknown" ? (
              <Button asChild variant="outline" className="w-fit">
                <Link href={`/admin/audit-logs${serverParam}`}>Check Audit Logs</Link>
              </Button>
            ) : null}
            <p className="text-xs break-all text-muted-foreground">
              Action ID: <code>{id}</code>
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result ? (
            <Button type="button" disabled={sending || Boolean(unavailable)} onClick={() => void submit()}>
              {sending ? "Saving…" : "Save settings"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
