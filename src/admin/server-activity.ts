import { randomUUID } from "node:crypto";
import type { Overview } from "./wardogs.client";
import { roundStamp, sameRound } from "../common/game-round";
import { lightingLabel, mapLabel, modeLabel, zoneLabel } from "../common/map-labels";

export type ServerActivityEvent = {
  id: string;
  observedAt: string;
  category: "players" | "match" | "connection";
  message: string;
  steamId?: string;
};
export type ServerActivityView = {
  startedAt: string;
  lastObservedAt: string | null;
  connection: "waiting" | "available" | "unavailable";
  limit: number;
  events: ServerActivityEvent[];
};
const LIMIT = 300;
const GAP = 45_000;

/** Recent observations only. Reuses existing roster reads; owns no timer or game commands. */
export class ServerActivity {
  private previous?: Overview;
  private readonly startedAt = new Date().toISOString();
  private connection: ServerActivityView["connection"] = "waiting";
  private lastObservedAt: string | null = null;
  private events: ServerActivityEvent[] = [];
  private append(category: ServerActivityEvent["category"], message: string, observedAt: string, steamId?: string) {
    this.events.push({ id: randomUUID(), category, message, observedAt, ...(steamId ? { steamId } : {}) });
    this.events = this.events.slice(-LIMIT);
  }
  failed() {
    if (this.connection !== "unavailable")
      this.append("connection", "Game connection unavailable", new Date().toISOString());
    this.connection = "unavailable";
    // No join/leave or round conclusions across failed reads.
    this.previous = undefined;
  }
  observe(current: Overview) {
    const at = current.observedAt,
      time = Date.parse(at),
      previous = this.previous;
    if (!Number.isFinite(time) || (previous && time <= Date.parse(previous.observedAt))) return;
    const resumed = this.connection === "unavailable";
    if (this.connection !== "available")
      this.append("connection", resumed ? "Game connection restored" : "Game connection observed", at);
    this.connection = "available";
    this.lastObservedAt = at;
    this.previous = structuredClone(current);
    if (!previous) return;
    if (time - Date.parse(previous.observedAt) > GAP) {
      this.append("connection", "Observation gap · changes during this interval are unknown", at);
      return;
    }
    if (current.status.map !== previous.status.map) {
      this.append("match", `Map changed: ${mapLabel(previous.status.map)} → ${mapLabel(current.status.map)}`, at);
    } else {
      const before = roundStamp(previous.status, Date.parse(previous.observedAt));
      const after = roundStamp(current.status, time);
      if (before && after && !sameRound(before, after)) this.append("match", "Round clock changed", at);
    }
    if (previous.status.lighting && current.status.lighting && previous.status.lighting !== current.status.lighting)
      this.append(
        "match",
        `Lighting changed: ${lightingLabel(previous.status.lighting)} → ${lightingLabel(current.status.lighting)}`,
        at,
      );
    if (
      previous.status.experiences &&
      current.status.experiences &&
      [...previous.status.experiences].sort().join() !== [...current.status.experiences].sort().join()
    )
      this.append(
        "match",
        `Mode & rules changed: ${current.status.experiences.map((id) => modeLabel(id)).join(" · ") || "Map default"}`,
        at,
      );
    if (
      previous.status.alternator &&
      current.status.alternator &&
      previous.status.alternator !== current.status.alternator
    )
      this.append("match", `Zone layout changed: ${zoneLabel(current.status.alternator)}`, at);
    // Separate status/roster requests can straddle loading or disconnects. Only
    // compare complete, unique rosters; a partial response must not empty a team.
    const complete = (value: Overview) =>
      !value.unlinkedPlayerCount &&
      value.players.length === value.status.players.current &&
      new Set(value.players.map((player) => player.steamId)).size === value.players.length;
    if (!complete(previous) || !complete(current) || current.status.map !== previous.status.map) return;
    const beforePlayers = new Map(previous.players.map((player) => [player.steamId, player]));
    const afterPlayers = new Map(current.players.map((player) => [player.steamId, player]));
    for (const player of current.players) {
      const before = beforePlayers.get(player.steamId);
      if (!before) this.append("players", `${player.name} joined`, at, player.steamId);
      else if (before.faction !== player.faction)
        this.append(
          "players",
          `${player.name}: ${before.faction || "Choosing team"} → ${player.faction || "Choosing team"}`,
          at,
          player.steamId,
        );
    }
    for (const player of previous.players)
      if (!afterPlayers.has(player.steamId)) this.append("players", `${player.name} left`, at, player.steamId);
  }
  view(): ServerActivityView {
    return {
      startedAt: this.startedAt,
      lastObservedAt: this.lastObservedAt,
      connection: this.connection,
      limit: LIMIT,
      events: this.events
        .slice()
        .reverse()
        .map((event) => ({ ...event })),
    };
  }
}
