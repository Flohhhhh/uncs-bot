import { Logger } from "@nestjs/common";
import type { Client } from "discord.js";
import type { AdminStore } from "../admin/admin.store";
import type { GameServers } from "../admin/game-servers";
import type { EnvService } from "../env/env.service";
import { Env } from "../env/env";
import {
  CommunitySenderLock,
  SENDER_CHECK_MS,
  SENDER_LEASE_MS,
  SENDER_RECONNECT_MS,
  senderLockKey,
  type SenderLockConnection,
} from "./community-sender";
import { ServerCommunityService } from "./server-community.service";

/** Session advisory locks as PostgreSQL keeps them: one owner per key, released when its session ends. */
class FakeDatabase {
  readonly owners = new Map<string, FakeConnection>();
  readonly connections: FakeConnection[] = [];
  failConnect = false;
  readonly connect = jest.fn(async () => {
    if (this.failConnect) throw new Error("could not connect");
    const connection = new FakeConnection(this);
    this.connections.push(connection);
    return connection;
  });
}

class FakeConnection implements SenderLockConnection {
  closed = false;
  /** "fail" rejects the next queries; "hang" never answers them. */
  mode: "answer" | "fail" | "hang" = "answer";
  private readonly listeners: (() => void)[] = [];
  constructor(private readonly db: FakeDatabase) {}
  readonly query = jest.fn(async (text: string, values: unknown[] = []) => {
    if (this.closed || this.mode === "fail") throw new Error("Query read timeout");
    if (this.mode === "hang") return new Promise<Record<string, unknown>[]>(() => undefined);
    if (text === "SELECT 1") return [{ "?column?": 1 }];
    const key = JSON.stringify(values);
    const owner = this.db.owners.get(key);
    if (owner && owner !== this) return [{ locked: false }];
    this.db.owners.set(key, this);
    return [{ locked: true }];
  });
  readonly end = jest.fn(async () => this.drop());
  onClose(listener: () => void) {
    this.listeners.push(listener);
  }
  /** The session ends, as on a server restart or a lost network: its locks go, and the client hears of it. */
  drop() {
    if (this.closed) return;
    this.closed = true;
    for (const [key, owner] of this.db.owners) if (owner === this) this.db.owners.delete(key);
    for (const listener of this.listeners) listener();
  }
}

