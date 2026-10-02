import type { MapSelection } from "./server-settings";

// Presentation only. Requests and saved rotations retain the catalog's exact IDs.
// Name mapping: boets.world/news/wardogs-maps-and-modes.html (2026-09-14),
// corroborated by the live map-specific zone namespaces on 2026-10-01.
const maps: Record<string, string> = { Kavkazi: "Bakurani", Europe: "Ozeti", NorthAmerica: "Zestafona" };
const modes: Record<string, string> = {
  Bakurani_KOTH_01: "Standard",
  Madrid_KOTH_01: "Standard",
  Detroit_KOTH_01: "Standard",
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
export const modeLabel = (id: string, displayName?: string) => label(modes, id, displayName);
export const lightingLabel = (id: string, displayName?: string) => label(lightings, id, displayName);
export function zoneLabel(id: string) {
  if (id === "None") return "Map default";
  const match =
    /^ZoneAlternator\.(Bakurani|Ozeti|Zestafona)\.(Default|Farmland|Lumberyard|Church|River|SmallFactory|WaterTreatment|Houses)\.Circle$/.exec(
      id,
    );
  return match ? match[2].replace(/([a-z])([A-Z])/g, "$1 $2") : id;
}
export function selectionDetails(entry: MapSelection) {
  return (
    [
      ...entry.experiences.map((id) => modeLabel(id)),
      entry.lighting ? lightingLabel(entry.lighting) : "",
      entry.zoneAlternator ? zoneLabel(entry.zoneAlternator) : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Map defaults"
  );
}
export const selectionLabel = (entry: MapSelection) => `${mapLabel(entry.map)} · ${selectionDetails(entry)}`;
