import { Injectable, Logger } from "@nestjs/common";
import { GameServers } from "../admin/game-servers";

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
  lastRejected: FeedRejection | null;
  rejectedCount: number;
};

export const FEED_WARNING_INTERVAL_MS = 60_000;
const UNCONFIGURED = "(unconfigured)";
const INGEST_ROUTE = /^\/api\/ingest(?:\/servers\/([^/?#]*))?\/events\/?(?:[?#]|$)/i;

/**
 * Per-server, in-memory record of game feed deliveries that reached Gramps, so staff can tell
 * "nothing arrived" from "arrived but rejected" or "partly accepted". It holds only times, counts,
 * HTTP statuses and fixed categories: never tokens, headers, bodies or addresses. It resets on
 * restart.
 */
@Injectable()
export class TelemetryDeliveries {
  private readonly logger = new Logger(TelemetryDeliveries.name);
  private readonly rejections = new Map<string, { last: FeedRejection; count: number }>();
  private readonly batches = new Map<string, FeedBatchReceipt>();
  // One warning per server and kind per interval; later ones are counted and summarized in the next.
  private readonly warnings = new Map<string, { until: number; suppressed: number }>();

  constructor(private readonly servers: GameServers) {}

  /** Records a refused delivery. A route that names no configured server is only logged. */
  rejected(id: string | undefined, status: number, reason: string) {
    const serverId = this.configured(id);
    const now = new Date();
    if (serverId) {
      const count = (this.rejections.get(serverId)?.count ?? 0) + 1;
      this.rejections.set(serverId, { last: { at: now.toISOString(), status, reason }, count });
    }
    this.warn(
      serverId ?? UNCONFIGURED,
      serverId
        ? `Rejected a game feed delivery for server ${serverId}: ${status} ${reason}.`
        : `Rejected a game feed delivery for an unconfigured server route: ${status} ${reason}.`,
      now.getTime(),
    );
  }

  /** Records a stored batch for a resolved server, including how many entries were skipped. */
  accepted(serverId: string, batch: Omit<FeedBatchReceipt, "at">) {
    const now = new Date();
    const { accepted, skipped, invalid, firstInvalid } = batch;
    this.batches.set(serverId, { at: now.toISOString(), accepted, skipped, invalid, firstInvalid });
    if (invalid)
      this.warn(
        `${serverId}:invalid`,
        `Accepted a game feed batch for server ${serverId} but skipped ${invalid} invalid ` +
          `${invalid === 1 ? "entry" : "entries"}; first: ${firstInvalid ?? "unknown"}.`,
        now.getTime(),
      );
  }

  /** Records a refusal made before the ingest controller ran. Returns false for other routes. */
  rejectedRequest(url: string, status: number, reason: string) {
    const route = INGEST_ROUTE.exec(url);
    if (!route) return false;
    let id: string | undefined;
    try {
      id = route[1] === undefined ? undefined : decodeURIComponent(route[1]);
    } catch {
      id = UNCONFIGURED;
    }
    this.rejected(id, status, reason);
    return true;
  }

  status(serverId: string): FeedDeliveryStatus {
    const entry = this.rejections.get(serverId);
    const batch = this.batches.get(serverId);
    return {
      lastBatch: batch ? { ...batch } : null,
      lastRejected: entry ? { ...entry.last } : null,
      rejectedCount: entry?.count ?? 0,
    };
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
