import { ArrowRightLeftIcon, CircleDotIcon, SwordsIcon, UsersIcon, type LucideIcon } from "lucide-react";

import type { ActivityData, CombatData } from "~/components/overview/overview-data";

export const activityCategories = ["players", "match", "connection", "combat"] as const;
export type ActivityCategory = (typeof activityCategories)[number];

export const activityCategoryDetails: Record<ActivityCategory, { label: string; Icon: LucideIcon }> = {
  players: { label: "Players & teams", Icon: UsersIcon },
  match: { label: "Match changes", Icon: ArrowRightLeftIcon },
  connection: { label: "Connection", Icon: CircleDotIcon },
  combat: { label: "Kill feed", Icon: SwordsIcon },
};

export type ActivityRow = {
  id: string;
  at: string;
  category: ActivityCategory;
  message: string;
  playerNames?: string[];
  teamNames?: string[];
  detail?: string;
};

export type ActivityMessagePart = { text: string; tone: "player" | "team" | "muted"; teamClass?: string };

const teamTextClass: Record<string, string> = {
  red: "text-red-400",
  valkyra: "text-red-400",
  blu: "text-blue-400",
  lonestar: "text-blue-400",
  grn: "text-green-400",
  manticore: "text-green-400",
};

function weaponName(cause: string | null) {
  if (!cause) return "";
  const name = cause.trim().split(".").at(-1) ?? cause.trim();
  return name.replace(/^(?:ID|Id)_?Item_?/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function combatDetail(event: CombatData["events"][number]) {
  return [
    weaponName(event.cause),
    event.headshot ? "Headshot" : "",
    event.distanceMeters == null ? "" : `${Math.round(event.distanceMeters)} m`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function combatMessage(event: CombatData["events"][number]) {
  if (event.suicide) return `${event.victimName || "Unknown player"} died (suicide)`;
  return `${event.killerName || "Unknown killer"} killed ${event.victimName || "unknown player"}`;
}

function observedPlayerName(message: string) {
  const teamChange = message.lastIndexOf(": ");
  if (teamChange > 0) return message.slice(0, teamChange);
  for (const ending of [" joined", " left"]) {
    if (message.endsWith(ending)) return message.slice(0, -ending.length);
  }
  return null;
}

export function activityMessageParts(row: ActivityRow): ActivityMessagePart[] {
  const markedNames = [
    ...(row.playerNames ?? []).map((name) => ({ name, tone: "player" as const })),
    ...(row.teamNames ?? []).map((name) => ({ name, tone: "team" as const })),
  ]
    .filter(({ name }) => name)
    .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index)
    .sort((a, b) => b.name.length - a.name.length);
  if (!markedNames.length) return [{ text: row.message, tone: "muted" }];

  const parts: ActivityMessagePart[] = [];
  let cursor = 0;
  while (cursor < row.message.length) {
    let nextIndex = -1;
    let nextName = "";
    let nextTone: "player" | "team" = "player";
    for (const { name, tone } of markedNames) {
      const index = row.message.indexOf(name, cursor);
      if (
        index >= 0 &&
        (nextIndex < 0 || index < nextIndex || (index === nextIndex && name.length > nextName.length))
      ) {
        nextIndex = index;
        nextName = name;
        nextTone = tone;
      }
    }
    if (nextIndex < 0) break;
    if (nextIndex > cursor) parts.push({ text: row.message.slice(cursor, nextIndex), tone: "muted" });
    parts.push({
      text: nextName,
      tone: nextTone,
      ...(nextTone === "team" ? { teamClass: teamTextClass[nextName.toLocaleLowerCase()] } : {}),
    });
    cursor = nextIndex + nextName.length;
  }
  if (cursor < row.message.length) parts.push({ text: row.message.slice(cursor), tone: "muted" });
  return parts.length ? parts : [{ text: row.message, tone: "muted" }];
}

function observedTeamNames(message: string) {
  const separator = message.lastIndexOf(": ");
  if (separator < 0) return [];
  const teams = message.slice(separator + 2).split(" → ");
  return teams.length === 2 ? teams : [];
}

export function combineActivity(activity: ActivityData | undefined, combat: CombatData | undefined): ActivityRow[] {
  const observations: ActivityRow[] = (activity?.events ?? []).map((event) => {
    const playerName = event.category === "players" ? observedPlayerName(event.message) : null;
    return {
      id: `observation:${event.id}`,
      at: event.observedAt,
      category: event.category,
      message: event.message,
      ...(playerName ? { playerNames: [playerName] } : {}),
      ...(event.category === "players" ? { teamNames: observedTeamNames(event.message) } : {}),
    };
  });
  const killsAndDeaths: ActivityRow[] = (combat?.events ?? []).map((event) => ({
    id: `combat:${event.serverInstanceId}:${event.eventId}`,
    at: event.receivedAt,
    category: "combat",
    message: combatMessage(event),
    playerNames: [event.killerName, event.victimName].filter((name): name is string => Boolean(name)),
    detail: combatDetail(event),
  }));

  return [...observations, ...killsAndDeaths];
}

/** Static examples for sample game mode; live activity continues to come from the APIs. */
export function sampleActivityEntries(now = Date.now()): ActivityRow[] {
  const players = ["UncDap", "MossyBoots", "[UNC] OldManRiver", "TeaAndTanks", "NightShift", "RustyCompass"];
  const teams = ["Valkyra", "Lonestar", "Manticore"];
  const weapons = ["AK74", "M4", "M249", "SVD", "Compound Bow"];
  const maps = ["Bakurani", "Ozeti", "Zestafona"];
  const lighting = ["Dawn · clear", "Day · clear", "Late day · overcast", "Dusk · clear"];
  const matchChanges = [
    () => `Map changed: ${maps[0]} → ${maps[1]}`,
    () => `Map changed: ${maps[1]} → ${maps[2]}`,
    () => `Lighting changed: ${lighting[0]} → ${lighting[1]}`,
    () => `Lighting changed: ${lighting[1]} → ${lighting[2]}`,
    () => "Mode & rules changed: King of the Hill · Infantry only",
    () => "Zone layout changed: Farmland",
  ];
  const connectionEvents = [
    "Game connection restored",
    "Game connection observed",
    "Game connection restored",
    "Observation gap · changes during this interval are unknown",
  ];
  const rows: ActivityRow[] = [];
  let playerEvent = 0;
  let matchEvent = 0;
  let connectionEvent = 0;
  let combatEvent = 0;

  for (let index = 0; index < 120; index++) {
    const position = index % 12;
    const at = new Date(now - index * 5 * 60_000).toISOString();
    if (position < 5) {
      const killer = players[combatEvent % players.length];
      const victim = players[(combatEvent + 2) % players.length];
      const weapon = weapons[combatEvent % weapons.length];
      const headshot = combatEvent % 4 === 0;
      rows.push({
        id: `sample:combat:${combatEvent}`,
        at,
        category: "combat",
        message: combatEvent % 13 === 8 ? `${victim} died (suicide)` : `${killer} killed ${victim}`,
        playerNames: combatEvent % 13 === 8 ? [victim] : [killer, victim],
        detail: [
          combatEvent % 13 === 8 ? "Falling" : weapon,
          headshot ? "Headshot" : "",
          `${42 + ((combatEvent * 17) % 160)} m`,
        ]
          .filter(Boolean)
          .join(" · "),
      });
      combatEvent++;
    } else if (position < 9) {
      const player = players[playerEvent % players.length];
      const fromTeam = teams[playerEvent % teams.length];
      const toTeam = teams[(playerEvent + 1) % teams.length];
      const messages = [
        `${player} joined`,
        `${player} left`,
        `${player} switched teams: ${fromTeam} → ${toTeam}`,
        `${player} joined`,
      ];
      const messageIndex = playerEvent % messages.length;
      rows.push({
        id: `sample:players:${playerEvent}`,
        at,
        category: "players",
        message: messages[messageIndex],
        playerNames: [player],
        ...(messageIndex === 2 ? { teamNames: [fromTeam, toTeam] } : {}),
      });
      playerEvent++;
    } else if (position < 11) {
      rows.push({
        id: `sample:match:${matchEvent}`,
        at,
        category: "match",
        message: matchChanges[matchEvent % matchChanges.length](),
      });
      matchEvent++;
    } else {
      rows.push({
        id: `sample:connection:${connectionEvent}`,
        at,
        category: "connection",
        message: connectionEvents[connectionEvent % connectionEvents.length],
      });
      connectionEvent++;
    }
  }

  return rows;
}

export function activitySearchText(row: ActivityRow) {
  return [activityCategoryDetails[row.category].label, row.message, row.detail, row.at]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}
