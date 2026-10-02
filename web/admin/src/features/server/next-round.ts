import { lightingLabel, mapLabel, modeLabel, sameMap, zoneLabel } from "../../../../../src/common/map-labels";
import type { MapSelection, SettingsSnapshot } from "../../../../../src/common/server-settings";

export type RotationSnapshot = SettingsSnapshot["rotation"];
/**
 * - `saved`: the entry after the running rotation entry in an enabled, ordered rotation.
 * - `game-next`: no running entry is known, but the game names the entry it plays next.
 * - `unconfirmed`: the next round is not fixed or its position could not be confirmed.
 * - `unavailable`: no rotation was read.
 */
export type NextRoundState = "saved" | "game-next" | "unconfirmed" | "unavailable";
export type NextRoundSummary = {
  state: NextRoundState;
  /** The rotation entry that plays next, when known. */
  entry: MapSelection | null;
  /** Its position in the saved rotation, from 0. */
  index: number | null;
  /** "Ozeti · King of the Hill · Farmland · Day clear", or a short reason when the next round is unknown. */
  label: string;
  /** The game's explanation of the rotation position, when it gave one. */
  note: string;
};

/** A compact one-line label: map, modes and rules, zone layout, then lighting. */
export function roundLabel(entry: MapSelection) {
  return [
    mapLabel(entry.map),
    ...entry.experiences.map((id) => modeLabel(id)),
    entry.zoneAlternator && entry.zoneAlternator !== "None" ? zoneLabel(entry.zoneAlternator) : "",
    // Lighting labels use their own separator ("Day · clear"); keep one separator per part.
    entry.lighting ? lightingLabel(entry.lighting).replaceAll(" · ", " ") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What plays after this match, as far as the saved rotation and the game confirm it. */
export function nextRoundSummary(source: SettingsSnapshot | RotationSnapshot | null | undefined): NextRoundSummary {
  const rotation = source && "rotation" in source ? source.rotation : source;
  if (!rotation) return { state: "unavailable", entry: null, index: null, label: "Unavailable", note: "" };
  const { entries, currentIndex, nextIndex } = rotation;
  const note = rotation.positionNote ?? "";
  if (!rotation.enabled || rotation.mode !== "Ordered" || !entries.length)
    return { state: "unconfirmed", entry: null, index: null, label: "No fixed next round", note };
  // A running entry counts only while its map is the one being played.
  if (currentIndex !== null && entries[currentIndex] && sameMap(entries[currentIndex].map, rotation.currentMap)) {
    const index = (currentIndex + 1) % entries.length;
    return { state: "saved", entry: entries[index], index, label: roundLabel(entries[index]), note: "" };
  }
  if (currentIndex === null && nextIndex !== null && Number.isInteger(nextIndex) && entries[nextIndex])
    return {
      state: "game-next",
      entry: entries[nextIndex],
      index: nextIndex,
      label: roundLabel(entries[nextIndex]),
      note,
    };
  return { state: "unconfirmed", entry: null, index: null, label: "Not confirmed", note };
}
