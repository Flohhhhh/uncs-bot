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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import type { AdminServer } from "~/lib/admin-servers";

import { sendWhitelistAction, WhitelistMutationError, type WhitelistActionResult } from "./whitelist-api";
import { reasonProblem } from "./whitelist-data";
import type { WhitelistTableRow } from "./whitelist-columns";

export type WhitelistAction = { kind: "add" } | { kind: "remove"; entry: WhitelistTableRow };

export function WhitelistActionDialog({
  action,
  server,
  csrf,
  unavailable,
  onClose,
  onComplete,
}: {
  action: WhitelistAction;
  server: AdminServer;
  csrf: string;
  unavailable: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const removing = action.kind === "remove";
  const steamIdFromEntry = removing ? action.entry.steamId : "";
  const [steamId, setSteamId] = useState(steamIdFromEntry);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState(removing ? "Removed on the Whitelist page." : "Added on the Whitelist page.");
  const [validation, setValidation] = useState("");
  const [result, setResult] = useState<{ state: string; message: string } | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanSteamId = steamId.trim();
    const cleanReason = reason.trim();
    if (sending || result || unavailable) return;
    if (!/^\d{17}$/.test(cleanSteamId)) {
      setValidation("Enter a 17-digit SteamID64 for a personal Steam account.");
      return;
    }
    if (removing && confirmation.trim() !== cleanSteamId) {
      setValidation("Type the SteamID64 exactly to confirm removal.");
      return;
    }
    const reasonError = reasonProblem(cleanReason);
    if (reasonError) {
      setValidation(reasonError);
      return;
    }

    setValidation("");
    setSending(true);
    let response: WhitelistActionResult | null = null;
    try {
      response = await sendWhitelistAction({
        server,
        csrf,
        input: {
          id: crypto.randomUUID(),
          action: removing ? "whitelist-remove" : "whitelist-add",
          steamId: cleanSteamId,
          reason: cleanReason,
          ...(removing ? { confirm: cleanSteamId } : {}),
        },
      });
      setResult({ state: response.state, message: response.message });
    } catch (error) {
      setResult({
        state: error instanceof WhitelistMutationError ? error.state : "unknown",
        message: error instanceof Error ? error.message : "The result could not be confirmed.",
      });
    } finally {
      setSending(false);
      onComplete();
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        onEscapeKeyDown={(event) => sending && event.preventDefault()}
        onPointerDownOutside={(event) => sending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {result ? "Whitelist change result" : removing ? "Remove whitelist access" : "Add player to whitelist"}
          </DialogTitle>
          <DialogDescription>
            {result
              ? result.message
              : removing
                ? "Review the SteamID64 before removing access. The server will verify the change."
                : "Add a SteamID64 to the server whitelist. The change is verified against the running game."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <Alert variant={result.state === "failed" ? "destructive" : "default"} role="status">
            <AlertTitle>
              <Badge
                variant={
                  result.state === "applied" ? "default" : result.state === "failed" ? "destructive" : "secondary"
                }
              >
                {result.state}
              </Badge>
            </AlertTitle>
            <AlertDescription className="mt-2">
              {result.message}
              {result.state === "unknown" ? (
                <span className="mt-2 block">Refresh and check the whitelist before trying the action again.</span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : (
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <div className="space-y-2">
              <Label htmlFor="whitelist-steam-id">SteamID64</Label>
              <Input
                id="whitelist-steam-id"
                inputMode="numeric"
                autoComplete="off"
                value={steamId}
                disabled={removing || sending}
                onChange={(event) => setSteamId(event.currentTarget.value)}
              />
            </div>
            {removing ? (
              <div className="space-y-2">
                <Label htmlFor="whitelist-remove-confirm">Type this SteamID64 to confirm removal</Label>
                <Input
                  id="whitelist-remove-confirm"
                  autoComplete="off"
                  value={confirmation}
                  disabled={sending}
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="whitelist-action-reason">Reason</Label>
              <Textarea
                id="whitelist-action-reason"
                value={reason}
                maxLength={200}
                disabled={sending}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">Use 3–200 characters on one line.</p>
            </div>
            {validation ? (
              <p role="alert" className="text-sm text-destructive">
                {validation}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant={removing ? "destructive" : "default"} disabled={unavailable || sending}>
                {sending ? "Submitting…" : removing ? "Remove access" : "Add to whitelist"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {result ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
