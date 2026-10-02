import { buildBallot, rotationFingerprint, type BallotInput } from "./ballot-builder";
import {
  defaultVotingPolicy,
  defaultVotingSettings,
  voteChoiceKey,
  type VotingPolicy,
  type VotingSettings,
} from "../common/voting-policy";
import type { MapSelection } from "../common/server-settings";

const normal = { map: "Kavkazi", experiences: ["KOTH"] };
const normalDusk = { map: "Kavkazi", experiences: ["KOTH"], lighting: "DayEndClear" };
const infantry = { map: "Kavkazi", experiences: ["KOTH", "KOTH_InfantryOnly"] };
const hardcore = { map: "Kavkazi", experiences: ["KOTH", "KOTH_Hardcore"] };
const ozeti = { map: "Europe", experiences: ["KOTH"] };
const ozetiInfantry = { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] };
const zestafona = { map: "NorthAmerica", experiences: ["KOTH"] };
const zestafonaDusk = { map: "NorthAmerica", experiences: ["KOTH"], lighting: "DayEndClear" };

function ballot(
  entries: MapSelection[],
  currentIndex = 0,
  policy: Partial<VotingPolicy> = {},
  settings: Partial<VotingSettings> = {},
  patch: Partial<BallotInput> = {},
) {
  return buildBallot({
    policy: { ...defaultVotingPolicy, enabled: true, ...policy },
    settings: { ...defaultVotingSettings, optionCount: 5, ...settings },
    rotation: { entries, currentIndex },
    issues: [],
    statusNextIndex: null,
    history: [],
    ...patch,
  });
}
const offered = (plan: ReturnType<typeof buildBallot>) => plan.options.map((option) => option.choice);

