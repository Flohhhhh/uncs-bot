import type { Overview, Staff } from "./types";
import { isPublicIndividualSteamId } from "../../../../src/common/steam-id";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalText = (value: unknown) => value === undefined || text(value);
const optionalNumber = (value: unknown) => value === undefined || finite(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(text);

// These guards validate the browser contract, not staff authority. The server
// independently authenticates every request and authorizes every action.
export function validateStaff(value: unknown): Staff {
  if (
    !record(value) ||
    !text(value.id) ||
    !value.id ||
    !text(value.name) ||
    !text(value.csrf) ||
    !value.csrf ||
    !text(value.role) ||
    !["admin", "moderator", "viewer"].includes(value.role) ||
    (value.demo !== undefined && typeof value.demo !== "boolean")
  ) {
    throw new Error("The staff session could not be verified. Sign in again.");
  }
  return value as Staff;
}

export function validateOverview(value: unknown): Overview {
  const invalid = () => new Error("The server response could not be verified. Refresh before using game controls.");
  if (!record(value) || !record(value.status) || !record(value.capabilities) || !Array.isArray(value.players))
    throw invalid();
  const status = value.status;
  const capabilities = value.capabilities;
  if (
    !text(value.observedAt) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !text(status.serverName) ||
    !text(status.map) ||
    !optionalText(status.lighting) ||
    (status.experiences !== undefined && !strings(status.experiences)) ||
    !record(status.players) ||
    !finite(status.players.current) ||
    !finite(status.players.max) ||
    !optionalNumber(status.scoreCap) ||
    !optionalNumber(status.matchSeconds) ||
    !Array.isArray(status.factionScores) ||
    !status.factionScores.every(
      (team) => record(team) && text(team.name) && finite(team.score) && optionalText(team.colorHex),
    )
  )
    throw invalid();
  if (
    !value.players.every(
      (player) =>
        record(player) &&
        text(player.name) &&
        isPublicIndividualSteamId(player.steamId) &&
        (player.faction === null || optionalText(player.faction)) &&
        [player.kills, player.deaths, player.cash, player.pingMs].every(optionalNumber),
    )
  )
    throw invalid();
  if (
    !strings(capabilities.routes) ||
    !optionalText(capabilities.build) ||
    (capabilities.config !== undefined &&
      (!record(capabilities.config) || typeof capabilities.config.writable !== "boolean")) ||
    (capabilities.limits !== undefined &&
      (!record(capabilities.limits) ||
        !optionalNumber(capabilities.limits.maxBodyBytes) ||
        !optionalNumber(capabilities.limits.maxRequestsPerMinutePerIp)))
  )
    throw invalid();
  return value as unknown as Overview;
}
