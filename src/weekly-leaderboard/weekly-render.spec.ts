import { MessageFlags } from "discord.js";
import type { CombatStats, WeeklyHighlights } from "../telemetry/telemetry.types";
import { emptyHighlights } from "../telemetry/telemetry.types";
import { FIXTURE_IDS, FIXTURE_SLOT, fixtureAggregate, fixtureHighlights, fixtureRows } from "./weekly-fixtures";
import {
  DISCORD_CONTENT_LIMIT,
  causeLabel,
  discordName,
  hasWeeklyMarker,
  mapName,
  renderWeeklyBoard,
  shoutOuts,
  weeklyMarker,
  type WeeklyBoardInput,
} from "./weekly-render";
import { weekEndingAt } from "./weekly-schedule";

const window = weekEndingAt(FIXTURE_SLOT, { day: "sunday", time: "20:00" });
const input = (overrides: Partial<WeeklyBoardInput> = {}): WeeklyBoardInput => ({
  serverName: "The UNCs",
  showServerName: false,
  slot: FIXTURE_SLOT,
  window,
  trackingStartedAt: new Date("2026-09-20T18:00:00Z"),
  rows: fixtureAggregate().leaderboard,
  highlights: fixtureHighlights(),
  ...overrides,
});
const stats = (steamId: string, name: string, kills: number, deaths = 10): CombatStats => ({
  steamId,
  name,
  kills,
  deaths,
  headshotKills: 0,
  kd: null,
});
const labels = (highlights: Partial<WeeklyHighlights>) =>
  shoutOuts({ ...emptyHighlights(), ...highlights }).map((shout) => `${shout.label}: ${shout.text}`);
const STEAM_ID_RUN = /\d{17}/;

