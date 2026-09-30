import { describe, expect, it } from "vitest";
import { validateOverview, validateStaff } from "./validation";
import type { Overview } from "./types";

const overview = (): Overview => ({
  status: {
    serverName: "UNCs",
    map: "Harbor",
    players: { current: 1, max: 100 },
    factionScores: [{ name: "Valkyra", score: 10, colorHex: "#D86060" }],
  },
  players: [{ name: "Player", steamId: "76561198000000001", faction: null }],
  capabilities: { routes: ["POST /v1/broadcast"], config: { writable: true } },
  observedAt: "2026-09-30T18:00:00.000Z",
});
describe("browser response contracts", () => {
  it.each(["76561197960265729", "76561200000000000", "76561202255233023"])(
    "accepts structural SteamID64 boundaries in the roster: %s",
    (steamId) => {
      const data = overview();
      data.players[0].steamId = steamId;
      expect(validateOverview(data)).toBe(data);
    },
  );
  it.each(["76561197960265728", "76561202255233024", 76561200000000000])(
    "rejects out-of-range or numeric roster IDs: %s",
    (steamId) => {
      expect(() => validateOverview({ ...overview(), players: [{ name: "Player", steamId }] })).toThrow(
        "could not be verified",
      );
    },
  );
  it("accepts normal and simulated staff without weakening role or CSRF types", () => {
    expect(validateStaff({ id: "12345678901234567", name: "Staff", role: "moderator", csrf: "csrf" }).role).toBe(
      "moderator",
    );
    expect(
      validateStaff({ id: "preview", name: "Preview", role: "admin", csrf: "local-preview", demo: true }).demo,
    ).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { id: "id", name: "Name", role: "owner", csrf: "csrf" },
    { id: "id", name: "Name", role: ["admin"], csrf: "csrf" },
    { id: "id", name: "Name", role: "admin", csrf: "" },
    { id: 42, name: "Name", role: "admin", csrf: "csrf" },
  ])("rejects malformed staff data %#", (data) => {
    expect(() => validateStaff(data)).toThrow("could not be verified");
  });
  it("accepts the optional backend fields and empty roster without inventing values", () => {
    const data = overview();
    data.status = { ...data.status, lighting: "Noon", experiences: ["Standard"], scoreCap: 100, matchSeconds: 120 };
    data.players[0] = { ...data.players[0], kills: 0, deaths: 1, cash: 10, pingMs: 40 };
    data.capabilities.limits = { maxBodyBytes: 65536, maxRequestsPerMinutePerIp: 100 };
    expect(validateOverview(data)).toBe(data);
    expect(validateOverview({ ...data, players: [] }).players).toEqual([]);
  });
  it.each([
    { unexpected: true },
    { ...overview(), status: null },
    { ...overview(), observedAt: "not a date" },
    { ...overview(), players: [{ name: {}, steamId: "76561198000000001" }] },
    { ...overview(), players: [{ name: "Player", steamId: "invalid" }] },
    { ...overview(), status: { ...overview().status, factionScores: [{ name: "Valkyra", score: "10" }] } },
    { ...overview(), status: { ...overview().status, players: { current: Infinity, max: 100 } } },
    { ...overview(), status: { ...overview().status, experiences: [null] } },
    { ...overview(), capabilities: { routes: { unexpected: true } } },
    { ...overview(), capabilities: { routes: [], config: { writable: "false" } } },
    { ...overview(), capabilities: { routes: [], limits: null } },
  ])("rejects overview shapes that would crash rendering or enable controls with unverified values %#", (data) => {
    expect(() => validateOverview(data)).toThrow("Refresh before using game controls");
  });
});
