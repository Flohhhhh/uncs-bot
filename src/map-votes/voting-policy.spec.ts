import {
  defaultVotingPolicy,
  defaultVotingSettings,
  voteChoiceKey,
  voteChoiceTitle,
  voteModeKey,
  votingScore,
} from "../common/voting-policy";
import { selectionLabel } from "../common/map-labels";
import { validateVotingDocument } from "./voting-settings";

it("leaves automatic voting and both reminders off, and requires an enabled choice type", () => {
  expect(defaultVotingPolicy).toMatchObject({ enabled: false, midpointReminder: false, finalReminder: false });
  expect(defaultVotingSettings.fiftyFifty.offered).toBe(false);
  const valid = (policy: object, fiftyFifty = false) => {
    try {
      validateVotingDocument(
        { ...defaultVotingPolicy, ...policy },
        { ...defaultVotingSettings, fiftyFifty: { ...defaultVotingSettings.fiftyFifty, offered: fiftyFifty } },
      );
      return true;
    } catch {
      return false;
    }
  };
  expect(valid({ enabled: true, mapChoices: false })).toBe(false);
  expect(valid({ enabled: true, mapChoices: false, modeChoices: true })).toBe(true);
  expect(valid({ enabled: true, mapChoices: false }, true)).toBe(true);
  expect(valid({ enabled: false, mapChoices: false })).toBe(true);
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
it("keeps existing choice keys and labels a 50v50 choice everywhere", () => {
  const entry = { map: "NorthAmerica", experiences: ["KOTH"] };
  expect(voteChoiceKey(entry)).toBe(JSON.stringify(["Zestafona", ["KOTH"], "", ""]));
  expect(voteChoiceKey({ ...entry, event: "50v50" })).not.toBe(voteChoiceKey(entry));
  expect(voteChoiceTitle({ ...entry, event: "50v50" })).toBe("Zestafona · King of the Hill · 50v50");
  expect(voteChoiceTitle(entry)).toBe("Zestafona · King of the Hill");
  expect(selectionLabel({ ...entry, event: "50v50" })).toBe("Zestafona · King of the Hill · 50v50 next round");
  expect(selectionLabel(entry)).toBe("Zestafona · King of the Hill");
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
