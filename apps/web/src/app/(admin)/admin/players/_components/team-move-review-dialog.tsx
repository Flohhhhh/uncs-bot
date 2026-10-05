"use client";

import { useRef, useState, type FormEvent } from "react";

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
import { Field, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import type { AdminServer } from "~/lib/admin-servers";

import { readPlayersOverview, sendPlayerAction, PlayerMutationError } from "./players-api";
import {
  canPlayerAction,
  isRosterFresh,
  moveSpacing,
  roundStamp,
  sameRound,
  teamFor,
  type Player,
  type PlayersOverview,
} from "./players-data";

type ItemState =
  | "queued"
  | "sending"
  | "applied"
  | "accepted"
  | "pending"
  | "failed"
  | "unknown"
  | "skipped"
  | "unmatched"
  | "refused";

type MoveItem = {
  id: string;
  player: Player;
  fromTeam: string;
  fromFaction: string;
  state: ItemState;
  message: string;
};

export type TeamMoveCompletion = {
  attemptedIds: string[];
  stopped: boolean;
  items: MoveItem[];
};

const notSent = (item: MoveItem) => item.state === "queued" || item.state === "unmatched" || item.state === "refused";
const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function stateTone(state: ItemState) {
  if (state === "applied" || state === "accepted") return "secondary" as const;
  if (state === "failed") return "destructive" as const;
  if (state === "pending" || state === "unknown" || state === "sending") return "outline" as const;
  return "outline" as const;
}

export function TeamMoveReviewDialog({
  open,
  onOpenChange,
  players,
  overview,
  server,
  csrf,
  role,
  initialTeam = "",
  onBusyChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  players: Player[];
  overview: PlayersOverview;
  server: AdminServer;
  csrf: string;
  role: AdminServer["role"];
  initialTeam?: string;
  onBusyChange: (busy: boolean) => void;
  onComplete: (completion: TeamMoveCompletion) => void;
}) {
  const [destination, setDestination] = useState(initialTeam);
  const [items, setItems] = useState<MoveItem[]>(() =>
    [...new Map(players.map((player) => [player.steamId, player])).values()].map((player) => ({
      id: crypto.randomUUID(),
      player,
      fromTeam: teamFor(player, overview.status.factionScores)?.name ?? "",
      fromFaction: player.faction ?? "",
      state: "queued",
      message: "Not sent",
    })),
  );
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState("");
  const stopRequested = useRef(false);
  const submitted = useRef(false);
  const teams = overview.status.factionScores;
  const destinationTeam = teams.find((team) => team.name === destination);
  const changeCount = items.filter((item) => item.fromTeam !== destination).length;
  const permitted = canPlayerAction("team", role, overview, !isRosterFresh(overview), running);
  const ready = permitted && !!destinationTeam && changeCount > 0 && !done;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !ready || !destinationTeam) return;
    submitted.current = true;
    setRunning(true);
    setError("");
    onBusyChange(true);

    const batch = items.map((item) => ({ ...item }));
    const reviewedRound = roundStamp(overview);
    let didSend = false;
    let didStop = false;
    let stopReason = "";
    let spacing = moveSpacing(overview);
    let hidden = document.hidden;
    const visibilityChanged = () => {
      hidden ||= document.hidden;
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    const publish = () => setItems(batch.map((item) => ({ ...item })));

    try {
      for (const item of batch) {
        if (didSend && item.fromTeam !== destination) await delay(spacing);
        if (stopRequested.current || hidden) {
          if (hidden) stopReason = "The dashboard was hidden during the move.";
          didStop = true;
          break;
        }
        if (item.fromTeam === destination) {
          item.state = "skipped";
          item.message = "Already on the chosen team in the reviewed roster. No request sent.";
          publish();
          continue;
        }

        let live: PlayersOverview;
        try {
          live = await readPlayersOverview(server);
        } catch {
          stopReason = "The live roster could not be read before the next move.";
          didStop = true;
          break;
        }

        spacing = moveSpacing(live);
        const liveTeams = live.status.factionScores;
        const currentRound = roundStamp(live);
        const currentDestination = liveTeams.find((team) => team.name === destination);
        if (
          stopRequested.current ||
          hidden ||
          !isRosterFresh(live) ||
          !canPlayerAction("team", role, live, false, false) ||
          !currentDestination
        ) {
          if (hidden) stopReason = "The dashboard was hidden during the move.";
          else if (!currentDestination) stopReason = "The destination team is no longer available.";
          else stopReason = "The current server or roster no longer allows team changes.";
          didStop = true;
          break;
        }
        if (reviewedRound && (!currentRound || !sameRound(reviewedRound, currentRound))) {
          stopReason = "The round changed during the team moves.";
          didStop = true;
          break;
        }

        const livePlayer = live.players.find((player) => player.steamId === item.player.steamId);
        if (!livePlayer) {
          item.state = "unmatched";
          item.message = "Left the server after review. No request sent.";
          publish();
          continue;
        }
        const liveTeam = teamFor(livePlayer, liveTeams)?.name ?? "";
        const changedUnassignedFaction = !item.fromTeam && !liveTeam && (livePlayer.faction ?? "") !== item.fromFaction;
        if ((item.fromTeam && liveTeam !== item.fromTeam) || changedUnassignedFaction) {
          item.state = "unmatched";
          item.message = "Changed team after review. No request sent.";
          publish();
          continue;
        }
        if (liveTeam === destination) {
          item.state = "skipped";
          item.message = "Already on the chosen team. No request sent.";
          publish();
          continue;
        }

        item.state = "sending";
        item.message = "Waiting for the game’s response.";
        publish();
        didSend = true;
        try {
          const currentFaction = teamFor(livePlayer, liveTeams);
          const result = await sendPlayerAction({
            server,
            csrf,
            input: {
              id: item.id,
              action: "team",
              steamId: livePlayer.steamId,
              confirm: livePlayer.steamId,
              faction: destination,
              reason: "Staff requested team move.",
              ...(currentFaction ? { expectedFaction: currentFaction.name } : {}),
              ...(reviewedRound ? { expectedRound: reviewedRound } : {}),
            },
          });
          item.state = result.state;
          item.message = result.message || "The result was acknowledged without a message.";
          if (result.state === "failed" && result.changed === false) {
            item.state = "refused";
            item.message = result.message || "Roster changed before the server applied the move. No request was sent.";
          }
        } catch (failure) {
          const state = failure instanceof PlayerMutationError ? failure.state : "unknown";
          item.state = state;
          item.message =
            failure instanceof Error
              ? `${failure.message} Check the action record before repeating it.`
              : "The result could not be confirmed. Check the action record before repeating it.";
        }
        publish();
        if (
          stopRequested.current ||
          item.state === "failed" ||
          item.state === "unknown" ||
          item.state === "accepted" ||
          item.state === "pending"
        ) {
          didStop = true;
          break;
        }
      }
    } finally {
      document.removeEventListener("visibilitychange", visibilityChanged);
      setRunning(false);
      setDone(true);
      setStopped(didStop);
      onBusyChange(false);
      const attemptedIds = batch.filter((item) => !notSent(item)).map((item) => item.player.steamId);
      onComplete({ attemptedIds, stopped: didStop, items: batch });
      if (didStop) {
        setError(
          stopRequested.current
            ? "Stopped at your request. Sent actions keep their results; remaining players were not sent."
            : `${stopReason || "The move stopped before all players were processed."} Remaining players were not sent. Check action records before trying again.`,
        );
      }
    }
  }

  function requestClose(nextOpen: boolean) {
    if (!running) onOpenChange(nextOpen);
  }

  const changesDestination = (value: string) => {
    setDestination(value);
    if (!submitted.current) {
      setItems((current) =>
        current.map((item) => ({
          ...item,
          state: item.fromTeam === value ? "skipped" : "queued",
          message: item.fromTeam === value ? "Already on chosen team. No request sent." : "Not sent",
        })),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
        onEscapeKeyDown={(event) => running && event.preventDefault()}
        onPointerDownOutside={(event) => running && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {done
              ? stopped
                ? "Team move stopped"
                : "Team requests complete"
              : `Move ${items.length === 1 ? items[0]?.player.name : `${items.length} players`}`}
          </DialogTitle>
          <DialogDescription>
            Review the selected players and destination. This changes team assignment without forcing a respawn; players
            may need to respawn before the change takes effect.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Move stopped</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!done && (
          <form onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="team-move-destination">Destination team</FieldLabel>
                <Select value={destination} onValueChange={changesDestination} disabled={running || !permitted}>
                  <SelectTrigger id="team-move-destination" className="w-full">
                    <SelectValue placeholder="Choose a team" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {teams.map((team) => (
                        <SelectItem key={team.name} value={team.name}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <p className="text-sm text-muted-foreground">
                {changeCount} player{changeCount === 1 ? "" : "s"} will receive a move request. Players already on this
                team will be skipped.
              </p>
              {!permitted && (
                <p className="text-sm text-muted-foreground">
                  Team changes are unavailable for this role, server build, or roster check.
                </p>
              )}
            </FieldGroup>
            <Separator className="my-4" />
            <ul className="flex max-h-52 flex-col gap-2 overflow-y-auto text-sm">
              {items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {item.player.name}
                    <span className="ml-2 text-xs text-muted-foreground">{item.fromTeam || "Unassigned"}</span>
                  </span>
                  <Badge variant={stateTone(item.state)}>{item.state}</Badge>
                </li>
              ))}
            </ul>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" disabled={running} onClick={() => requestClose(false)}>
                Cancel
              </Button>
              {running ? (
                <Button type="button" variant="outline" onClick={() => (stopRequested.current = true)}>
                  Stop after current request
                </Button>
              ) : (
                <Button type="submit" disabled={!ready}>
                  Review and move
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
        {done && (
          <>
            <ul className="flex flex-col gap-2 text-sm">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="font-medium">{item.player.name}</span>
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <Badge variant={stateTone(item.state)}>{item.state}</Badge>
                    <span>{item.message}</span>
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={() => requestClose(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