describe("weekly board renderer", () => {
  it("renders the draft copy from a realistic week", () => {
    const message = renderWeeklyBoard(input());
    expect(message.content).toBe(
      [
        "**The UNCs · Weekly board** · week ending Sun, Oct 4",
        "Good games, older knees. Here's how the week shook out.",
        "",
        "**Top 5 by kills**",
        "1. Grandpa Joe — 87 kills · K/D 2.35",
        "2. NapTime — 74 kills · K/D 1.90",
        "3. Unnamed player — 61 kills · K/D 1.22",
        "4. LowerBack — 58 kills · K/D 3.41",
        "5. Reading Glasses — 52 kills · K/D 0.96",
        "",
        "**This week's shout-outs**",
        "Still got it: LowerBack, K/D 3.41 over 58 kills",
        "Reading glasses not required: NapTime, 21 headshot kills",
        "Long-distance call: Reading Glasses, 412 m with M1 Garand on Zestafona",
        "Old faithful: M1 Garand, 304 kills",
        "Where the knees hurt most: Zestafona, 512 kills",
        "",
        "Stretch, hydrate, run it back. Full board: https://theuncsgaming.com/leaderboard",
        "-# Counted from game events Gramps received <t:1790553600:f> – <t:1791158400:f>; delayed or missing deliveries aren't included. Weekly board 2026-W40 · The UNCs",
      ].join("\n"),
    );
    expect(message.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
    expect(message.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(message.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(message.content).not.toMatch(STEAM_ID_RUN);
    expect(hasWeeklyMarker(message.content, weeklyMarker("2026-W40", "The UNCs"))).toBe(true);
  });

  it("notes partial coverage, names the server when several are configured and keeps the marker last", () => {
    const message = renderWeeklyBoard(
      input({ serverName: "The UNCs East", showServerName: true, trackingStartedAt: new Date("2026-10-01T15:00:00Z") }),
    );
    const lines = message.content.split("\n");
    expect(lines[0]).toBe("**The UNCs · Weekly board · The UNCs East** · week ending Sun, Oct 4");
    expect(lines.at(-2)).toBe("-# Counting since <t:1790866800:f>");
    const marker = weeklyMarker("2026-W40", "The UNCs East");
    expect(lines.at(-1)!.endsWith(` ${marker}`)).toBe(true);
    expect(hasWeeklyMarker(message.content, marker)).toBe(true);
    // A server whose name extends another's never matches the shorter marker, and the week must match.
    expect(hasWeeklyMarker(message.content, weeklyMarker("2026-W40", "The UNCs"))).toBe(false);
    expect(hasWeeklyMarker(message.content, weeklyMarker("2026-W41", "The UNCs East"))).toBe(false);
    expect(hasWeeklyMarker(`${message.content}\nEdited later`, marker)).toBe(false);
  });

  it("never prints a SteamID: fallbacks, embedded IDs, other 17-digit runs and names that sanitise away", () => {
    const own = FIXTURE_IDS[0];
    const cases: Array<[string, string]> = [
      [own, own],
      [FIXTURE_IDS[1], `Tag ${FIXTURE_IDS[1]}`],
      [FIXTURE_IDS[2], "76561198999999999"],
      [FIXTURE_IDS[3], "clan|76561198999999998|x"],
      // Fullwidth digits read as a SteamID too.
      [FIXTURE_IDS[4], [..."76561198000000001"].map((digit) => String.fromCodePoint(0xff10 + Number(digit))).join("")],
      [FIXTURE_IDS[5], ""],
      [FIXTURE_IDS[6], "   "],
      [FIXTURE_IDS[7], "@@@ ***"],
      [FIXTURE_IDS[8], "Unknown"],
    ];
    for (const [steamId, name] of cases) expect(discordName(steamId, name)).toBe("Unnamed player");
    expect(discordName(FIXTURE_IDS[9], null)).toBe("Unnamed player");
    const rows = cases.map(([steamId, name], index) => stats(steamId, name, 50 - index));
    const message = renderWeeklyBoard(
      input({
        rows,
        highlights: {
          ...fixtureHighlights(),
          bestKd: { steamId: own, name: own, kills: 40, deaths: 3 },
          mostHeadshots: { steamId: FIXTURE_IDS[1], name: `x${FIXTURE_IDS[1]}`, headshotKills: 9 },
          longestKill: {
            steamId: FIXTURE_IDS[2],
            name: FIXTURE_IDS[2],
            distanceCentimeters: 30_000,
            cause: "76561198000000099",
            mapName: "76561198000000098",
          },
          topCause: { cause: "76561198000000097", kills: 300 },
        },
      }),
    );
    expect(message.content).not.toMatch(STEAM_ID_RUN);
    expect(message.content).not.toMatch(/\p{Nd}{17}/u);
    for (const id of FIXTURE_IDS) expect(message.content).not.toContain(id);
    expect(message.content).toContain("Still got it: Unnamed player, K/D 13.33 over 40 kills");
    expect(message.content).toContain("Long-distance call: Unnamed player, 300 m\n");
    expect(message.content).not.toContain("Old faithful");
  });

  it("strips mentions, markdown, links and line breaks from game-controlled labels", () => {
    expect(discordName(FIXTURE_IDS[0], "`code` ||spoiler||")).toBe("code spoiler");
    expect(discordName(FIXTURE_IDS[0], "# Heading")).toBe("Heading");
    expect(discordName(FIXTURE_IDS[0], "-# tiny")).toBe("- tiny");
    expect(discordName(FIXTURE_IDS[0], "xX_Sniper_Xx")).toBe("xX Sniper Xx");
    expect(discordName(FIXTURE_IDS[0], "N".repeat(40))).toBe("N".repeat(32));
    const hostile = [
      "@everyone",
      // A Discord user ID is 17-20 digits, so a raw mention reads as an identifier and is not shown.
      "<@123456789012345678>",
      "**Bold** __under__ ~~gone~~",
      "[click](https://evil.example/x)",
      "line\nbreak\rhere",
    ];
    const rows = hostile.map((name, index) => stats(FIXTURE_IDS[index], name, 40 - index));
    const message = renderWeeklyBoard(
      input({
        rows,
        highlights: {
          ...fixtureHighlights(),
          longestKill: {
            steamId: FIXTURE_IDS[0],
            name: "@here",
            distanceCentimeters: 12_000,
            cause: "<:rifle:123456789012345678>",
            mapName: "**Zest**\n> quote",
          },
        },
      }),
    );
    expect(message.content.split("\n").slice(4, 9)).toEqual([
      "1. everyone — 40 kills · K/D 4.00",
      "2. Unnamed player — 39 kills · K/D 3.90",
      "3. Bold under gone — 38 kills · K/D 3.80",
      "4. click https evil example x — 37 kills · K/D 3.70",
      "5. line break here — 36 kills · K/D 3.60",
    ]);
    expect(message.content).toContain("Long-distance call: here, 120 m on Zest quote\n");
    expect(message.content).not.toMatch(/@|<[@#:]|\]\(|\|\||`|\*\*Zest|~~|__/);
    expect(message.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
  });

  it("stays within Discord's 2,000 characters with the longest labels allowed", () => {
    const long = "W".repeat(500);
    const rows = Array.from({ length: 100 }, (_, index) =>
      stats(FIXTURE_IDS[index % 23], `${long}${index}`, 1_000 - index),
    );
    const message = renderWeeklyBoard(
      input({
        serverName: "S".repeat(80),
        showServerName: true,
        trackingStartedAt: new Date(window.start.getTime() + 1),
        rows,
        highlights: {
          bestKd: { steamId: FIXTURE_IDS[0], name: long, kills: 99_999, deaths: 1 },
          mostHeadshots: { steamId: FIXTURE_IDS[1], name: long, headshotKills: 99_999 },
          longestKill: {
            steamId: FIXTURE_IDS[2],
            name: long,
            distanceCentimeters: 199_999,
            cause: long,
            mapName: long,
          },
          kills: 99_999,
          killsWithCause: 99_999,
          topCause: { cause: long, kills: 99_999 },
          maps: [
            { mapName: long, kills: 99_999 },
            { mapName: "Europe", kills: 5 },
          ],
        },
      }),
    );
    expect(message.content.split("\n").filter((line) => /^\d\. /.test(line))).toHaveLength(5);
    expect(message.content.split("\n").filter((line) => /: /.test(line) && !/^-#|^Stretch/.test(line))).toHaveLength(5);
    expect(message.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });

  it("shows a dash for K/D with no deaths and only ranks players with kills", () => {
    const rows = [
      stats(FIXTURE_IDS[0], "Iron Hip", 12, 0),
      stats(FIXTURE_IDS[1], "One Shot", 1, 1),
      stats(FIXTURE_IDS[2], "Spectator", 0, 4),
    ];
    const lines = renderWeeklyBoard(input({ rows, highlights: emptyHighlights() })).content.split("\n");
    expect(lines.slice(3, 6)).toEqual([
      "**Top 2 by kills**",
      "1. Iron Hip — 12 kills · K/D —",
      "2. One Shot — 1 kill · K/D 1.00",
    ]);
    expect(lines).not.toContain("**This week's shout-outs**");
    expect(labels({ bestKd: { steamId: FIXTURE_IDS[0], name: "Iron Hip", kills: 31, deaths: 0 } })).toEqual([
      "Still got it: Iron Hip, 31 kills, no deaths",
    ]);
  });

  it("applies each shout-out minimum", () => {
    const id = FIXTURE_IDS[0];
    expect(labels({ bestKd: { steamId: id, name: "A", kills: 9, deaths: 1 } })).toEqual([]);
    expect(labels({ bestKd: { steamId: id, name: "A", kills: 10, deaths: 4 } })).toEqual([
      "Still got it: A, K/D 2.50 over 10 kills",
    ]);
    expect(labels({ mostHeadshots: { steamId: id, name: "A", headshotKills: 2 } })).toEqual([]);
    expect(labels({ mostHeadshots: { steamId: id, name: "A", headshotKills: 3 } })).toEqual([
      "Reading glasses not required: A, 3 headshot kills",
    ]);
    const longest = (distanceCentimeters: number, cause: string | null = null, map: string | null = null) =>
      labels({ longestKill: { steamId: id, name: "A", distanceCentimeters, cause, mapName: map } });
    expect(longest(999)).toEqual([]);
    expect(longest(1_000)).toEqual(["Long-distance call: A, 10 m"]);
    expect(longest(200_000, "Kar98k", "Europe")).toEqual(["Long-distance call: A, 2,000 m with Kar98k on Ozeti"]);
    // Above the cap the units are in doubt, so the shout-out is left out rather than the runner-up shown.
    expect(longest(200_001)).toEqual([]);
    expect(longest(NaN)).toEqual([]);
    expect(longest(25_000, "BP_Kar98k_C", "")).toEqual(["Long-distance call: A, 250 m"]);
    const cause = (kills: number, killsWithCause: number, top: number, name = "M1 Garand") =>
      labels({ kills, killsWithCause, topCause: { cause: name, kills: top } });
    expect(cause(100, 49, 30)).toEqual([]);
    expect(cause(100, 50, 30)).toEqual(["Old faithful: M1 Garand, 30 kills"]);
    expect(cause(8, 8, 4)).toEqual([]);
    expect(cause(8, 8, 5)).toEqual(["Old faithful: M1 Garand, 5 kills"]);
    expect(cause(100, 100, 90, "/Game/Weapons/M1.M1_C")).toEqual([]);
    expect(cause(0, 0, 5)).toEqual([]);
    const maps = (entries: Array<[string, number]>) =>
      labels({ maps: entries.map(([mapName, kills]) => ({ mapName, kills })) });
    expect(maps([["Europe", 40]])).toEqual([]);
    // The catalog ID and the in-game name are one map.
    expect(
      maps([
        ["NorthAmerica", 30],
        ["Zestafona", 10],
      ]),
    ).toEqual([]);
    expect(
      maps([
        ["Europe", 4],
        ["Kavkazi", 3],
      ]),
    ).toEqual([]);
    expect(
      maps([
        ["Europe", 5],
        ["Kavkazi", 3],
      ]),
    ).toEqual(["Where the knees hurt most: Ozeti, 5 kills"]);
    expect(
      maps([
        ["Kavkazi", 30],
        ["NorthAmerica", 20],
        ["Zestafona", 20],
      ]),
    ).toEqual(["Where the knees hurt most: Zestafona, 40 kills"]);
  });

  it("labels only causes and maps that read as names", () => {
    for (const internal of [
      "BP_M1Garand_C",
      "Weapon_BP_Rifle",
      "Rifle_C",
      "Rifle_C_2147482",
      "/Game/Weapons/M1",
      "Weapon.Rifle",
      "Weapons\\Rifle",
      "",
      "   ",
      null,
      undefined,
      "76561198000000001",
      "***",
    ])
      expect(causeLabel(internal)).toBeNull();
    expect(causeLabel("M1 Garand")).toBe("M1 Garand");
    expect(causeLabel("Grenade_Frag")).toBe("Grenade Frag");
    expect(causeLabel("x".repeat(60))).toBe("x".repeat(40));
    expect(mapName("NorthAmerica")).toBe("Zestafona");
    expect(mapName("Kavkazi")).toBe("Bakurani");
    expect(mapName("Some_New_Map")).toBe("Some New Map");
    expect(mapName(null)).toBeNull();
  });

  it("keeps rewards, prizes, points, whitelist and 'free' out of the template text", () => {
    const neutral = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const rows = neutral.map((name, index) => stats(FIXTURE_IDS[index], name, 50 - index, 20));
    const message = renderWeeklyBoard(
      input({
        rows,
        trackingStartedAt: new Date(window.start.getTime() + 3_600_000),
        highlights: {
          bestKd: { steamId: FIXTURE_IDS[0], name: "Alpha", kills: 50, deaths: 20 },
          mostHeadshots: { steamId: FIXTURE_IDS[1], name: "Bravo", headshotKills: 9 },
          longestKill: {
            steamId: FIXTURE_IDS[2],
            name: "Charlie",
            distanceCentimeters: 30_000,
            cause: "Rifle",
            mapName: "Europe",
          },
          kills: 240,
          killsWithCause: 240,
          topCause: { cause: "Rifle", kills: 120 },
          maps: [
            { mapName: "Europe", kills: 140 },
            { mapName: "Kavkazi", kills: 100 },
          ],
        },
      }),
    );
    // Five shout-outs and the link line.
    expect(message.content.split("\n").filter((line) => /: /.test(line))).toHaveLength(6);
    expect(message.content).not.toMatch(/\b(free|reward|prize|points?|whitelist)\b/i);
    expect(message.content).not.toMatch(/\b(win|winner|earn|queue|priority)\b/i);
    const empty = renderWeeklyBoard(input({ rows: [], highlights: emptyHighlights(), trackingStartedAt: null }));
    expect(empty.content).toContain("No kills counted yet.");
    expect(empty.content).not.toMatch(/\b(free|reward|prize|points?|whitelist)\b/i);
  });

  it("uses the same rows as the store order and never more than five", () => {
    const rows = fixtureRows();
    const lines = renderWeeklyBoard(input({ rows })).content.split("\n");
    expect(lines.filter((line) => /^\d\. /.test(line))).toHaveLength(5);
    expect(lines[4]).toMatch(/^1\. Grandpa Joe/);
  });
});
