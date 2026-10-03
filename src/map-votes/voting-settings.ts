import { z } from "zod";
import { mapSelectionSchema } from "../admin/admin.types";
import {
  defaultVotingSettings,
  settingRangeMessage,
  votingIssues,
  votingSettingLimits as limits,
  type DeepPartial,
  type StoredVotingPolicy,
  type VoteTieRule,
  type VotingIssue,
  type VotingPolicy,
  type VotingRules,
  type VotingSettings,
} from "../common/voting-policy";
export { votingIssues, type VotingIssue, type VotingRules } from "../common/voting-policy";

const whole = ({ min, max }: { min: number; max: number }, label: string) => {
  const error = settingRangeMessage(label, { min, max });
  return z.number({ error }).int({ error }).min(min, { error }).max(max, { error });
};
const flag = (label: string) => z.boolean({ error: `Choose on or off for ${label}.` });
const reminderSchema = z
  .object({
    score: whole(limits.reminderScore, "Reminder score"),
    discord: flag("the Discord reminder"),
    inGame: flag("the in-game reminder"),
  })
  .strict();
const announceSchema = z
  .object({ openInGame: flag("the opening announcement"), resultInGame: flag("the result announcement") })
  .strict();
const fiftyFiftySchema = z
  .object({
    offered: flag("the 50v50 option"),
    minPlayers: whole(limits.fiftyFifty.minPlayers, "Players needed for 50v50"),
    minVotes: whole(limits.fiftyFifty.minVotes, "Votes needed for 50v50"),
    closedFaction: z
      .string()
      .regex(/^[\w./-]{1,150}$/, { error: "Choose a faction name from the game." })
      .nullable(),
    warningSeconds: whole(limits.fiftyFifty.warningSeconds, "50v50 warning time"),
    balanceWindowSeconds: whole(limits.fiftyFifty.balanceWindowSeconds, "50v50 balance window"),
    forceRespawn: flag("forced respawn"),
    rounds: whole(limits.fiftyFifty.rounds, "50v50 rounds"),
    autoEnd: flag("ending 50v50 automatically"),
    cooldownRounds: whole(limits.fiftyFifty.cooldownRounds, "Rounds between 50v50s"),
    maxRoundMinutes: whole(limits.fiftyFifty.maxRoundMinutes, "50v50 safety limit"),
  })
  .strict();
export const votingSettingsShape = z
  .object({
    optionCount: whole(limits.optionCount, "Options per ballot"),
    source: z.enum(["rotation", "pool"], { error: "Choose the saved rotation or the map pool." }),
    pool: z
      .array(mapSelectionSchema)
      .max(limits.poolSize.max, { error: `Keep the map pool to ${limits.poolSize.max} entries or fewer.` }),
    excludeCurrentMap: flag("skipping the running map"),
    excludeRecent: whole(limits.excludeRecent, "Recent maps to skip"),
    minPlayers: whole(limits.minPlayers, "Minimum players"),
    openDelaySeconds: whole(limits.openDelaySeconds, "Opening delay"),
    openScoreCeiling: whole(limits.openScoreCeiling, "Opening score limit"),
    closeAtScore: whole(limits.closeAtScore, "Close score"),
    reminders: z.object({ midpoint: reminderSchema, final: reminderSchema }).strict(),
    announce: announceSchema,
    tieRule: z.enum(["keep_rotation", "first_option"], { error: "Choose how a tie is settled." }),
    fiftyFifty: fiftyFiftySchema,
  })
  .strict();
/** A dashboard draft or save: any subset of settings. Arrays such as `pool` replace the saved value whole. */
export const votingSettingsPatchSchema = votingSettingsShape
  .extend({
    reminders: z
      .object({ midpoint: reminderSchema.partial().strict(), final: reminderSchema.partial().strict() })
      .partial()
      .strict(),
    announce: announceSchema.partial().strict(),
    fiftyFifty: fiftyFiftySchema.partial().strict(),
  })
  .partial()
  .strict();
