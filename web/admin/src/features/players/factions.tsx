import type { Overview, Player } from "../../api/types";
import { factionColors as colors } from "../../../../../src/common/faction-colors";

export type Faction = { name: string; color: string; code: string; label: string };

export function liveFactions(overview: Overview | null): Faction[] {
  const teams = overview?.status.factionScores ?? [];
  return teams
    .filter((team) => team.name && teams.filter((other) => other.name === team.name).length === 1)
    .map((team) => {
      const raw = (team.colorHex ?? "").toLowerCase();
      const color = /^#?[0-9a-f]{6}$/.test(raw) ? `#${raw.replace(/^#/, "")}` : "";
      const known = colors[color];
      const uniqueColor =
        teams.filter((other) => (other.colorHex ?? "").toLowerCase().replace(/^#/, "") === color.slice(1)).length === 1;
      return {
        name: team.name,
        color,
        code: known && uniqueColor ? known.code : "",
        label: known && uniqueColor ? `${known.label} · ${team.name}` : team.name,
      };
    });
}

export function playerFaction(player: Player, teams: Faction[]) {
  return (
    teams.find((team) => team.name === player.faction) ||
    teams.find((team) => team.code && team.code === (player.faction ?? "").toUpperCase())
  );
}

export function FactionChip({ team, fallback = "Choosing team" }: { team?: Faction; fallback?: string }) {
  return (
    <span className="faction-chip">
      {team?.color && (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="5" fill={team.color} />
        </svg>
      )}
      {team?.label ?? fallback}
    </span>
  );
}

export function FactionOptions({ teams, excluded = "" }: { teams: Faction[]; excluded?: string }) {
  return (
    <>
      <option value="">Choose team…</option>
      {teams
        .filter((team) => team.name !== excluded)
        .map((team) => (
          <option key={team.name} value={team.name}>
            {team.label}
          </option>
        ))}
    </>
  );
}