const settle = () => jest.advanceTimersByTimeAsync(0);
let warn: jest.SpyInstance;
let log: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-03T12:00:00Z"));
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("community sender lock", () => {
  it("uses fixed two-key locks per server, so old and new processes always ask for the same one", () => {
    // Changing these would let a deploy's old and new processes both send. Keep them stable.
    expect(senderLockKey("primary")).toEqual([-2057738102, -1120149926]);
    expect(senderLockKey("event")).toEqual([-340223894, -1128377691]);
    for (const key of [...senderLockKey("primary"), ...senderLockKey("event")]) expect(key === (key | 0)).toBe(true);
  });

  it("starts without waiting for the database and holds a steady lease per server once confirmed", async () => {
    const db = new FakeDatabase();
    const lock = new CommunitySenderLock(["primary", "event"], db.connect);
    lock.start();
    expect(lock.lease("primary")).toBeNull();
    await settle();
    const primary = lock.lease("primary");
    const event = lock.lease("event");
    expect(primary).toEqual(expect.any(Number));
    expect(event).toEqual(expect.any(Number));
    expect(event).not.toBe(primary);
    expect(db.connections[0].query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      senderLockKey("primary"),
    );
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS * 10);
    expect([lock.lease("primary"), lock.lease("event")]).toEqual([primary, event]);
    expect(db.connect).toHaveBeenCalledTimes(1);
    await lock.stop();
  });

  it("lets a second process observe until the first stops, then take over at its next check", async () => {
    const db = new FakeDatabase();
    const first = new CommunitySenderLock(["primary"], db.connect);
    const second = new CommunitySenderLock(["primary"], db.connect);
    first.start();
    await settle();
    second.start();
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS * 6);
    expect(first.lease("primary")).toEqual(expect.any(Number));
    expect(second.lease("primary")).toBeNull();
    expect(log.mock.calls.filter(([text]) => String(text).startsWith("Another Gramps process"))).toHaveLength(1);
    await first.stop();
    expect(first.lease("primary")).toBeNull();
    expect(db.connections[0].end).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS);
    expect(second.lease("primary")).toEqual(expect.any(Number));
    await second.stop();
  });

  it("stops at once when its connection closes, then reconnects under a new lease", async () => {
    const db = new FakeDatabase();
    const lock = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    const before = lock.lease("primary");
    db.connections[0].drop();
    expect(lock.lease("primary")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Stopped sending in-game community messages for primary"),
    );
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS);
    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(lock.lease("primary")).toEqual(expect.any(Number));
    expect(lock.lease("primary")).not.toBe(before);
    await lock.stop();
  });

  it("never trusts a lock granted on a session that ended before the answer was read", async () => {
    const db = new FakeDatabase();
    // The lock is granted and the session ends together, as when the server's answer and its termination
    // notice arrive in one read. PostgreSQL released the lock with that session.
    const connect = jest.fn(async () => {
      const connection = await db.connect();
      if (db.connections.length === 1) {
        const answer = connection.query.getMockImplementation()!;
        connection.query.mockImplementation(async (text, values) => {
          const rows = await answer(text, values);
          if (text !== "SELECT 1") connection.drop();
          return rows;
        });
      }
      return connection;
    });
    const lock = new CommunitySenderLock(["primary"], connect);
    const other = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    other.start();
    await settle();
    expect(other.lease("primary")).toEqual(expect.any(Number));
    // After reconnecting, this process must ask its new session again rather than reuse the stale answer.
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(lock.lease("primary")).toBeNull();
    expect(other.lease("primary")).toEqual(expect.any(Number));
    await Promise.all([lock.stop(), other.stop()]);
  });

  it("treats a failed check as a lost connection and closes it", async () => {
    const db = new FakeDatabase();
    const lock = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    db.connections[0].mode = "fail";
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS);
    expect(lock.lease("primary")).toBeNull();
    expect(db.connections[0].end).toHaveBeenCalled();
    await lock.stop();
  });

  it("lets the lease lapse when checks stop answering, before the connection reports anything", async () => {
    const db = new FakeDatabase();
    const lock = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    await jest.advanceTimersByTimeAsync(SENDER_CHECK_MS);
    const confirmedAt = Date.now();
    db.connections[0].mode = "hang";
    await jest.advanceTimersByTimeAsync(SENDER_LEASE_MS - 1);
    expect(lock.lease("primary")).toEqual(expect.any(Number));
    await jest.advanceTimersByTimeAsync(1);
    expect(Date.now() - confirmedAt).toBe(SENDER_LEASE_MS);
    expect(lock.lease("primary")).toBeNull();
    await lock.stop();
  });

  it("never throws when the connection cannot be opened, warns once and retries every 30 seconds", async () => {
    const db = new FakeDatabase();
    db.failConnect = true;
    const lock = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    await jest.advanceTimersByTimeAsync(SENDER_RECONNECT_MS * 3);
    expect(db.connect).toHaveBeenCalledTimes(4);
    expect(lock.lease("primary")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("In-game community messages are paused"));
    db.failConnect = false;
    await jest.advanceTimersByTimeAsync(SENDER_RECONNECT_MS);
    expect(lock.lease("primary")).toEqual(expect.any(Number));
    await lock.stop();
  });

  it("closes its connection on shutdown, releasing the lock, and schedules nothing more", async () => {
    const db = new FakeDatabase();
    const lock = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    await lock.stop();
    expect(db.connections[0].end).toHaveBeenCalledTimes(1);
    expect(db.owners.size).toBe(0);
    expect(lock.lease("primary")).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("closes a connection that opens after shutdown began", async () => {
    const db = new FakeDatabase();
    let open!: () => void;
    const pending = new Promise<void>((resolve) => {
      open = resolve;
    });
    const connect = jest.fn(async () => {
      await pending;
      return db.connect();
    });
    const lock = new CommunitySenderLock(["primary"], connect);
    lock.start();
    await settle();
    const stopped = lock.stop();
    open();
    await stopped;
    await settle();
    expect(db.connections[0].end).toHaveBeenCalled();
    expect(db.owners.size).toBe(0);
    expect(lock.lease("primary")).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("finishes shutting down within two seconds when its connection does not close", async () => {
    const db = new FakeDatabase();
    const lock = new CommunitySenderLock(["primary"], db.connect);
    lock.start();
    await settle();
    db.connections[0].end.mockImplementation(() => new Promise<void>(() => undefined));
    let stopped = false;
    void lock.stop().then(() => {
      stopped = true;
    });
    expect(lock.lease("primary")).toBeNull();
    await jest.advanceTimersByTimeAsync(1_999);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
  });
});

describe("one sender per server across overlapping processes", () => {
  const url = "postgresql://user:secret@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const settings = {
    SERVER_COMMUNITY_ENABLED: true,
    SERVER_COMMUNITY_WELCOME_ENABLED: true,
    SERVER_COMMUNITY_ROUND_ENABLED: false,
    SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: false,
    SERVER_COMMUNITY_WELCOME_MESSAGE: "Welcome",
    SERVER_COMMUNITY_ROUND_MESSAGE: "GG",
    SERVER_COMMUNITY_WELCOME_DELAY_SECONDS: 0,
    SERVER_COMMUNITY_WELCOME_SPACING_SECONDS: 20,
    DATABASE_URL_UNPOOLED: url,
  };
  const ids = ["76561198000000001", "76561198000000002", "76561198000000003"];
  let roster: string[] = [];
  /** One Gramps process watching the same game server as any other started here. */
  function gramps(db: FakeDatabase, overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = { ...settings, ...overrides };
    const game = {
      overview: jest.fn(async () => ({
        observedAt: new Date().toISOString(),
        capabilities: { routes: [] },
        status: {
          serverName: "The UNCs",
          map: "Europe",
          players: { current: roster.length, max: 100 },
          factionScores: [],
        },
        players: roster.map((steamId) => ({ name: "Example player", steamId })),
      })),
      execute: jest.fn().mockResolvedValue({ state: "accepted", message: "Accepted." }),
      reservedSlots: jest.fn(),
    };
    const servers = {
      list: () => [{ id: "primary", name: "primary", version: "0".repeat(64) }],
      get: () => game,
      resolve: (id?: string) => id ?? "primary",
    };
    const store = {
      begin: jest.fn().mockResolvedValue({ created: true, record: {} }),
      finish: jest.fn().mockResolvedValue(undefined),
    };
    const connectLock = jest.fn(() => db.connect);
    const service = new ServerCommunityService(
      servers as unknown as GameServers,
      store as unknown as AdminStore,
      { get: (key: string) => values[key] } as EnvService,
      { isReady: () => false } as unknown as Client,
      connectLock,
    );
    service.onApplicationBootstrap();
    const welcomed = () => game.execute.mock.calls.map(([action]) => action.steamId);
    return { service, game, connectLock, welcomed };
  }
  beforeEach(() => {
    roster = [ids[0]];
  });

  it("welcomes from one process during a deploy and hands over within seconds when it stops", async () => {
    const db = new FakeDatabase();
    const old = gramps(db);
    await jest.advanceTimersByTimeAsync(10_000);
    const next = gramps(db);
    await jest.advanceTimersByTimeAsync(2_000);
    roster = ids.slice(0, 2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(old.welcomed()).toEqual([ids[1]]);
    expect(next.welcomed()).toEqual([]);
    expect(next.connectLock).toHaveBeenCalledWith(url);
    await old.service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(15_000);
    roster = ids;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(old.welcomed()).toEqual([ids[1]]);
    expect(next.welcomed()).toEqual([ids[2]]);
    await next.service.onModuleDestroy();
    expect(db.owners.size).toBe(0);
  });

  it("sends nothing anywhere while the lock is configured but cannot be confirmed", async () => {
    const db = new FakeDatabase();
    db.failConnect = true;
    const processes = [gramps(db), gramps(db)];
    await jest.advanceTimersByTimeAsync(10_000);
    roster = ids;
    await jest.advanceTimersByTimeAsync(60_000);
    for (const { welcomed } of processes) expect(welcomed()).toEqual([]);
    for (const { service } of processes) await service.onModuleDestroy();
  });

  it.each([
    // Today's behaviour: every running process welcomes the joiner.
    ["DATABASE_URL_UNPOOLED is unset", { DATABASE_URL_UNPOOLED: undefined }, [ids[1]]],
    [
      "only the status card is on",
      { SERVER_COMMUNITY_WELCOME_ENABLED: false, SERVER_COMMUNITY_DISCORD_STATUS_ENABLED: true },
      [],
    ],
  ])("opens no lock connection and keeps today's behaviour when %s", async (_, overrides, expected) => {
    const db = new FakeDatabase();
    const processes = [gramps(db, overrides), gramps(db, overrides)];
    await jest.advanceTimersByTimeAsync(10_000);
    roster = ids.slice(0, 2);
    await jest.advanceTimersByTimeAsync(10_000);
    for (const { welcomed, connectLock } of processes) {
      expect(connectLock).not.toHaveBeenCalled();
      expect(welcomed()).toEqual(expected);
    }
    expect(db.connect).not.toHaveBeenCalled();
    for (const { service } of processes) await service.onModuleDestroy();
  });
});

describe("DATABASE_URL_UNPOOLED setting", () => {
  it.each([undefined, "", "   "])("is optional, and blank counts as unset: %p", (value) => {
    expect(Env.shape.DATABASE_URL_UNPOOLED.parse(value)).toBeUndefined();
  });

  it.each([
    "postgresql://user:secret@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require",
    "postgres://user:secret@127.0.0.1:5432/uncs",
  ])("accepts a direct connection string: %s", (value) => {
    expect(Env.shape.DATABASE_URL_UNPOOLED.parse(value)).toBe(value);
  });

  it.each([
    "postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    "postgresql://user:secret@EP-EXAMPLE-POOLER.us-east-2.aws.neon.tech/neondb",
    "https://ep-example.us-east-2.aws.neon.tech/neondb",
    "not a connection string",
  ])("refuses a pooled or malformed value without repeating it: %s", (value) => {
    const result = Env.shape.DATABASE_URL_UNPOOLED.safeParse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("secret");
  });
});
