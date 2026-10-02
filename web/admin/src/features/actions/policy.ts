import type { ActionName, Overview, Staff } from "../../api/types";
import { canAct, serves } from "../../../../../src/common/admin-policy";

export const actionDefinitions: Record<ActionName, readonly [string, string, string]> = {
  "settings-save": ["Save settings", "Save the reviewed server settings.", "PUT /v1/config"],
  "rotation-save": ["Save rotation", "Save the reviewed map rotation.", "PUT /v1/config"],
  "map-next": [
    "Queue next map",
    "Place this selection after the current map in the ordered rotation.",
    "PUT /v1/config",
  ],
  kick: ["Kick player", "Disconnect this player from the current game. They can rejoin.", "POST /v1/players/{id}/kick"],
  ban: [
    "Ban player",
    "Add a permanent game ban. The current game build may require the player to be connected.",
    "POST /v1/bans",
  ],
  unban: ["Remove ban", "Restore this player's ability to join the game.", "DELETE /v1/bans/{id}"],
  "whitelist-add": [
    "Add whitelist access",
    "Add this SteamID to the server whitelist. Existing entries and reserved capacity stay as they are.",
    "whitelist",
  ],
  "whitelist-remove": [
    "Remove whitelist access",
    "Explicitly remove this player's existing queue access. This does not ban them from the server.",
    "whitelist",
  ],
  message: ["Message player", "Send a private in-game message to this player.", "POST /v1/players/{id}/message"],
  kill: [
    "Force player respawn",
    "Kill this player's current character. Use only when needed to resolve an issue.",
    "POST /v1/players/{id}/kill",
  ],
  team: [
    "Change player team",
    "Change faction. The player may need to respawn before the change takes effect.",
    "PATCH /v1/players/{id}",
  ],
  broadcast: [
    "Send announcement",
    "Broadcast to everyone currently in the game. This sends immediately.",
    "POST /v1/broadcast",
  ],
  "match-end": [
    "End current match",
    "Ends the current round for everyone and follows the server’s rotation. The round cannot be resumed.",
    "POST /v1/match/end",
  ],
  "match-restart": [
    "Restart current match",
    "Interrupts and reloads the current match for everyone. This does not restart the server process or apply startup settings.",
    "POST /v1/match/restart",
  ],
  map: ["Change map", "Travel to the selected map after the end-of-match screen.", "POST /v1/match/map"],
  lighting: ["Change lighting", "Apply a lighting preset to the current game.", "PUT /v1/world/lighting"],
};

export const playerActions: ActionName[] = [
  "kick",
  "ban",
  "unban",
  "whitelist-add",
  "whitelist-remove",
  "message",
  "kill",
  "team",
];
export const confirmationPhrases: Partial<Record<ActionName, string>> = {
  "match-end": "END MATCH",
  "match-restart": "RESTART MATCH",
  map: "CHANGE MAP",
};
export const confirmedActions: ActionName[] = [
  "ban",
  "unban",
  "whitelist-remove",
  "kill",
  "team",
  "match-end",
  "match-restart",
  "map",
];

export function allowed(
  action: ActionName,
  me: Staff | null,
  overview: Overview | null,
  stale: boolean,
  busy: boolean,
) {
  if (busy || stale || !me || !canAct(me.role, action)) return false;
  const caps = overview?.capabilities;
  if (!caps) return false;
  if (actionDefinitions[action][2] === "whitelist") {
    return (
      serves(
        caps,
        action === "whitelist-add" ? "POST" : "DELETE",
        action === "whitelist-add" ? "/v1/reserved-slots" : "/v1/reserved-slots/{id}",
      ) ||
      (serves(caps, "PUT", "/v1/config") && caps.config?.writable !== false)
    );
  }
  const [method, path] = actionDefinitions[action][2].split(" ");
  return serves(caps, method, path) && (path !== "/v1/config" || caps.config?.writable !== false);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be confirmed.";
}

export function rejectionState(error: unknown): "failed" | "unknown" {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return typeof status === "number" && [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(status)
    ? "failed"
    : "unknown";
}

export function singleLine(value: string, minimum = 1) {
  return (
    value.trim().length >= minimum && value.trim().length <= 200 && [...value].every((char) => char.charCodeAt(0) >= 32)
  );
}
