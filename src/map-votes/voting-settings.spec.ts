import {
  closeReached,
  defaultVotingPolicy,
  defaultVotingSettings,
  votingMilestones,
  votingProgress,
  type VotingPolicy,
  type VotingSettings,
} from "../common/voting-policy";
import {
  ballotWinner,
  mergeSettings,
  readStoredPolicy,
  saveVotingControlsSchema,
  validateVotingDocument,
  votingSettingsPatchSchema,
  VotingSettingsError,
} from "./voting-settings";
import { ballotChoiceSchema, startMapVoteSchema } from "./map-votes.types";

const on: VotingPolicy = { ...defaultVotingPolicy, enabled: true };
function issue(policy: Partial<VotingPolicy>, settings: object) {
  try {
    validateVotingDocument({ ...on, ...policy }, mergeSettings(defaultVotingSettings, settings));
    return null;
  } catch (error) {
    if (!(error instanceof VotingSettingsError)) throw error;
    return error.issue;
  }
}

describe("customizable voting settings", () => {
  it("reads a row saved before settings existed as the recommended defaults", () => {
    const stored = readStoredPolicy({ ...defaultVotingPolicy, enabled: true, finalReminder: true });
    expect(stored.policy).toEqual({ ...defaultVotingPolicy, enabled: true, finalReminder: true });
    expect(stored.settings).toEqual(defaultVotingSettings);
    expect(defaultVotingSettings).toMatchObject({
      optionCount: 3,
      source: "rotation",
      minPlayers: 40,
      openDelaySeconds: 180,
      openScoreCeiling: 70,
      closeAtScore: votingMilestones.close,
      reminders: { midpoint: { score: 50 }, final: { score: 85 } },
      tieRule: "keep_rotation",
      fiftyFifty: { offered: false, minPlayers: 80, minVotes: 5, rounds: 1, autoEnd: true, closedFaction: null },
    });
  });
  it("merges partial stored settings over the defaults and drops keys this build does not know", () => {
    const stored = readStoredPolicy({
      ...defaultVotingPolicy,
      settings: { closeAtScore: 90, reminders: { final: { score: 80 } }, futureSetting: true },
    });
    expect(stored.settings.closeAtScore).toBe(90);
    expect(stored.settings.reminders).toEqual({
      midpoint: defaultVotingSettings.reminders.midpoint,
      final: { ...defaultVotingSettings.reminders.final, score: 80 },
    });
    expect(stored.settings).not.toHaveProperty("futureSetting");
    expect(() => readStoredPolicy({ ...defaultVotingPolicy, settings: { optionCount: 9 } })).toThrow(
      VotingSettingsError,
    );
    expect(() => readStoredPolicy({ enabled: "yes" })).toThrow(VotingSettingsError);
  });
  it("deep-merges a patch and replaces the map pool whole", () => {
    const pool = [
      { map: "Europe", experiences: ["KOTH"] },
      { map: "Kavkazi", experiences: ["KOTH"] },
    ];
    const saved = mergeSettings(defaultVotingSettings, { pool, reminders: { midpoint: { inGame: false } } });
    const next = mergeSettings(saved, { pool: [pool[1]], reminders: { midpoint: { score: 40 } } });
    expect(next.pool).toEqual([pool[1]]);
    expect(next.reminders.midpoint).toEqual({ score: 40, discord: true, inGame: false });
    expect(mergeSettings(saved, undefined)).toEqual(saved);
    expect(mergeSettings(saved, { fiftyFifty: { closedFaction: "Valkyra" } }).fiftyFifty.closedFaction).toBe("Valkyra");
    expect(
      mergeSettings(
        { ...saved, fiftyFifty: { ...saved.fiftyFifty, closedFaction: "Valkyra" } },
        { fiftyFifty: { closedFaction: null } },
      ).fiftyFifty.closedFaction,
    ).toBeNull();
  });
  it.each([
    [
      {},
      { openScoreCeiling: 92 },
      ["settings", "openScoreCeiling"],
      "Close score must be at least 5 points above the opening ceiling.",
    ],
    [
      { midpointReminder: true },
      { reminders: { midpoint: { score: 95 } } },
      ["settings", "reminders", "midpoint", "score"],
      "The update reminder must come before the close score.",
    ],
    [
      { finalReminder: true },
      { closeAtScore: 85 },
      ["settings", "reminders", "final", "score"],
      "The last-chance reminder must come before the close score.",
    ],
    [
      { midpointReminder: true, finalReminder: true },
      { reminders: { midpoint: { score: 85 } } },
      ["settings", "reminders", "midpoint", "score"],
      "The update reminder must come before the last-chance reminder.",
    ],
    [
      { finalReminder: true },
      { reminders: { final: { discord: false, inGame: false } } },
      ["settings", "reminders", "final"],
      "Send the last-chance reminder in Discord, in game, or both.",
    ],
    [
      {},
      { source: "pool", pool: [{ map: "Europe", experiences: [] }] },
      ["settings", "pool"],
      "Add at least two map pool entries, or offer options from the saved rotation.",
    ],
    [
      {},
      {
        pool: [
          { map: "Europe", experiences: ["KOTH"] },
          { map: "Ozeti", experiences: ["KOTH"] },
        ],
      },
      ["settings", "pool"],
      "Each map pool entry must be a different map, mode or layout.",
    ],
    [
      { mapChoices: false, modeChoices: false },
      {},
      ["policy", "mapChoices"],
      "Choose maps, rule variants, 50v50 or a combination before enabling voting.",
    ],
    [
      {},
      { fiftyFifty: { closedFaction: "Bad name!" } },
      ["settings", "fiftyFifty", "closedFaction"],
      "Choose a faction name from the game.",
    ],
    [{}, { optionCount: 6 }, ["settings", "optionCount"], "Options per ballot must be a whole number from 2 to 5."],
    [{}, { optionCount: 1 }, ["settings", "optionCount"], "Options per ballot must be a whole number from 2 to 5."],
    [{}, { minPlayers: 2.5 }, ["settings", "minPlayers"], "Minimum players must be a whole number from 0 to 100."],
  ])("explains invalid settings: %j %j", (policy, settings, path, message) => {
    expect(issue(policy, settings)).toEqual({ path, message });
  });
  it("accepts an off reminder's out-of-order score, only-50v50 voting, and a disabled pool source", () => {
    expect(issue({ midpointReminder: false }, { reminders: { midpoint: { score: 98 } } })).toBeNull();
    expect(issue({ mapChoices: false, modeChoices: false }, { fiftyFifty: { offered: true } })).toBeNull();
    expect(issue({ enabled: false }, { source: "pool" })).toBeNull();
    expect(issue({}, { openScoreCeiling: 90, closeAtScore: 95 })).toBeNull();
  });
  it("accepts any subset of settings in a save, strictly", () => {
    expect(votingSettingsPatchSchema.safeParse({ reminders: { final: { score: 80 } } }).success).toBe(true);
    expect(votingSettingsPatchSchema.safeParse({ reminders: { final: { colour: "red" } } }).success).toBe(false);
    expect(votingSettingsPatchSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(
      saveVotingControlsSchema.safeParse({ serverId: "primary", version: 0, policy: defaultVotingPolicy }).success,
    ).toBe(true);
    expect(
      saveVotingControlsSchema.safeParse({
        serverId: "primary",
        version: 0,
        policy: { ...defaultVotingPolicy, settings: {} },
      }).success,
    ).toBe(false);
  });
  it("marks a 50v50 option only on an explicit literal", () => {
    expect(ballotChoiceSchema.safeParse({ map: "Europe", experiences: [], event: "50v50" }).success).toBe(true);
    expect(ballotChoiceSchema.safeParse({ map: "Europe", experiences: [], event: "40v60" }).success).toBe(false);
    const choices = [
      { map: "Europe", experiences: [] },
      { map: "Europe", experiences: [], event: "50v50" },
    ];
    expect(
      startMapVoteSchema.safeParse({
        id: "d0a3cdd7-a1c7-4904-a99e-cf058b432c34",
        serverId: "primary",
        revision: "r1",
        choices,
        minutes: 5,
        reason: "Community choice",
      }).success,
    ).toBe(true);
  });
});

describe("ballot results", () => {
  it("keeps the rotation on a tie unless the first tied option should win", () => {
    expect(ballotWinner([0, 0])).toBeNull();
    expect(ballotWinner([2, 2, 1])).toBeNull();
    expect(ballotWinner([0, 5, 4])).toBe(1);
    expect(ballotWinner([2, 2, 1], "first_option")).toBe(0);
    expect(ballotWinner([1, 3, 3], "first_option")).toBe(1);
    expect(ballotWinner([0, 0, 0], "first_option")).toBeNull();
  });
  it("never lets the 50v50 option win a tie", () => {
    expect(ballotWinner([3, 1, 3], "first_option", 0)).toBe(2);
    expect(ballotWinner([3, 3], "first_option", 0)).toBe(1);
    expect(ballotWinner([2, 4, 4], "first_option", 2)).toBe(1);
    expect(ballotWinner([2, 1, 5], "first_option", 2)).toBe(2);
    expect(ballotWinner([2, 2, 1], "keep_rotation", 2)).toBeNull();
  });
  it("measures progress in points out of 100, scaling a reported cap", () => {
    const factionScores = [
      { name: "Lonestar", score: 100 },
      { name: "Manticore", score: 40 },
      { name: "Valkyra", score: 20 },
    ];
    expect(votingProgress({ factionScores })).toBe(100);
    expect(votingProgress({ factionScores, scoreCap: 200 })).toBe(50);
    expect(
      votingProgress({
        factionScores: [
          { name: "A", score: 0 },
          { name: "B", score: 0 },
        ],
      }),
    ).toBe(0);
    expect(
      votingProgress({
        factionScores: [
          { name: "A", score: 201 },
          { name: "B", score: 0 },
        ],
        scoreCap: 200,
      }),
    ).toBeNull();
    expect(votingProgress({ factionScores, scoreCap: 0 })).toBeNull();
  });
  it("closes at the configured score or one observed scoring step early", () => {
    const settings: VotingSettings = { ...defaultVotingSettings, closeAtScore: 90 };
    expect(closeReached({ settings }, 89)).toBe(false);
    expect(closeReached({ settings }, 90)).toBe(true);
    expect(closeReached({ settings, maxStep: 12 }, 88)).toBe(true);
    expect(closeReached({ settings, maxStep: 12 }, 79)).toBe(false);
    expect(closeReached({ settings, maxStep: 5 }, 88)).toBe(false);
    expect(closeReached({}, 94)).toBe(false);
    expect(closeReached({}, 95)).toBe(true);
  });
});
