import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Client } from "pg";

/**
 * Decides which running process may send in-game community messages for a server. `lease` returns a
 * number that stays the same for as long as this process keeps that right, or null while it must only
 * observe. A different number means the right was lost and regained in between.
 */
export interface CommunitySender {
  lease(serverId: string): number | null;
}

/** Without DATABASE_URL_UNPOOLED every process sends, exactly as before the sender lock existed. */
export const EVERY_PROCESS_SENDS: CommunitySender = { lease: () => 0 };

/** The part of a dedicated database connection the sender lock uses. */
export interface SenderLockConnection {
  query(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Calls `listener` once, when the connection fails or closes. */
  onClose(listener: () => void): void;
  end(): Promise<void>;
}
export type ConnectSenderLock = () => Promise<SenderLockConnection>;
/** Optional provider of `(url) => ConnectSenderLock`, replacing the direct connection in tests. */
export const SENDER_LOCK_CONNECTION = Symbol("SENDER_LOCK_CONNECTION");

/** How often a process checks its connection and asks for the locks it does not hold. */
export const SENDER_CHECK_MS = 5_000;
/** How long to wait before trying again after the connection could not be opened. */
export const SENDER_RECONNECT_MS = 30_000;
/** A check slower than this counts as a lost connection. */
export const SENDER_QUERY_TIMEOUT_MS = 5_000;
/** Without a successful check this recent, the lease lapses even if the connection has reported nothing. */
export const SENDER_LEASE_MS = 15_000;
const SHUTDOWN_WAIT_MS = 2_000;
const CONNECT_FAILED =
  "In-game community messages are paused: DATABASE_URL_UNPOOLED could not be opened to confirm this is the only sending process. Retrying every 30 seconds.";

/**
 * Two 32-bit keys from the server ID. PostgreSQL keeps two-key advisory locks apart from single-key ones,
 * so these never meet the per-server transaction locks map votes take.
 */
export function senderLockKey(serverId: string): [number, number] {
  const digest = createHash("sha256").update(`gramps:community-sender:${serverId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * A direct, unpooled connection of its own. Session advisory locks belong to one server session, which a
 * transaction pooler such as Neon's -pooler endpoint does not keep for one client.
 */
export function directSenderConnection(connectionString: string): ConnectSenderLock {
  return async () => {
    const client = new Client({
      connectionString,
      application_name: "gramps-community-sender",
      connectionTimeoutMillis: 10_000,
      query_timeout: SENDER_QUERY_TIMEOUT_MS,
      keepAlive: true,
    });
    let closed = false;
    const listeners: (() => void)[] = [];
    const close = () => {
      if (closed) return;
      closed = true;
      for (const listener of listeners) listener();
    };
    // Never an uncaught exception: a failed or closed connection only ends this process's lease.
    client.on("error", close);
    client.on("end", close);
    try {
      await client.connect();
    } catch (error) {
      void client.end().catch(() => undefined);
      throw error;
    }
    return {
      query: async (text, values) => (await client.query(text, values)).rows,
      onClose: (listener) => {
        if (closed) queueMicrotask(listener);
        else listeners.push(listener);
      },
      end: () => client.end(),
    };
  };
}

/**
 * Holds one PostgreSQL session advisory lock per server on a dedicated connection. The lock is released
 * when that connection closes, including when the process exits, so the next process takes over within
 * seconds. Never throws and never delays startup: until a lock is confirmed, this process sends nothing.
 */
export class CommunitySenderLock implements CommunitySender {
  private readonly logger = new Logger(CommunitySenderLock.name);
  private connection: SenderLockConnection | null = null;
  private readonly held = new Map<string, number>();
  private readonly waiting = new Set<string>();
  private acquisitions = 0;
  private confirmedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private checking = false;
  private stopped = false;
  private connectWarned = false;

  constructor(
    private readonly serverIds: readonly string[],
    private readonly connect: ConnectSenderLock,
  ) {}

  lease(serverId: string) {
    if (this.stopped || !this.connection || Date.now() - this.confirmedAt >= SENDER_LEASE_MS) return null;
    return this.held.get(serverId) ?? null;
  }

  start() {
    this.schedule(0);
  }

  /** Stops checking and closes the connection, which releases every lock this process holds. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.held.clear();
    const connection = this.connection;
    this.connection = null;
    if (connection) await this.close(connection);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.check().then((next) => this.schedule(next));
    }, delay);
    this.timer.unref();
  }

  /** One pass: connect if needed, prove the connection alive, then ask for each lock it lacks. Never throws. */
  async check(): Promise<number> {
    if (this.stopped || this.checking) return SENDER_CHECK_MS;
    this.checking = true;
    try {
      const connection = this.connection ?? (await this.open());
      if (!connection) return SENDER_RECONNECT_MS;
      const checkedAt = Date.now();
      try {
        // A session keeps its advisory locks for as long as it lives, so a live connection still holds them.
        await connection.query("SELECT 1");
        if (this.connection !== connection) return SENDER_CHECK_MS;
        this.confirmedAt = checkedAt;
        for (const serverId of this.serverIds) {
          if (this.held.has(serverId)) continue;
          const rows = await connection.query("SELECT pg_try_advisory_lock($1, $2) AS locked", senderLockKey(serverId));
          if (this.connection !== connection) return SENDER_CHECK_MS;
          if (rows[0]?.locked === true) {
            this.held.set(serverId, ++this.acquisitions);
            this.waiting.delete(serverId);
            this.logger.log(`Sending in-game community messages for ${serverId} from this process.`);
          } else if (!this.waiting.has(serverId)) {
            this.waiting.add(serverId);
            this.logger.log(
              `Another Gramps process is sending in-game community messages for ${serverId}. This process keeps observing and takes over when that one stops.`,
            );
          }
        }
      } catch {
        this.lose(connection);
      }
      return SENDER_CHECK_MS;
    } finally {
      this.checking = false;
    }
  }

  private async open() {
    let connection: SenderLockConnection;
    try {
      connection = await this.connect();
    } catch {
      if (!this.stopped && !this.connectWarned) this.logger.warn(CONNECT_FAILED);
      this.connectWarned = true;
      return null;
    }
    if (this.stopped) {
      void this.close(connection);
      return null;
    }
    this.connectWarned = false;
    this.connection = connection;
    connection.onClose(() => this.lose(connection));
    return connection;
  }

  /** Stops sending at once: whatever this connection held may already belong to another process. */
  private lose(connection: SenderLockConnection) {
    if (this.connection !== connection) return;
    this.connection = null;
    const lost = [...this.held.keys()];
    this.held.clear();
    this.waiting.clear();
    this.logger.warn(
      lost.length
        ? `Stopped sending in-game community messages for ${lost.join(", ")}: the sender lock's database connection closed. Reconnecting.`
        : "The sender lock's database connection closed. Reconnecting.",
    );
    void this.close(connection);
  }

  private async close(connection: SenderLockConnection) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      connection.end().catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_WAIT_MS);
        timeout.unref();
      }),
    ]);
    clearTimeout(timeout);
  }
}
