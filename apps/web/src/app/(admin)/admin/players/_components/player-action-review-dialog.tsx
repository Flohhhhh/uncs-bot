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
import { Field, FieldError, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import type { AdminServer } from "~/lib/admin-servers";

import { PlayerMutationError, sendPlayerAction, type PlayerActionResult } from "./players-api";
import { roundStamp, teamFor, type Player, type PlayerAction, type PlayersOverview } from "./players-data";

type IndividualAction = Exclude<PlayerAction, "team">;

const actionDetails: Record<IndividualAction, { title: string; description: string }> = {
  message: {
    title: "Message player",
    description: "Send a private in-game message to this player.",
  },
  kick: {
    title: "Kick player",
    description: "Disconnect this player from the current game. They can rejoin.",
  },
  ban: {
    title: "Ban player",
    description: "Add a permanent game ban. The current game build may require the player to be connected.",
  },
  "whitelist-add": {
    title: "Add whitelist access",
    description: "Add this SteamID to the server whitelist without changing reserved capacity.",
  },
  kill: {
    title: "Force player respawn",
    description: "Kill this player’s current character. Use only when needed to resolve an issue.",
  },
};

const needsReason = (action: IndividualAction) => action === "kick" || action === "ban";
const needsConfirmation = (action: IndividualAction) => action === "ban" || action === "kill";
const singleLine = (value: string, minimum = 1) =>
  value.trim().length >= minimum && value.trim().length <= 200 && [...value].every((char) => char.charCodeAt(0) >= 32);

export function PlayerActionReviewDialog({
  open,
  onOpenChange,
  action,
  player,
  overview,
  server,
  csrf,
  allowed,
  onBusyChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: IndividualAction;
  player: Player;
  overview: PlayersOverview;
  server: AdminServer;
  csrf: string;
  allowed: boolean;
  onBusyChange: (busy: boolean) => void;
  onComplete: () => void;
}) {
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<PlayerActionResult | null>(null);
  const [sending, setSending] = useState(false);
  const details = actionDetails[action];
  const validReason = !needsReason(action) || singleLine(reason, 3);
  const validMessage = action !== "message" || singleLine(message);
  const validConfirmation = !needsConfirmation(action) || confirmation === player.steamId;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allowed || !validReason || !validMessage || !validConfirmation || sending || result) return;

    setSending(true);
    onBusyChange(true);
    const reviewedRound = roundStamp(overview);
    const assignedTeam = teamFor(player, overview.status.factionScores);
    try {
      const response = await sendPlayerAction({
        server,
        csrf,
        input: {
          id: crypto.randomUUID(),
          action,
          steamId: player.steamId,
          reason: needsReason(action) ? reason.trim() : `Staff action: ${details.title}.`,
          ...(needsConfirmation(action) ? { confirm: player.steamId } : {}),
          ...(action === "message" ? { message: message.trim() } : {}),
          ...(action === "kill" && assignedTeam ? { expectedFaction: assignedTeam.name } : {}),
          ...(action === "kill" && reviewedRound ? { expectedRound: reviewedRound } : {}),
        },
      });
      setResult(response);
    } catch (failure) {
      setResult({
        state: failure instanceof PlayerMutationError ? failure.state : "unknown",
        message: failure instanceof Error ? failure.message : "The action result could not be confirmed.",
      });
    } finally {
      setSending(false);
      onBusyChange(false);
      onComplete();
    }
  }

  function requestClose(nextOpen: boolean) {
    if (!sending) onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto"
        onEscapeKeyDown={(event) => sending && event.preventDefault()}
        onPointerDownOutside={(event) => sending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{result ? `${details.title} result` : details.title}</DialogTitle>
          <DialogDescription>
            {result ? `Target: ${player.name} · ${player.steamId}` : `${details.description} Target: ${player.name}.`}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <Alert variant={result.state === "failed" ? "destructive" : "default"}>
            <AlertTitle>
              <Badge variant={result.state === "failed" ? "destructive" : "secondary"}>{result.state}</Badge>
            </AlertTitle>
            <AlertDescription className="mt-2">
              <p>{result.message}</p>
              {result.state === "unknown" && <p className="mt-2">Do not resend until the result is checked.</p>}
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              {action === "message" && (
                <Field>
                  <FieldLabel htmlFor="player-message">Message</FieldLabel>
                  <Textarea
                    id="player-message"
                    autoFocus
                    maxLength={200}
                    value={message}
                    onChange={(event) => setMessage(event.currentTarget.value)}
                    placeholder="Write a private in-game message"
                    disabled={sending || !allowed}
                    aria-invalid={message.length > 0 && !validMessage}
                  />
                  {!validMessage && <FieldError>Enter a single-line message up to 200 characters.</FieldError>}
                </Field>
              )}
              {needsReason(action) && (
                <Field>
                  <FieldLabel htmlFor="player-action-reason">Reason</FieldLabel>
                  <Textarea
                    id="player-action-reason"
                    autoFocus
                    maxLength={200}
                    value={reason}
                    onChange={(event) => setReason(event.currentTarget.value)}
                    placeholder="Enter a moderation reason"
                    disabled={sending || !allowed}
                    aria-invalid={reason.length > 0 && !validReason}
                  />
                  {!validReason && <FieldError>Enter a single-line reason between 3 and 200 characters.</FieldError>}
                </Field>
              )}
              {needsConfirmation(action) && (
                <Field>
                  <FieldLabel htmlFor="player-action-confirmation">Confirm SteamID</FieldLabel>
                  <Input
                    id="player-action-confirmation"
                    autoComplete="off"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.currentTarget.value)}
                    placeholder={player.steamId}
                    disabled={sending || !allowed}
                    aria-invalid={confirmation.length > 0 && !validConfirmation}
                  />
                  <p className="text-sm text-muted-foreground">Type the player’s SteamID exactly to confirm.</p>
                </Field>
              )}
              {!allowed && (
                <p className="text-sm text-muted-foreground">
                  This action is unavailable for your role, the current server build, or this roster check.
                </p>
              )}
            </FieldGroup>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" disabled={sending} onClick={() => requestClose(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action === "kick" || action === "ban" || action === "kill" ? "outline" : "default"}
                className={
                  action === "kick" || action === "ban" || action === "kill"
                    ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                    : undefined
                }
                disabled={!allowed || !validReason || !validMessage || !validConfirmation || sending}
              >
                {sending ? "Sending…" : details.title}
              </Button>
            </DialogFooter>
          </form>
        )}
        {result && (
          <DialogFooter>
            <Button type="button" onClick={() => requestClose(false)}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
