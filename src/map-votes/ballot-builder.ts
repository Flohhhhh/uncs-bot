import { createHash } from "node:crypto";
import { sameMap } from "../common/map-labels";
import { planMapNext } from "../admin/server-configuration";
import {
  voteChoiceKey,
  voteModeKey,
  type MapNextPlacement,
  type VoteChoice,
  type VotingPolicy,
  type VotingSettings,
} from "../common/voting-policy";
import type { MapSelection } from "../common/server-settings";

/** Identifies the saved rotation's order and contents, ignoring unrelated configuration revisions. */
export function rotationFingerprint(rotation: { enabled: boolean; mode: string; entries: MapSelection[] }) {
  return createHash("sha256")
    .update(JSON.stringify([rotation.enabled, rotation.mode, rotation.entries.map(voteChoiceKey)]))
    .digest("hex");
}

export type BallotOption = {
  choice: VoteChoice;
  kind: "map" | "variant" | "fifty";
  placement: MapNextPlacement;
};
export type BallotInput = {
  policy: VotingPolicy;
  settings: VotingSettings;
  rotation: { entries: MapSelection[]; currentIndex: number };
  /** checkRotation issues; those rows are never offered. */
  issues: { index: number }[];
  /** The game's reported next index, which confirms a wrap to the first row. */
  statusNextIndex: number | null | undefined;
  /** Newest first: the running map of recent ballots, and whether each was automatic. */
  history: { currentMap: string; automatic: boolean }[];
  /** voteChoiceKey of pool entries the current catalog no longer offers. */
  unavailablePool?: ReadonlySet<string>;
};
export type BallotPlan = {
  options: BallotOption[];
  notes: string[];
  nextSlot: number;
  next: MapSelection | null;
};

/**
 * Chooses automatic ballot options. Never offers the running option (same map and rule set), never
 * invents experience IDs, and never offers an option whose placement would grow the rotation by
 * appending after its last row.
 */
export function buildBallot(input: BallotInput): BallotPlan {
  const { policy, settings } = input;
  const entries = input.rotation.entries;
  const currentIndex = input.rotation.currentIndex;
  const current = entries[currentIndex];
  const length = entries.length;
  const nextSlot = currentIndex >= length - 1 ? (input.statusNextIndex === 0 ? 0 : length) : currentIndex + 1;
  const notes: string[] = [];
  const plan = { nextSlot, next: nextSlot < length ? entries[nextSlot] : null };
  if (!current) return { ...plan, options: [], notes: ["The running rotation entry could not be read."] };
  const runningMode = voteModeKey(current);
  const kindOf = (entry: MapSelection): BallotOption["kind"] | null => {
    const sameRules = voteModeKey(entry) === runningMode;
    if (sameMap(entry.map, current.map)) {
      // The running option is never offered; other rule variants need mode choices.
      if (sameRules || !policy.modeChoices) return null;
      return policy.mapChoices && settings.excludeCurrentMap ? null : "variant";
    }
    if (!policy.mapChoices || (!policy.modeChoices && !sameRules)) return null;
    return "map";
  };
  const candidates: BallotOption[] = [];
  let skippedAppend = 0;
  const consider = (entry: MapSelection) => {
    const kind = kindOf(entry);
    if (!kind) return;
    // One option per map and rule set; lighting/layout variants do not fill every button.
    if (
      candidates.some(
        (option) => sameMap(option.choice.map, entry.map) && voteModeKey(option.choice) === voteModeKey(entry),
      )
    )
      return;
    const { placement } = planMapNext(entries, currentIndex, input.statusNextIndex, entry);
    if (placement === "append") {
      skippedAppend++;
      return;
    }
    candidates.push({ choice: entry, kind, placement });
  };
  if (settings.source === "rotation")
    for (let offset = 1; offset < length; offset++) {
      const index = (currentIndex + offset) % length;
      if (input.issues.some((issue) => issue.index === index)) continue;
      consider(entries[index]);
    }
  else {
    // Least recently played first; never-played entries first, ties in saved order.
    const lastPlayed = (entry: MapSelection) => {
      const index = input.history.findIndex((row) => sameMap(row.currentMap, entry.map));
      return index < 0 ? Infinity : index;
    };
    const ordered = settings.pool
      .map((entry, order) => ({ entry, order, played: lastPlayed(entry) }))
      .sort((a, b) => b.played - a.played || a.order - b.order);
    for (const { entry } of ordered) if (!input.unavailablePool?.has(voteChoiceKey(entry))) consider(entry);
  }
  let options = candidates;
  if (settings.excludeRecent > 0) {
    const recent = input.history
      .filter((row) => row.automatic)
      .slice(0, settings.excludeRecent)
      .map((row) => row.currentMap);
    const fresh = candidates.filter((option) => !recent.some((map) => sameMap(map, option.choice.map)));
    if (fresh.length >= 2) options = fresh;
    else if (fresh.length < candidates.length)
      notes.push("Recently played maps were allowed so this ballot has at least two options.");
  }
  options = options.slice(0, settings.optionCount);
  if (options.length < 2) {
    if (!policy.mapChoices && !policy.modeChoices)
      notes.unshift("Only the 50v50 option is switched on, and this version does not offer it yet.");
    else if (skippedAppend > 0 && candidates.length < 2)
      notes.unshift("The game has not confirmed it returns to entry 1 after the last entry, so no option was offered.");
    else
      notes.unshift(
        settings.source === "pool"
          ? "Add at least two available map pool entries that match the voting options."
          : "Add at least two available rotation entries that match the voting options.",
      );
  }
  return { ...plan, options, notes };
}