describe("automatic ballot options", () => {
  it("never offers the running option, even with other lighting", () => {
    const plan = ballot([normal, ozeti, infantry, normalDusk, hardcore], 0, { mapChoices: false, modeChoices: true });
    expect(offered(plan)).toEqual([infantry, hardcore]);
    expect(plan.options.map((option) => option.kind)).toEqual(["variant", "variant"]);
  });
  it("skips every entry on the running map in map ballots unless told otherwise", () => {
    const entries = [normal, ozeti, infantry, zestafona, ozetiInfantry];
    expect(offered(ballot(entries, 0, { modeChoices: true }))).toEqual([ozeti, zestafona, ozetiInfantry]);
    expect(offered(ballot(entries, 0, { modeChoices: true }, { excludeCurrentMap: false }))).toEqual([
      ozeti,
      infantry,
      zestafona,
      ozetiInfantry,
    ]);
  });
  it("keeps the running rule set when only maps are offered, and the running map when only variants are", () => {
    const entries = [normal, ozetiInfantry, infantry, zestafona, ozeti];
    expect(offered(ballot(entries, 0, { mapChoices: true, modeChoices: false }))).toEqual([zestafona, ozeti]);
    // "Never offer the running map" applies to map ballots only.
    expect(offered(ballot(entries, 0, { mapChoices: false, modeChoices: true }, { excludeCurrentMap: true }))).toEqual([
      infantry,
    ]);
  });
  it("explains that a 50v50-only ballot is not available yet", () => {
    const plan = ballot([normal, ozeti, zestafona], 0, { mapChoices: false, modeChoices: false });
    expect(plan.options).toEqual([]);
    expect(plan.notes[0]).toContain("50v50");
  });
  it("walks forward nearest first, skips unavailable rows and offers one entry per map and rule set", () => {
    const plan = ballot([zestafona, normal, zestafonaDusk, ozeti, zestafona], 1, {}, {}, { issues: [{ index: 3 }] });
    expect(offered(plan)).toEqual([zestafonaDusk]);
    expect(plan.notes[0]).toContain("at least two available rotation entries");
    expect(offered(ballot([zestafona, normal, zestafonaDusk, ozeti], 1))).toEqual([zestafonaDusk, ozeti]);
  });
  it("relaxes recent-map skipping when it would leave fewer than two options", () => {
    const entries = [normal, ozeti, zestafona, ozetiInfantry];
    const history = [
      { currentMap: "Bakurani", automatic: true },
      { currentMap: "Ozeti", automatic: true },
      { currentMap: "NorthAmerica", automatic: false },
    ];
    const recent = ballot(entries, 0, { modeChoices: true }, { excludeRecent: 2 }, { history });
    expect(offered(recent)).toEqual([ozeti, zestafona, ozetiInfantry]);
    expect(recent.notes).toEqual(["Recently played maps were allowed so this ballot has at least two options."]);
    const enough = ballot(
      [normal, ozeti, zestafona, infantry, { map: "Islands", experiences: ["KOTH"] }],
      0,
      {},
      {
        excludeRecent: 2,
      },
      { history: [{ currentMap: "Ozeti", automatic: true }] },
    );
    expect(offered(enough).map((choice) => choice.map)).toEqual(["NorthAmerica", "Islands"]);
  });
  it("counts options against the configured ballot size", () => {
    const entries = [normal, ozeti, zestafona, { map: "Islands", experiences: ["KOTH"] }];
    expect(offered(ballot(entries, 0, {}, { optionCount: 2 }))).toEqual([ozeti, zestafona]);
  });
  it("orders the map pool least recently played first and inserts entries missing from the rotation", () => {
    const islands = { map: "Islands", experiences: ["KOTH"] };
    const plan = ballot(
      [normal, ozeti],
      0,
      { modeChoices: true },
      { source: "pool", pool: [ozeti, zestafona, islands, ozetiInfantry, normal] },
      {
        history: [
          { currentMap: "Kavkazi", automatic: true },
          { currentMap: "Ozeti", automatic: true },
          { currentMap: "Zestafona", automatic: true },
        ],
        unavailablePool: new Set([voteChoiceKey(islands)]),
      },
    );
    expect(offered(plan)).toEqual([zestafona, ozeti, ozetiInfantry]);
    expect(plan.options.map((option) => option.placement)).toEqual(["insert", "already-next", "insert"]);
  });
  it("offers only placements that keep the rotation size after its last entry", () => {
    const entries = [ozeti, zestafona, infantry, normal];
    const unconfirmed = ballot(entries, 3, { modeChoices: true }, { excludeCurrentMap: false });
    expect(unconfirmed.options).toEqual([]);
    expect(unconfirmed.nextSlot).toBe(4);
    expect(unconfirmed.next).toBeNull();
    expect(unconfirmed.notes[0]).toContain("returns to entry 1");
    const wrap = ballot(entries, 3, { modeChoices: true }, { excludeCurrentMap: false }, { statusNextIndex: 0 });
    expect(wrap.options.map((option) => [option.choice, option.placement])).toEqual([
      [ozeti, "already-next"],
      [zestafona, "swap"],
      [infantry, "swap"],
    ]);
    expect(wrap.next).toEqual(ozeti);
    const pool = ballot(
      entries,
      3,
      {},
      { source: "pool", pool: [ozeti, { map: "Islands", experiences: ["KOTH"] }] },
      {
        statusNextIndex: 0,
      },
    );
    expect(offered(pool)).toEqual([ozeti]);
  });
  it("fingerprints the rotation contents and order, not unrelated settings", () => {
    const rotation = { enabled: true, mode: "Ordered", entries: [normal, ozeti] };
    expect(rotationFingerprint(rotation)).toBe(rotationFingerprint({ ...rotation, entries: [{ ...normal }, ozeti] }));
    expect(rotationFingerprint(rotation)).not.toBe(rotationFingerprint({ ...rotation, entries: [ozeti, normal] }));
    expect(rotationFingerprint(rotation)).not.toBe(rotationFingerprint({ ...rotation, mode: "Random" }));
  });
});
