import { MessageFlags } from "discord.js";
import { describeCause, UNKNOWN_WEAPON } from "../common/cause-labels";
import { mapLabel } from "../common/map-labels";
import { plainLabel } from "../server-community/community-state";
import { publicName, UNNAMED_PLAYER } from "../telemetry/telemetry.service";
import type { CombatStats, WeeklyHighlights } from "../telemetry/telemetry.types";
import { slotDateLabel, type WeekWindow } from "./weekly-schedule";

export const TOP_N = 5;
/** Players with at least one kill needed before a week is posted. */
export const MIN_RANKED_PLAYERS = 5;
export const LEADERBOARD_URL = "https://theuncsgaming.com/leaderboard";
export const DISCORD_CONTENT_LIMIT = 2_000;
/** Each shout-out appears only when its minimum is met; draft values pending the first real batch. */
export const SHOUT_OUT_RULES = {
  /** Still got it: best K/D among players with at least this many kills. */
  bestKdMinKills: 10,
  /** Reading glasses not required: the top headshot count must reach this. */
  headshotMinKills: 3,
  /** Long-distance call: the longest kill must fall in this range, as the source's units are unverified. */
  distanceMinMeters: 10,
  distanceMaxMeters: 2_000,
  /** Old faithful: cause present on at least this share of kills, and the top cause used this often. */
  causeMinShare: 0.5,
  causeMinKills: 5,
  /** Where the knees hurt most: kills on at least this many maps, and this many on the top map. */
  mapMinDistinct: 2,
  mapMinKills: 5,
} as const;
export const NO_MENTIONS = { parse: [] as [], users: [] as string[], roles: [] as string[], repliedUser: false };

/** Any run of 17 decimal digits, in any script, reads as a SteamID64 and is never shown. */
const STEAM_ID_LIKE = /\p{Nd}{17}/u;

function safeLabel(value: string, max: number) {
  const label = plainLabel(value, max);
  return label === "Unknown" || STEAM_ID_LIKE.test(label) ? null : label;
}

/**
 * A player's name for Discord: the public names-only rule, then the website's stricter 17-digit rule,
 * then plainLabel, which removes mentions, markdown, links and line breaks. Anything left empty or
 * SteamID-like becomes "Unnamed player".
 */
export function discordName(steamId: string | null | undefined, name: unknown) {
  const visible = publicName(steamId, name);
  if (STEAM_ID_LIKE.test(visible)) return UNNAMED_PLAYER;
  return safeLabel(visible, 32) ?? UNNAMED_PLAYER;
}

/**
 * A weapon or cause by its shared readable label ("Id.Item.AK74M" and "ID.Item.AK74M" both read "AK74"),
 * or null when describeCause() cannot name it: unknown dotted ids, paths, blueprint names and SteamID-like text.
 */
export function causeLabel(cause: string | null | undefined) {
  const { label } = describeCause(cause);
  return label === UNKNOWN_WEAPON ? null : safeLabel(label, 40);
}

export function mapName(map: string | null | undefined) {
  if (typeof map !== "string" || !map.trim()) return null;
  return safeLabel(mapLabel(map), 40);
}

