// Browser DTOs contain JSON values only; server modules and secrets are never imported here.
export type Staff = { id: string; name: string; role: "viewer" | "moderator" | "admin"; csrf: string; demo?: boolean };
import type { ActionName } from "../../../../src/common/admin-policy";
export type { ActionName } from "../../../../src/common/admin-policy";
export type ActionResult = {
  id?: string;
  state: "applied" | "accepted" | "pending" | "failed" | "unknown";
  message: string;
  /** False when a team move's precondition refused it before anything was sent to the game. */
  changed?: boolean;
};
export type Player = {
  name: string;
  steamId: string;
  faction?: string | null;
  kills?: number;
  deaths?: number;
  cash?: number;
  pingMs?: number;
};
export type Faction = { name: string; colorHex?: string; score: number };
export type Overview = {
  status: {
    serverName: string;
    map: string;
    lighting?: string;
    alternator?: string;
    experiences?: string[];
    players: { current: number; max: number };
    factionScores: Faction[];
    scoreCap?: number;
    matchSeconds?: number;
  };
  players: Player[];
  unlinkedPlayerCount?: number;
  capabilities: {
    build?: string;
    routes: string[];
    config?: { writable: boolean };
    limits?: { maxBodyBytes?: number; maxRequestsPerMinutePerIp?: number };
  };
  observedAt: string;
};
export type Catalog = {
  maps: { id: string; displayName?: string }[];
  experiences: { id: string; displayName?: string }[];
  lightings: { id: string; displayName?: string }[];
};
export type Whitelist = {
  entries: { steamId: string; active: boolean; configured: boolean | null }[];
  configurationAvailable: boolean;
  configuredInvalidEntryCount?: number;
  invalidEntryCount: number;
};
export type Ban = { steamId: string; bannedAtUtc?: string | null; bannedBy?: string | null; reason?: string | null };
export type Audit = {
  id: string;
  actorName: string;
  action: ActionName;
  target: string;
  state: ActionResult["state"] | "started";
  message: string;
  createdAt: string;
  /** Kicks and bans also keep the player's name from the roster at the time, when it was known. */
  details: { reason: string; playerName?: string };
};
/** One kind of action against a player: all of them, those in the asked period, and the newest one. */
export type ModerationCount = {
  count: number;
  recent: number;
  lastAt: string;
  lastBy: string;
  lastReason: string | null;
};
/** A player's dashboard kicks and bans on this server; failed ones are not counted. */
export type PlayerModeration = { kicks: ModerationCount | null; bans: ModerationCount | null; entries: Audit[] };
export type RepeatOffenderList = {
  minimum: number;
  days: number;
  players: { steamId: string; name: string | null; kicks: ModerationCount }[];
};
export type Rotation = {
  enabled: boolean;
  mode: string;
  entries: { index: number; map: string; lighting?: string; status?: string | null; denied?: boolean }[];
};
