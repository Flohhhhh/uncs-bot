// Isolated test fixtures: fictitious roster and endpoint; never contact a game server.
import { createHash, randomUUID } from "node:crypto";
import { initialEventProgress, type EventRecord, type EventSnapshot } from "./server-events.types";
export const eventNow = Date.parse("2026-10-01T10:00:00Z");
export const eventStaff = { id: "123456789012345678", name: "Test admin", role: "admin" as const, csrf: "test" };
export function snapshotAt(
  now = eventNow,
  seconds = 120,
  teams: Array<string | null> = ["RED", "BLU", "GRN"],
): EventSnapshot {
  return {
    observedAt: new Date(now).toISOString(),
    capabilities: {
      routes: [
        "PATCH /v1/players/{id}",
        "POST /v1/players/{id}/kill",
        "POST /v1/players/{id}/message",
        "POST /v1/broadcast",
        "PUT /v1/config",
      ],
      limits: { maxRequestsPerMinutePerIp: 120 },
    },
    status: {
      serverName: "Test UNCs",
      map: "Kavkazi",
      matchSeconds: seconds,
      players: { current: teams.length, max: 100 },
      factionScores: [
        { name: "Valkyra", colorHex: "#D86060", score: 0 },
        { name: "Lonestar", colorHex: "#5B95D8", score: 0 },
        { name: "Manticore", colorHex: "#7BC462", score: 0 },
      ],
    },
    players: teams.map((faction, index) => ({
      steamId: String(76561198123456789n + BigInt(index)),
      name: "Same name",
      faction,
    })),
  };
}
export function eventFixture(): EventRecord {
  const progress = initialEventProgress({ map: "Kavkazi", startedAt: eventNow - 120_000 }, eventNow);
  progress.roundWarningAt = eventNow - 60_000;
  progress.warned = Object.fromEntries(snapshotAt().players.map((p) => [p.steamId, eventNow - 60_000]));
  return {
    id: randomUUID(),
    serverId: "primary",
    serverName: "Test UNCs",
    connectionHash: createHash("sha256").update("https://game.example.test").digest("hex"),
    guildId: "234567890123456789",
    actorId: eventStaff.id,
    actorName: eventStaff.name,
    reason: "Optional community event",
    requestHash: "hash",
    options: {
      teams: ["Valkyra", "Lonestar"],
      durationMinutes: 60,
      warningSeconds: 30,
      balanceWindowSeconds: 300,
      forceRespawn: false,
    },
    originalLock: true,
    initialRevision: "r1",
    restoreRevision: "r2",
    state: "active",
    progress,
    operation: null,
    version: 1,
    message: "Watching teams",
    lastActionId: null,
    stop: null,
    createdAt: new Date(eventNow),
    updatedAt: new Date(eventNow),
    endsAt: new Date(eventNow + 3600_000),
  };
}