const count = (value: number, noun: string) => `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
/**
 * Two decimals, or a dash with no deaths, as on the website. Integer half-up rounding matches the store's
 * round(numeric, 2); float division would print 41/40 as 1.02 because 41/40*100 is 102.4999...
 */
export const kdLabel = (kills: number, deaths: number) => {
  if (!(deaths > 0)) return "—";
  const scaled = kills * 100;
  const whole = Math.floor(scaled / deaths);
  const cents = 2 * (scaled - whole * deaths) >= deaths ? whole + 1 : whole;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
};

export type ShoutOut = { label: string; text: string };

export function shoutOuts(highlights: WeeklyHighlights): ShoutOut[] {
  const rules = SHOUT_OUT_RULES;
  const result: ShoutOut[] = [];
  const best = highlights.bestKd;
  if (best && best.kills >= rules.bestKdMinKills)
    result.push({
      label: "Still got it",
      text: `${discordName(best.steamId, best.name)}, ${
        best.deaths > 0
          ? `K/D ${kdLabel(best.kills, best.deaths)} over ${count(best.kills, "kill")}`
          : `${count(best.kills, "kill")}, no deaths`
      }`,
    });
  const headshots = highlights.mostHeadshots;
  if (headshots && headshots.headshotKills >= rules.headshotMinKills)
    result.push({
      label: "Reading glasses not required",
      text: `${discordName(headshots.steamId, headshots.name)}, ${count(headshots.headshotKills, "headshot kill")}`,
    });
  const longest = highlights.longestKill;
  const metres = longest ? longest.distanceCentimeters / 100 : NaN;
  if (longest && Number.isFinite(metres) && metres >= rules.distanceMinMeters && metres <= rules.distanceMaxMeters) {
    const weapon = causeLabel(longest.cause),
      map = mapName(longest.mapName);
    result.push({
      label: "Long-distance call",
      text: `${discordName(longest.steamId, longest.name)}, ${Math.round(metres).toLocaleString("en-US")} m${
        weapon ? ` with ${weapon}` : ""
      }${map ? ` on ${map}` : ""}`,
    });
  }
  const cause = highlights.topCause;
  const causeShare = highlights.kills > 0 ? highlights.killsWithCause / highlights.kills : 0;
  const faithful =
    cause && causeShare >= rules.causeMinShare && cause.kills >= rules.causeMinKills ? causeLabel(cause.cause) : null;
  if (cause && faithful) result.push({ label: "Old faithful", text: `${faithful}, ${count(cause.kills, "kill")}` });
  // Aliases of one map (catalog ID and in-game name) count once.
  const maps = new Map<string, { label: string | null; kills: number }>();
  for (const entry of highlights.maps) {
    if (!(entry.kills > 0)) continue;
    const label = mapName(entry.mapName);
    const key = label ?? `raw:${entry.mapName}`;
    maps.set(key, { label, kills: (maps.get(key)?.kills ?? 0) + entry.kills });
  }
  const [top] = [...maps.entries()]
    .sort(([a, x], [b, y]) => y.kills - x.kills || a.localeCompare(b))
    .map(([, value]) => value);
  if (maps.size >= rules.mapMinDistinct && top?.label && top.kills >= rules.mapMinKills)
    result.push({ label: "Where the knees hurt most", text: `${top.label}, ${count(top.kills, "kill")}` });
  return result;
}

/**
 * Last-line marker that identifies an existing post for this week and server. The name is for readers;
 * the posted check matches the server's unique, stable ID in brackets, because names need not be unique,
 * plainLabel can make two of them read the same, and a server can be renamed.
 */
export function weeklyMarker(weekKey: string, serverId: string, serverName: string) {
  return `Weekly board ${weekKey} · ${plainLabel(serverName)} [${serverId}]`;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the last line ends with this week's marker for this server ID, whatever name it showed. */
export function hasWeeklyMarker(content: string | null | undefined, weekKey: string, serverId: string) {
  const last = (content ?? "").trimEnd().split("\n").at(-1) ?? "";
  const marker = `(?:^| )Weekly board ${escapeRegExp(weekKey)} · .+ \\[${escapeRegExp(serverId)}\\]$`;
  return new RegExp(marker).test(last);
}

export type WeeklyBoardInput = {
  /** Unique, stable server ID; the posted check matches on it. */
  serverId: string;
  serverName: string;
  /** Name the server in the heading when more than one is configured. */
  showServerName: boolean;
  /** The slot the heading's "week ending" date comes from. */
  slot: number;
  window: WeekWindow;
  trackingStartedAt: Date | null;
  rows: CombatStats[];
  highlights: WeeklyHighlights;
};

export type WeeklyBoardMessage = {
  content: string;
  allowedMentions: typeof NO_MENTIONS;
  flags: MessageFlags.SuppressEmbeds;
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** Pure renderer: banter, the top five by kills, data-backed shout-outs and the marker line. No pings. */
export function renderWeeklyBoard(input: WeeklyBoardInput): WeeklyBoardMessage {
  const ranked = input.rows.filter((row) => row.kills > 0).slice(0, TOP_N);
  const heading = `**The UNCs · Weekly board${input.showServerName ? ` · ${plainLabel(input.serverName, 40)}` : ""}**`;
  const lines = [
    `${heading} · week ending ${slotDateLabel(input.slot)}`,
    "Good games, older knees. Here's how the week shook out.",
    "",
    `**Top ${ranked.length || TOP_N} by kills**`,
    ...ranked.map(
      (row, index) =>
        `${index + 1}. ${discordName(row.steamId, row.name)} — ${count(row.kills, "kill")} · K/D ${kdLabel(row.kills, row.deaths)}`,
    ),
  ];
  if (!ranked.length) lines.push("No kills counted yet.");
  const shouts = shoutOuts(input.highlights);
  if (shouts.length)
    lines.push("", "**This week's shout-outs**", ...shouts.map((shout) => `${shout.label}: ${shout.text}`));
  lines.push("", `Stretch, hydrate, run it back. Full board: ${LEADERBOARD_URL}`);
  const { start, end, weekKey } = input.window;
  if (input.trackingStartedAt && input.trackingStartedAt.getTime() > start.getTime())
    lines.push(`-# Counting since <t:${seconds(input.trackingStartedAt)}:f>`);
  lines.push(
    `-# Counted from game events Gramps received <t:${seconds(start)}:f> – <t:${seconds(end)}:f>; delayed or missing deliveries aren't included. ${weeklyMarker(weekKey, input.serverId, input.serverName)}`,
  );
  return { content: lines.join("\n"), allowedMentions: NO_MENTIONS, flags: MessageFlags.SuppressEmbeds };
}
