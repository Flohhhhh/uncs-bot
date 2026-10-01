import { GameServers } from "./game-servers";
import { AdminSettings } from "./admin.settings";
import type { WardogsClient } from "./wardogs.client";
import { createHash } from "node:crypto";

// Explicit single-server test double; no connection lookup or real transport is used.
export const legacyServerSettings = {
  servers: () => [{ id: "primary", name: "Test server", version: "0".repeat(64) }],
  explicitServers: () => false,
  serverRoles: () => undefined,
};
export function fixtureServers(game: unknown, endpoint = () => "https://game.example.test", serverId = "primary") {
  const servers = new GameServers({
    ...legacyServerSettings,
    servers: () => [{ id: serverId, name: "Test server", version: "0".repeat(64) }],
    explicitServers: () => serverId !== "primary",
  } as unknown as AdminSettings);
  servers.get = (id) => {
    servers.resolve(id);
    return game as WardogsClient;
  };
  servers.connectionHash = (id) => {
    servers.resolve(id);
    return createHash("sha256").update(new URL(endpoint()).toString().replace(/\/$/, "")).digest("hex");
  };
  return servers;
}
