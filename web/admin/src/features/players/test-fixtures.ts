import { vi } from "vitest";
import type { Overview } from "../../api/types";
import type { AdminContextValue } from "../../app/context";

export const alice = {
  name: "UNC Alice",
  steamId: "76561198000000001",
  faction: "RED",
  kills: 3,
  deaths: 1,
  pingMs: 40,
};
export const bob = { name: "Bob", steamId: "76561198000000002", faction: "RED" };
export const cara = { name: "Cara", steamId: "76561198000000003", faction: "BLU" };
export function overview(): Overview {
  return {
    observedAt: "2026-09-30T18:00:00Z",
    players: [alice, bob, cara],
    status: {
      serverName: "The UNCs",
      map: "Harbor",
      players: { current: 3, max: 100 },
      factionScores: [
        { name: "Valkyra", colorHex: "D86060", score: 10 },
        { name: "Lonestar", colorHex: "#5B95D8", score: 20 },
      ],
    },
    capabilities: {
      routes: [
        "POST /v1/players/{steamId}/kick",
        "POST /v1/bans",
        "DELETE /v1/bans/{steamId}",
        "POST /v1/reserved-slots",
        "DELETE /v1/reserved-slots/{steamId}",
        "POST /v1/players/{steamId}/kill",
        "POST /v1/players/{steamId}/message",
        "PATCH /v1/players/{steamId}",
        "POST /v1/broadcast",
        "POST /v1/match/end",
        "POST /v1/match/restart",
        "POST /v1/match/map",
        "PUT /v1/world/lighting",
      ],
    },
  };
}
export function context(overrides: Partial<AdminContextValue> = {}): AdminContextValue {
  return {
    me: { id: "12345678901234567", name: "Staff", role: "admin", csrf: "fixture" },
    overview: overview(),
    stale: false,
    busy: false,
    dialogOpen: false,
    setBusy: vi.fn(),
    setDialogOpen: vi.fn(),
    setUnsavedChanges: vi.fn(),
    refreshVersion: 0,
    refresh: vi.fn(),
    invalidateOverview: vi.fn(),
    openAction: vi.fn(),
    ...overrides,
  };
}
