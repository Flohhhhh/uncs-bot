import type { ActionName, Overview, Staff } from "../../api/types";

export const actionDefinitions: Record<ActionName, readonly [string, string, string]> = {
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
    "End this round and follow the server's current map rotation.",
    "POST /v1/match/end",
  ],
  "match-restart": [
    "Restart current match",
    "Reload the current match. This does not restart the server process or apply startup settings.",
    "POST /v1/match/restart",
  ],
  map: ["Change map", "Travel to the selected map after the end-of-match screen.", "POST /v1/match/map"],
  lighting: ["Change lighting", "Apply a lighting preset to the current game.", "PUT /v1/world/lighting"],
};

const moderatorActions: ActionName[] = ["kick", "ban", "unban", "message", "kill", "team", "broadcast"];
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
  if (busy || stale || !me || me.role === "viewer" || (me.role === "moderator" && !moderatorActions.includes(action)))
    return false;
  const caps = overview?.capabilities;
  const routes = caps?.routes.map((route) => route.replace(/\{[^}]+\}/g, "{id}")) ?? [];
  if (actionDefinitions[action][2] === "whitelist") {
    return (
      routes.includes(action === "whitelist-add" ? "POST /v1/reserved-slots" : "DELETE /v1/reserved-slots/{id}") ||
      (routes.includes("PUT /v1/config") && caps?.config?.writable !== false)
    );
  }
  return routes.includes(actionDefinitions[action][2]);
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
