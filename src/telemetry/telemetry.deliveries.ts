import { Injectable, Logger } from "@nestjs/common";
import { GameServers } from "../admin/game-servers";
import { feedCredentials } from "./telemetry.credentials";

export type FeedRejection = { at: string; status: number; reason: string };
/** accepted: valid killed events (repeats included); skipped: other types plus invalid entries. */
export type FeedBatchReceipt = {
  at: string;
  accepted: number;
  skipped: number;
  invalid: number;
  firstInvalid: string | null;
};
export type FeedDeliveryStatus = {
  lastBatch: FeedBatchReceipt | null;
  /** Refused requests that carried this server's feed token: the game's own deliveries. */
  lastRejected: FeedRejection | null;
  rejectedCount: number;
  /** Refused requests without this server's feed token, which anyone can send to the ingest URL. */
  lastRejectedWithoutToken: FeedRejection | null;
  rejectedWithoutTokenCount: number;
};
type Tally = { last: FeedRejection; count: number };

export const FEED_WARNING_INTERVAL_MS = 60_000;
const UNCONFIGURED = "(unconfigured)";
const INGEST_ROUTE = /^\/api\/ingest(?:\/servers\/([^/?#]*))?\/events\/?(?:[?#]|$)/i;

/**
 * Per-server, in-memory record of game feed deliveries that reached Gramps, so staff can tell
 * "nothing arrived" from "arrived but rejected" or "partly accepted". Refusals of requests that
 * carried the server's feed token are kept apart from the rest, so traffic without the token
 * cannot replace or hide the game's own failures. It holds only times, counts, HTTP statuses and
 * fixed categories: never tokens, headers, bodies or addresses. It resets on restart.
 */
@Injectable()
export class TelemetryDeliveries {
  private readonly logger = new Logger(TelemetryDeliveries.name);
  private readonly rejections = new Map<string, Tally>();
  private readonly rejectionsWithoutToken = new Map<string, Tally>();
  private readonly batches = new Map<string, FeedBatchReceipt>();
  // One warning per server, token state, status and reason category per interval; later ones of
  // the same kind are counted and summarized in the next.
  private readonly warnings = new Map<string, { until: number; suppressed: number }>();

  constructor(private readonly servers: GameServers) {}

  /**
   * Records a refused delivery. withToken: the request carried the server's feed token. A route
   * that names no configured server is only logged.
   */
  rejected(id: string | undefined, status: number, reason: string, withToken: boolean) {
    this.record(this.configured(id), status, reason, withToken);
  }

  /** Records a stored batch for a resolved server, including how many entries were skipped. */
  accepted(serverId: string, batch: Omit<FeedBatchReceipt, "at">) {
    const now = new Date();
    const { accepted, skipped, invalid, firstInvalid } = batch;
    this.batches.set(serverId, { at: now.toISOString(), accepted, skipped, invalid, firstInvalid });
    if (invalid)
      this.warn(
        `invalid:${serverId}`,
        `Accepted a game feed batch for server ${serverId} but skipped ${invalid} invalid ` +
          `${invalid === 1 ? "entry" : "entries"}; first: ${firstInvalid ?? "unknown"}.`,
        now.getTime(),
      );
  }

  /**
   * Records a refusal made before the ingest controller ran, filed by whether the request's
   * Authorization header carries the targeted server's feed token. Returns false for other routes.
   */
  rejectedRequest(url: string, status: number, reason: string, authorization: unknown) {
    const route = INGEST_ROUTE.exec(url);
    if (!route) return false;
    let id: string | undefined;
    try {
      id = route[1] === undefined ? undefined : decodeURIComponent(route[1]);
    } catch {
      id = UNCONFIGURED;
    }
    const serverId = this.configured(id);
    this.record(serverId, status, reason, serverId !== null && this.carriesToken(serverId, authorization));
    return true;
  }

  status(serverId: string): FeedDeliveryStatus {
    const batch = this.batches.get(serverId);
    const withToken = this.rejections.get(serverId);
    const withoutToken = this.rejectionsWithoutToken.get(serverId);
    return {
      lastBatch: batch ? { ...batch } : null,
      lastRejected: withToken ? { ...withToken.last } : null,
      rejectedCount: withToken?.count ?? 0,
      lastRejectedWithoutToken: withoutToken ? { ...withoutToken.last } : null,
      rejectedWithoutTokenCount: withoutToken?.count ?? 0,
    };
  }

  private record(serverId: string | null, status: number, reason: string, withToken: boolean) {
    const now = new Date();
    if (serverId) {
      const tallies = withToken ? this.rejections : this.rejectionsWithoutToken;
      const count = (tallies.get(serverId)?.count ?? 0) + 1;
      tallies.set(serverId, { last: { at: now.toISOString(), status, reason }, count });
    }
    // Reasons are a bounded set of categories; "invalid payload: <location>" is limited as one.
    const kind = `${status} ${reason.split(":", 1)[0]}`;
    this.warn(
      serverId
        ? `rejected:${serverId}:${withToken ? "token" : "no token"}:${kind}`
        : `rejected:${UNCONFIGURED}:${kind}`,
      !serverId
        ? `Rejected a game feed delivery for an unconfigured server route: ${status} ${reason}.`
        : withToken
          ? `Rejected a game feed delivery for server ${serverId}: ${status} ${reason}.`
          : `Rejected a game feed request without the feed token for server ${serverId}: ${status} ${reason}.`,
      now.getTime(),
    );
  }

  private carriesToken(serverId: string, authorization: unknown) {
    if (authorization === undefined) return false;
    try {
      return feedCredentials(authorization, this.servers.feedToken(serverId)) === "valid";
    } catch {
      return false;
    }
  }

  private configured(id: string | undefined) {
    try {
      return this.servers.resolve(id);
    } catch {
      return null;
    }
  }

  private warn(key: string, message: string, now = Date.now()) {
    const window = this.warnings.get(key);
    if (window && window.until > now) {
      window.suppressed++;
      return;
    }
    this.warnings.set(key, { until: now + FEED_WARNING_INTERVAL_MS, suppressed: 0 });
    const suppressed = window?.suppressed ?? 0;
    this.logger.warn(
      suppressed ? `${message} (${suppressed} similar warning${suppressed === 1 ? "" : "s"} suppressed.)` : message,
    );
  }
}
