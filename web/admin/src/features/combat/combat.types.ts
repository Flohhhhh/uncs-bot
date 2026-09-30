export type CombatPeriod = "day" | "week" | "month";
export type CombatEventKind = "all" | "headshot";

export interface CombatPlayer {
  steamId: string;
  name: string;
  kills: number;
  deaths: number;
  headshotKills: number;
  kd: number | null;
}

export interface CombatEvent {
  eventId: string;
  serverInstanceId: string;
  receivedAt: string;
  eventTime: number;
  matchId: string | null;
  mapName: string | null;
  killerSteamId: string | null;
  killerName: string | null;
  victimSteamId: string | null;
  victimName: string | null;
  cause: string | null;
  distanceMeters: number | null;
  headshot: boolean;
  suicide: boolean;
}

interface CombatBase {
  enabled: boolean;
  connected: boolean;
  feedStatus: "waiting" | "receiving" | "quiet";
  lastReceivedAt: string | null;
  trackingStartedAt: string | null;
  period: CombatPeriod;
  windowStartedAt: string;
  asOf: string;
  coverageNote: string;
  totals: { events: number; kills: number; deaths: number; headshotKills: number; players: number };
  events: CombatEvent[];
}

export interface CombatServerResponse extends CombatBase {
  leaderboard: CombatPlayer[];
  steamId?: never;
  player?: never;
}

export interface CombatPlayerResponse extends CombatBase {
  steamId: string;
  player: CombatPlayer | null;
  leaderboard?: never;
}

export type CombatResponse = CombatServerResponse | CombatPlayerResponse;
