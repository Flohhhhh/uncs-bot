import type { MapSelection } from "./server-settings";

// Requests and saved rotations retain the catalog's exact IDs.
// Name mapping: boets.world/news/wardogs-maps-and-modes.html (2026-09-14),
// corroborated by the live map-specific zone namespaces on 2026-10-01.
const maps: Record<string, string> = { Kavkazi: "Bakurani", Europe: "Ozeti", NorthAmerica: "Zestafona" };
const modes: Record<string, string> = {
  Bakurani_KOTH_01: "King of the Hill",
  Madrid_KOTH_01: "King of the Hill",
  Detroit_KOTH_01: "King of the Hill",
  KOTH: "King of the Hill",
  KOTH_InfantryOnly: "Infantry only",
  KOTH_Hardcore: "Hardcore",
};
const lightings: Record<string, string> = {
  DayStartClear: "Dawn · clear",
  DayEarlyClear: "Early day · clear",
  DayEarlyFog: "Early day · fog",
  DayClear: "Day · clear",
  DayLateClear: "Late day · clear",
  DayLateGray: "Late day · overcast",
  DayLateGrayFog: "Late day · overcast & fog",
  DayEndClear: "Dusk · clear",
};
const label = (names: Record<string, string>, id: string, displayName?: string) =>
  (Object.hasOwn(names, id) ? names[id] : displayName) || id;
export const mapLabel = (id: string, displayName?: string) => label(maps, id, displayName);
// Live status uses in-game names; the catalog and saved INI use the IDs above.
// Compare only these known aliases, never arbitrary display names or partial names.
export const sameMap = (a: string | undefined, b: string | undefined) => !!a && !!b && mapLabel(a) === mapLabel(b);
export const modeLabel = (id: string, displayName?: string) => label(modes, id, displayName);
// The official console separates the base game mode from these additive rules.
export const isModeModifier = (id: string) => id === "KOTH_InfantryOnly" || id === "KOTH_Hardcore";
export const lightingLabel = (id: string, displayName?: string) => label(lightings, id, displayName);
export function zoneLabel(id: string) {
  if (id === "None") return "Map default";
  const match =
    /^ZoneAlternator\.(Bakurani|Ozeti|Zestafona)\.(Default|Farmland|Lumberyard|Church|River|SmallFactory|WaterTreatment|Houses)\.Circle$/.exec(
      id,
    );
  return match ? match[2].replace(/([a-z])([A-Z])/g, "$1 $2") : id;
}
/** A ballot option marked `event: "50v50"` plays that entry as a 50v50 round. */
type LabelledSelection = MapSelection & { event?: "50v50" };
export function selectionDetails(entry: LabelledSelection) {
  const details =
    [
      ...entry.experiences.map((id) => modeLabel(id)),
      entry.lighting ? lightingLabel(entry.lighting) : "",
      entry.zoneAlternator ? zoneLabel(entry.zoneAlternator) : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Map defaults";
  return entry.event === "50v50" ? `${details} · 50v50 next round` : details;
}
export const selectionLabel = (entry: LabelledSelection) => `${mapLabel(entry.map)} · ${selectionDetails(entry)}`;
