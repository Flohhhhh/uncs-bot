import { BadRequestException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { GameServers } from "../admin/game-servers";

/** A feed-only secret long enough to accept deliveries with. */
export function usableFeedToken(token: unknown): token is string {
  return typeof token === "string" && token.length >= 32;
}

export type FeedCredentials = "valid" | "missing credentials" | "malformed credentials" | "token mismatch";

/**
 * Compares a feed Authorization header with a server's feed token in constant time. Only a usable
 * token can make it "valid"; the other results double as refusal categories.
 */
export function feedCredentials(authorization: unknown, token: unknown): FeedCredentials {
  const match = typeof authorization === "string" && /^Bearer ([^\s]{1,512})(?![\s\S])/i.exec(authorization);
  const actual = createHash("sha256")
    .update(match ? match[1] : "")
    .digest();
  const usable = usableFeedToken(token);
  const expected = createHash("sha256")
    .update(usable ? token : "")
    .digest();
  if (match && usable && timingSafeEqual(actual, expected)) return "valid";
  return match ? "token mismatch" : authorization ? "malformed credentials" : "missing credentials";
}

/**
 * The server a feed route delivers to. The game appends the fixed /api/ingest/events path to its base
 * URL, so once WARDOGS_SERVERS is set that unscoped route is resolved by its bearer token: every
 * registry entry's feed token is compared in constant time and only a single exact match counts.
 * Named routes, legacy single-server mode and requests without a match resolve, or are refused,
 * exactly as GameServers.resolve does.
 */
export function feedServer(servers: GameServers, id: string | undefined, authorization: unknown): string {
  try {
    return servers.resolve(id);
  } catch (error) {
    if (id !== undefined || !(error instanceof BadRequestException)) throw error;
    const matches = servers
      .list()
      .filter((server) => feedCredentials(authorization, servers.feedToken(server.id)) === "valid");
    if (matches.length !== 1) throw error;
    return matches[0].id;
  }
}
