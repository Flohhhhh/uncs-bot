import type { CombatAggregate, CombatStats, WeeklyHighlights } from "../telemetry/telemetry.types";

// Realistic, invented test data for one busy week. No real player names or SteamIDs.
export const FIXTURE_SLOT = Date.parse("2026-10-05T00:00:00.000Z"); // Sun Oct 4, 20:00 EDT
export const FIXTURE_WEEK_START = Date.parse("2026-09-28T00:00:00.000Z");
export const FIXTURE_IDS = Array.from({ length: 23 }, (_, index) => `765611980000000${String(index + 10)}`);

const row = (index: number, name: string, kills: number, deaths: number, headshotKills: number): CombatStats => ({
  steamId: FIXTURE_IDS[index],
  name,
  kills,
  deaths,
  headshotKills,
  kd: deaths ? Math.round((kills / deaths) * 100) / 100 : null,
});

export function fixtureRows(): CombatStats[] {
  return [
    row(0, "Grandpa Joe", 87, 37, 19),
    row(1, "NapTime", 74, 39, 21),
    // Storage falls back to the SteamID when the game never sent a name.
    row(2, FIXTURE_IDS[2], 61, 50, 9),
    row(3, "LowerBack", 58, 17, 12),
    row(4, "Reading Glasses", 52, 54, 6),
    row(5, "xX_Sniper_Xx", 41, 44, 15),
    row(6, "Early Bird Special", 38, 40, 4),
    row(7, "Bifocal Bandit", 33, 29, 7),
    row(8, "Creaky", 30, 35, 3),
    row(9, "Dad Joke", 27, 31, 2),
    row(10, "Mister Recliner", 22, 26, 5),
    row(11, "Bad Hip", 19, 28, 1),
    row(12, "Coffee First", 17, 22, 2),
    row(13, "Sunday Driver", 14, 25, 0),
    row(14, "Cardigan", 11, 18, 1),
    row(15, "Prune Juice", 9, 21, 0),
    row(16, "Back In My Day", 8, 19, 1),
    row(17, "Thermostat", 6, 15, 0),
    row(18, "Gutter Cleaner", 4, 12, 0),
    row(19, "Lawn Patrol", 3, 14, 0),
    row(20, "Remote Hog", 2, 9, 0),
    row(21, "Early Dinner", 1, 8, 0),
    row(22, "Nap Queen", 0, 6, 0),
  ];
}

export function fixtureAggregate(): CombatAggregate {
  const leaderboard = fixtureRows();
  const sum = (key: "kills" | "deaths" | "headshotKills") =>
    leaderboard.reduce((total, entry) => total + entry[key], 0);
  return {
    leaderboard,
    totals: {
      events: sum("deaths") + 7,
      kills: sum("kills"),
      deaths: sum("deaths"),
      headshotKills: sum("headshotKills"),
      players: leaderboard.length,
    },
  };
}

export function fixtureHighlights(): WeeklyHighlights {
  const kills = fixtureRows().reduce((total, entry) => total + entry.kills, 0);
  return {
    bestKd: { steamId: FIXTURE_IDS[3], name: "LowerBack", kills: 58, deaths: 17 },
    mostHeadshots: { steamId: FIXTURE_IDS[1], name: "NapTime", headshotKills: 21 },
    longestKill: {
      steamId: FIXTURE_IDS[4],
      name: "Reading Glasses",
      distanceCentimeters: 41_237,
      cause: "M1 Garand",
      mapName: "NorthAmerica",
    },
    kills,
    killsWithCause: kills - 23,
    topCause: { cause: "M1 Garand", kills: 304 },
    // The catalog ID and in-game name of one map count as one.
    maps: [
      { mapName: "NorthAmerica", kills: 400 },
      { mapName: "Zestafona", kills: 112 },
      { mapName: "Europe", kills: 105 },
    ],
  };
}