export type VotingSettingsPatch = z.infer<typeof votingSettingsPatchSchema>;
/** The five original switches. Their cross-field rule is checked after merging with saved settings. */
export const votingPolicyShape = z
  .object({
    enabled: z.boolean(),
    mapChoices: z.boolean(),
    modeChoices: z.boolean(),
    midpointReminder: z.boolean(),
    finalReminder: z.boolean(),
  })
  .strict();
export const saveVotingControlsSchema = z
  .object({
    serverId: z.string(),
    version: z.number().int().nonnegative(),
    policy: votingPolicyShape,
    settings: votingSettingsPatchSchema.optional(),
  })
  .strict();

export class VotingSettingsError extends Error {
  constructor(readonly issue: VotingIssue) {
    super(issue.message);
  }
}
function firstIssue(error: z.ZodError): VotingIssue {
  const [issue] = error.issues;
  return { path: issue.path.map((part) => (typeof part === "number" ? part : String(part))), message: issue.message };
}
/**
 * Fully validates a merged document. Throws VotingSettingsError naming the first problem. Saves pass
 * `fiftyHeld`; reading a stored row does not, so an older offered 50v50 never stops ordinary voting.
 */
export function validateVotingDocument(policy: unknown, settings: unknown, rules: VotingRules = {}) {
  const parsedPolicy = votingPolicyShape.safeParse(policy);
  if (!parsedPolicy.success) {
    const issue = firstIssue(parsedPolicy.error);
    throw new VotingSettingsError({ ...issue, path: ["policy", ...issue.path] });
  }
  const parsedSettings = votingSettingsShape.safeParse(settings);
  if (!parsedSettings.success) {
    const issue = firstIssue(parsedSettings.error);
    throw new VotingSettingsError({ ...issue, path: ["settings", ...issue.path] });
  }
  const [issue] = votingIssues(parsedPolicy.data, parsedSettings.data, rules);
  if (issue) throw new VotingSettingsError(issue);
  return { policy: parsedPolicy.data, settings: parsedSettings.data };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * Deep-merge `patch` over `base`. Only keys present in `base` survive, so keys written by a newer
 * build are dropped instead of failing validation. Arrays and null replace whole.
 */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T;
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base))
    if (patch[key] !== undefined) merged[key] = isRecord(base[key]) ? mergeSettings(base[key], patch[key]) : patch[key];
  return merged as T;
}
/** Reads a saved row: the five switches plus normalized settings. Throws when the saved document is invalid. */
export function readStoredPolicy(raw: unknown): { policy: VotingPolicy; settings: VotingSettings } {
  const stored = isRecord(raw) ? raw : {};
  const policy = Object.fromEntries(
    (["enabled", "mapChoices", "modeChoices", "midpointReminder", "finalReminder"] as const).map((key) => [
      key,
      stored[key],
    ]),
  );
  return validateVotingDocument(policy, mergeSettings(defaultVotingSettings, stored.settings));
}
/** The jsonb document written for a validated policy. */
export function storedPolicy(policy: VotingPolicy, settings: VotingSettings): StoredVotingPolicy {
  return { ...policy, settings };
}
export function mergeVotingSettings(base: VotingSettings, patch: DeepPartial<VotingSettings> | undefined) {
  return mergeSettings(base, patch);
}

/**
 * Winner index or null. A tie keeps the rotation unless `first_option` is chosen; then the lowest
 * numbered tied leader wins, except the 50v50 option, which must win outright.
 */
export function ballotWinner(counts: number[], tieRule: VoteTieRule = "keep_rotation", fiftyIndex?: number | null) {
  const maximum = Math.max(0, ...counts);
  if (maximum <= 0) return null;
  const leaders = counts.flatMap((count, index) => (count === maximum ? [index] : []));
  if (leaders.length === 1) return leaders[0];
  if (tieRule !== "first_option") return null;
  return leaders.find((index) => index !== fiftyIndex) ?? null;
}
