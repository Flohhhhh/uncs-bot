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

export interface CombatFeedRejection {
  at: string;
  status: number;
  reason: string;
}

export interface CombatFeedBatch {
  at: string;
  /** Valid killed events, repeats included. */
  accepted: number;
  /** Other event types plus invalid entries. */
  skipped: number;
  invalid: number;
  /** Schema location of the first invalid entry, never its value. */
  firstInvalid: string | null;
  /** Distinct valid event types in the batch. Absent before Gramps counted them. */
  types?: number;
  /** Types new today that were not counted because the daily limit of types was reached. */
  typesOverLimit?: number;
}

/** One game feed event type counted over whole UTC days in the window: staff only. */
export interface CombatFeedEventType {
  type: string;
  count: number;
  firstReceivedAt: string;
  lastReceivedAt: string;
  /** The latest kept entry of this type as sent, a size marker, or null (always for killed). */
  sample: unknown;
}

/** In-memory delivery record since Gramps last started; the server combat view only. */
export interface CombatFeedDeliveries {
  lastBatch: CombatFeedBatch | null;
  /** Refused deliveries that carried the server's feed token: the game's own. */
  lastRejected: CombatFeedRejection | null;
  rejectedCount: number;
  /** Refused requests without the feed token, which anyone can send. */
  lastRejectedWithoutToken: CombatFeedRejection | null;
  rejectedWithoutTokenCount: number;
}

export interface CombatServerResponse extends CombatBase, CombatFeedDeliveries {
  leaderboard: CombatPlayer[];
  /**
   * Every feed event type received in the window, killed included. Null when the counts could not be
   * read; absent from older Gramps builds.
   */
  otherEvents?: CombatFeedEventType[] | null;
  steamId?: never;
  player?: never;
}

export interface CombatPlayerResponse extends CombatBase {
  steamId: string;
  player: CombatPlayer | null;
  leaderboard?: never;
}

export type CombatResponse = CombatServerResponse | CombatPlayerResponse;
