"use client";

import { Toggle } from "~/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Input } from "~/components/ui/input";

import { toneFor } from "./players-data";

export type TeamFilterOption = { id: string; name: string; count: number };

export function PlayersFilterRail({
  query,
  onQueryChange,
  teamFilter,
  onTeamFilterChange,
  uncOnly,
  onUncOnlyChange,
  rosterCount,
  teams,
  unassignedCount,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  teamFilter: string;
  onTeamFilterChange: (value: string) => void;
  uncOnly: boolean;
  onUncOnlyChange: (value: boolean) => void;
  rosterCount: number;
  teams: TeamFilterOption[];
  unassignedCount: number;
}) {
  const showUnassigned = unassignedCount > 0 || teamFilter === "unassigned";

  return (
    <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
      <div className="flex min-w-96 items-center gap-3">
        <Input
          aria-label="Search players"
          placeholder="Search..."
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <span className="shrink-0 text-sm text-muted-foreground">{rosterCount} players</span>
      </div>
      <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
        <ToggleGroup
          type="single"
          value={teamFilter}
          onValueChange={(value) => value && onTeamFilterChange(value)}
          aria-label="Filter players by team"
          className="flex flex-wrap gap-2"
        >
          <ToggleGroupItem className="px-4" value="all" aria-label={`All teams, ${rosterCount} players`}>
            All <span className="text-xs text-muted-foreground">{rosterCount}</span>
          </ToggleGroupItem>
          {teams.map((team) => (
            <ToggleGroupItem
              className="px-4"
              key={team.id}
              value={team.id}
              aria-label={`${team.name}, ${team.count} players`}
            >
              <span aria-hidden="true" className={`size-2 rounded-full ${toneFor(team.name).dot}`} />
              {team.name}
              <span className="text-xs text-muted-foreground">{team.count}</span>
            </ToggleGroupItem>
          ))}
          {showUnassigned && (
            <ToggleGroupItem className="px-4" value="unassigned" aria-label={`Unassigned, ${unassignedCount} players`}>
              Unassigned <span className="text-xs text-muted-foreground">{unassignedCount}</span>
            </ToggleGroupItem>
          )}
        </ToggleGroup>
        <Toggle
          variant="outline"
          size="sm"
          pressed={uncOnly}
          onPressedChange={onUncOnlyChange}
          aria-label="Filter names containing UNC"
          title="Matches player names only. It does not verify community membership."
          className="rounded-full px-4"
        >
          UNC in name
        </Toggle>
      </div>
    </div>
  );
}
