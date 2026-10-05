"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";

import {
  canPlayerAction,
  teamFor,
  toneFor,
  type Player,
  type PlayerAction,
  type PlayersOverview,
} from "./players-data";

type IndividualAction = Exclude<PlayerAction, "team">;

const stat = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";

export function PlayerInspectionDrawer({
  open,
  onOpenChange,
  player,
  live,
  overview,
  role,
  stale,
  busy,
  onAction,
  onMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  player: Player | null;
  live: boolean;
  overview?: PlayersOverview;
  role: "admin" | "moderator" | "viewer";
  stale: boolean;
  busy: boolean;
  onAction: (action: IndividualAction, player: Player) => void;
  onMove: (teamName?: string) => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const teams = overview?.status.factionScores ?? [];
  const assignedTeam = player ? teamFor(player, teams) : undefined;
  const teamName = assignedTeam?.name ?? player?.faction ?? "Unassigned";
  const tone = toneFor(teamName);
  const permitted = (action: PlayerAction) =>
    Boolean(player && live && canPlayerAction(action, role, overview, stale, busy));
  const unavailable = ["message", "team", "kick", "ban", "whitelist-add", "kill"].some(
    (action) => !permitted(action as PlayerAction),
  );

  async function copySteamId() {
    if (!player) return;
    try {
      await navigator.clipboard.writeText(player.steamId);
      setCopyStatus("SteamID copied.");
    } catch {
      setCopyStatus("Clipboard access is unavailable.");
    }
  }

  const actionButton = (action: IndividualAction, label: string, destructive = false) => (
    <Button
      key={action}
      type="button"
      variant={destructive ? "outline" : "secondary"}
      className={destructive ? "border-destructive/40 text-destructive hover:bg-destructive/10" : undefined}
      disabled={!permitted(action)}
      onClick={() => player && onAction(action, player)}
    >
      {label}
    </Button>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(28rem,calc(100vw-1rem))] gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-5 pr-14">
          <SheetTitle className="truncate text-xl">{player?.name ?? "Player"}</SheetTitle>
          <SheetDescription className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${tone.dot}`} />
            <span className="truncate">{teamName}</span>
            {!live && <span className="shrink-0">· no longer in roster</span>}
          </SheetDescription>
        </SheetHeader>
        {player && (
          <div className="flex flex-col gap-5 px-6 py-5">
            {!live && (
              <Alert>
                <AlertDescription>
                  This player is no longer in the current roster. Actions are unavailable.
                </AlertDescription>
              </Alert>
            )}
            {live && stale && (
              <Alert>
                <AlertDescription>
                  Roster details need a fresh check before player actions can be used.
                </AlertDescription>
              </Alert>
            )}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Kills", stat(player.kills)],
                ["Deaths", stat(player.deaths)],
                ["Ping", player.pingMs === undefined ? "—" : `${stat(player.pingMs)} ms`],
                ["Cash", stat(player.cash)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border bg-card px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">SteamID</span>
              <code className="min-w-0 truncate text-sm tabular-nums">{player.steamId}</code>
              <Button type="button" size="xs" variant="outline" onClick={() => void copySteamId()}>
                Copy
              </Button>
              {copyStatus && (
                <span className="text-xs text-muted-foreground" role="status">
                  {copyStatus}
                </span>
              )}
            </div>
            <Separator />
            {unavailable && live && (
              <p className="text-sm text-muted-foreground">
                Some controls are unavailable for your role or the current server build.
              </p>
            )}
            <section aria-label="Message player" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Message</h3>
              <div className="flex flex-wrap gap-2">{actionButton("message", "Send message")}</div>
            </section>
            <section aria-label="Change team" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Team</h3>
              <div className="flex flex-wrap gap-2">
                {teams
                  .filter((team) => team.name !== assignedTeam?.name)
                  .map((team) => (
                    <Button
                      key={team.name}
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!permitted("team")}
                      onClick={() => onMove(team.name)}
                    >
                      Move to {team.name}
                    </Button>
                  ))}
                {!teams.length && <span className="text-sm text-muted-foreground">No teams reported.</span>}
              </div>
            </section>
            <section aria-label="Moderation" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Moderation</h3>
              <div className="flex flex-wrap gap-2">
                {actionButton("kick", "Kick player", true)}
                {actionButton("ban", "Ban player", true)}
              </div>
            </section>
            <section aria-label="Whitelist" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Whitelist</h3>
              <div className="flex flex-wrap gap-2">{actionButton("whitelist-add", "Add whitelist access")}</div>
            </section>
            <details className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">More</summary>
              <div className="pt-3">{actionButton("kill", "Force player respawn", true)}</div>
            </details>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
