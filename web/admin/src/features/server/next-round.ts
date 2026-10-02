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
  /** Where the label comes from, or why there is none: "Saved next round", "Rotation is off". */
  caption: string;
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

const noFixedRound = "No fixed next round";
function notFixed(rotation: RotationSnapshot) {
  return !rotation.enabled
    ? "Rotation is off"
    : rotation.mode !== "Ordered"
      ? "Rotation is random"
      : "Rotation is empty";
}

/** What plays after this match, as far as the saved rotation and the game confirm it. */
export function nextRoundSummary(source: SettingsSnapshot | RotationSnapshot | null | undefined): NextRoundSummary {
  const rotation = source && "rotation" in source ? source.rotation : source;
  if (!rotation)
    return {
      state: "unavailable",
      entry: null,
      index: null,
      label: "Unavailable",
      note: "",
      caption: "Rotation not read",
    };
  const { entries, currentIndex, nextIndex } = rotation;
  const note = rotation.positionNote ?? "";
  if (!rotation.enabled || rotation.mode !== "Ordered" || !entries.length)
    return {
      state: "unconfirmed",
      entry: null,
      index: null,
      label: noFixedRound,
      note,
      caption: notFixed(rotation),
    };
  // A running entry counts only while its map is the one being played.
  if (currentIndex !== null && entries[currentIndex] && sameMap(entries[currentIndex].map, rotation.currentMap)) {
    const index = (currentIndex + 1) % entries.length;
    return {
      state: "saved",
      entry: entries[index],
      index,
      label: roundLabel(entries[index]),
      note: "",
      caption: "Saved next round",
    };
  }
  if (currentIndex === null && nextIndex !== null && Number.isInteger(nextIndex) && entries[nextIndex])
    return {
      state: "game-next",
      entry: entries[nextIndex],
      index: nextIndex,
      label: roundLabel(entries[nextIndex]),
      note,
      caption: "Game's next rotation entry",
    };
  return {
    state: "unconfirmed",
    entry: null,
    index: null,
    label: "Not confirmed",
    note,
    caption: "Rotation position unknown",
  };
}

/** One line for reviews: "Next: Ozeti · Day clear (saved rotation)" or "Next map not confirmed". */
export function nextRoundLine(summary: NextRoundSummary) {
  if (summary.state === "saved") return `Next: ${summary.label} (saved rotation)`;
  if (summary.state === "game-next") return `Next: ${summary.label} (game's next rotation entry)`;
  if (summary.label === noFixedRound) return `No fixed next map: ${summary.caption.toLowerCase()}`;
  return "Next map not confirmed";
}

/** The game's running rotation, which every staff role can read. */
export type RunningRotation = {
  enabled: boolean;
  mode: string;
  entries: {
    map: string;
    experiences?: string[];
    lighting?: string;
    zoneAlternator?: string;
    status?: string | null;
    denied?: boolean;
  }[];
};

/**
 * Reads the running rotation's markers the way the server confirms a position: one `now` entry on the
 * map being played, or, with no `now` entry, one `next` entry. An unavailable entry is never named.
 */
export function runningRotationSnapshot(rotation: RunningRotation, currentMap: string): RotationSnapshot {
  const marked = (marker: string) =>
    rotation.entries.flatMap((entry, index) => (entry.status === marker ? [index] : []));
  const now = marked("now");
  const next = marked("next");
  const count = rotation.entries.length;
  const usable = (index: number) => !rotation.entries[index].denied;
  const currentIndex = now.length === 1 && usable(now[0]) && usable((now[0] + 1) % count) ? now[0] : null;
  const nextIndex =
    currentIndex !== null
      ? (currentIndex + 1) % count
      : !now.length && next.length === 1 && usable(next[0])
        ? next[0]
        : null;
  return {
    entries: rotation.entries.map(({ map, experiences, lighting, zoneAlternator }) => ({
      map,
      experiences: experiences ?? [],
      ...(lighting ? { lighting } : {}),
      ...(zoneAlternator ? { zoneAlternator } : {}),
    })),
    editable: false,
    note: "",
    currentIndex,
    nextIndex,
    positionNote: "",
    currentMap,
    enabled: rotation.enabled,
    mode: rotation.mode,
  };
}
