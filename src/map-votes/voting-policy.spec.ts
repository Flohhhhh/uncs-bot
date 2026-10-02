import { defaultVotingPolicy, voteChoiceKey, voteModeKey, votingScore } from "../common/voting-policy";
import { votingPolicySchema } from "./map-votes.types";

it("leaves automatic voting and both reminders off, and requires an enabled choice type", () => {
  expect(defaultVotingPolicy).toMatchObject({ enabled: false, midpointReminder: false, finalReminder: false });
  expect(votingPolicySchema.safeParse({ ...defaultVotingPolicy, enabled: true, mapChoices: false }).success).toBe(
    false,
  );
  expect(
    votingPolicySchema.safeParse({ ...defaultVotingPolicy, enabled: true, mapChoices: false, modeChoices: true })
      .success,
  ).toBe(true);
});
it("distinguishes mode/layout choices while normalizing aliases and modifier order", () => {
  const a = { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] };
  expect(voteChoiceKey(a)).toBe(
    voteChoiceKey({ map: "Ozeti", experiences: [...a.experiences].reverse(), zoneAlternator: "None" }),
  );
  expect(voteChoiceKey(a)).not.toBe(voteChoiceKey({ ...a, experiences: ["KOTH"] }));
  expect(voteChoiceKey(a)).not.toBe(voteChoiceKey({ ...a, zoneAlternator: "Zone.Farmland" }));
  expect(voteModeKey({ map: "Europe", experiences: ["Madrid_KOTH_01"] })).toBe(
    voteModeKey({ map: "Kavkazi", experiences: ["Bakurani_KOTH_01"] }),
  );
});
it.each([
  undefined,
  [],
  [{ name: "A", score: 50 }],
  [
    { name: "A", score: 50 },
    { name: "A", score: 10 },
  ],
  [
    { name: "A", score: NaN },
    { name: "B", score: 10 },
  ],
  [
    { name: "A", score: -1 },
    { name: "B", score: 10 },
  ],
])("does not invent match progress from incomplete scores: %j", (factionScores) => {
  expect(votingScore({ factionScores })).toBeNull();
});
it("uses the leading score, not the sum, and refuses a different reported win target", () => {
  const factionScores = [
    { name: "A", score: 50 },
    { name: "B", score: 40 },
    { name: "C", score: 20 },
  ];
  expect(votingScore({ factionScores })).toBe(50);
  expect(votingScore({ factionScores, scoreCap: 200 })).toBeNull();
});
