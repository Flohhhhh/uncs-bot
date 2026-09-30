// Browser DTOs contain JSON values only; server modules and secrets are never imported here.
export type Staff = { id: string; name: string; role: "viewer" | "moderator" | "admin"; csrf: string; demo?: boolean };
export type ActionName =
  | "kick"
  | "ban"
  | "unban"
  | "whitelist-add"
  | "whitelist-remove"
  | "kill"
  | "message"
  | "team"
  | "broadcast"
  | "match-end"
  | "match-restart"
  | "map"
  | "lighting";
export type ActionResult = {
  id?: string;
  state: "applied" | "accepted" | "pending" | "failed" | "unknown";
  message: string;
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
    experiences?: string[];
    players: { current: number; max: number };
    factionScores: Faction[];
    scoreCap?: number;
    matchSeconds?: number;
  };
  players: Player[];
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
  details: { reason: string };
};
export type Rotation = {
  enabled: boolean;
  mode: string;
  entries: { index: number; map: string; lighting?: string; status?: string | null; denied?: boolean }[];
};
