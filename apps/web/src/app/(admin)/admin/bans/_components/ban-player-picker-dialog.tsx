"use client";

import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";

import { isPublicIndividualSteamId } from "./bans-data";
import type { Player } from "../../players/_components/players-data";

export function BanPlayerPickerDialog({
  players,
  onPick,
  onClose,
}: {
  players: Player[];
  onPick: (player: Player) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [steamId, setSteamId] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPlayers = useMemo(
    () =>
      players.filter((player) =>
        [player.name, player.steamId].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, players],
  );
  const invalidSteamId = steamId.length > 0 && !isPublicIndividualSteamId(steamId.trim());

  function pickManualSteamId() {
    const normalizedSteamId = steamId.trim();
    if (!isPublicIndividualSteamId(normalizedSteamId)) return;
    const currentPlayer = players.find((player) => player.steamId === normalizedSteamId);
    onPick(currentPlayer ?? { name: normalizedSteamId, steamId: normalizedSteamId });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ban player</DialogTitle>
          <DialogDescription>
            Pick a connected player or enter a SteamID64. You’ll review the ban before it is sent.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ban-player-search">Connected players</FieldLabel>
            <Input
              id="ban-player-search"
              type="search"
              placeholder="Search name or SteamID64"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <ul aria-label="Connected players" className="max-h-64 overflow-y-auto rounded-md border">
              {filteredPlayers.length ? (
                filteredPlayers.map((player) => (
                  <li key={player.steamId} className="border-b last:border-b-0">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start rounded-none px-3 py-2 text-left"
                      disabled={!isPublicIndividualSteamId(player.steamId)}
                      onClick={() => onPick(player)}
                    >
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <span className="truncate font-medium">{player.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{player.steamId}</span>
                      </span>
                    </Button>
                  </li>
                ))
              ) : (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {normalizedQuery ? "No matching connected players." : "No players are connected."}
                </li>
              )}
            </ul>
          </Field>

          <Field>
            <FieldLabel htmlFor="ban-player-steam-id">Player not connected?</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="ban-player-steam-id"
                autoComplete="off"
                inputMode="numeric"
                value={steamId}
                onChange={(event) => setSteamId(event.currentTarget.value)}
                placeholder="Enter SteamID64"
                aria-invalid={invalidSteamId}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!isPublicIndividualSteamId(steamId.trim())}
                onClick={pickManualSteamId}
              >
                Review ban
              </Button>
            </div>
            {invalidSteamId ? <FieldError>Enter a valid 17-digit individual SteamID64.</FieldError> : null}
            <FieldDescription>Confirm the exact ID and provide a reason in the next step.</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
