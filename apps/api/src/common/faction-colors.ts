// Palette/code pairs published by the official Wardogs RCON console.
export const factionColors: Record<string, { code: string; label: string }> = {
  "#d86060": { code: "RED", label: "Red" },
  "#5b95d8": { code: "BLU", label: "Blue" },
  "#7bc462": { code: "GRN", label: "Green" },
};
export type NamedFaction = { name: string; colorHex?: string };
export function assignedFaction(value: string | null | undefined, factions: NamedFaction[]) {
  if (!value) return null;
  const matches = ["RED", "BLU", "GRN"].includes(value)
    ? factions.filter((faction) => factionColors[faction.colorHex?.trim().toLowerCase() ?? ""]?.code === value)
    : factions.filter((faction) => faction.name === value);
  return matches.length === 1 ? matches[0].name : null;
}
