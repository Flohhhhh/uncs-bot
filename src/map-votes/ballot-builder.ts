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
  /** Whether every 50v50 readiness check passed, or why not. Omitted when 50v50 is not offered. */
  fifty?: { ready: boolean; reason: string };
};
export type BallotPlan = {
  options: BallotOption[];
  notes: string[];
  nextSlot: number;
  next: MapSelection | null;
  /** Whether the ballot ends with the 50v50 option, or why it does not. */
  fifty: { offered: boolean; reason: string };
};

/**
 * Chooses automatic ballot options. Never offers the running option (same map and rule set), never
 * invents experience IDs, and never offers an option whose placement would grow the rotation by
 * appending after its last row. A ready 50v50 option is always last: the next rotation entry played
 * as 50v50, which needs no queue change.
 */
export function buildBallot(input: BallotInput): BallotPlan {
  const { policy, settings } = input;
  const entries = input.rotation.entries;
  const currentIndex = input.rotation.currentIndex;
  const current = entries[currentIndex];
  const length = entries.length;
  const nextSlot = currentIndex >= length - 1 ? (input.statusNextIndex === 0 ? 0 : length) : currentIndex + 1;
  const notes: string[] = [];
  const next = nextSlot < length ? entries[nextSlot] : null;
  const fifty = !settings.fiftyFifty.offered
    ? { offered: false, reason: "The 50v50 option is off." }
    : !input.fifty?.ready
      ? { offered: false, reason: `50v50 not offered: ${input.fifty?.reason ?? "it was not checked"}.` }
      : !next || input.issues.some((issue) => issue.index === nextSlot)
        ? { offered: false, reason: "50v50 not offered: the next rotation entry is not available." }
        : { offered: true, reason: "Offered as the last option." };
  const plan = { nextSlot, next, fifty };
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
  const fiftyOption: BallotOption | null =
    fifty.offered && next ? { choice: { ...next, event: "50v50" }, kind: "fifty", placement: "already-next" } : null;
  if (!policy.mapChoices && !policy.modeChoices)
    // Only 50v50 is switched on: normal teams on the next entry, or that entry as 50v50.
    options = fiftyOption ? [{ choice: next!, kind: "map", placement: "already-next" }, fiftyOption] : [];
  else if (fiftyOption) {
    options = options.slice(0, settings.optionCount - 1);
    // A 50v50 option needs at least one normal choice beside it.
    options = options.length ? [...options, fiftyOption] : [];
  } else options = options.slice(0, settings.optionCount);
  if (options.length < 2) {
    if (!policy.mapChoices && !policy.modeChoices)
      notes.unshift(
        `Only the 50v50 option is switched on, and it cannot be offered now. ${fifty.offered ? "" : fifty.reason}`.trim(),
      );
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
