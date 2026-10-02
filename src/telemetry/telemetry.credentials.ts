import { createHash, timingSafeEqual } from "node:crypto";

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
