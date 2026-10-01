import { describe, expect, it } from "vitest";
import { allowed, rejectionState } from "./policy";
import { context, overview } from "../players/test-fixtures";
import { liveFactions, playerFaction } from "../players/factions";

describe("action authority and live factions", () => {
  it("normalizes route placeholders but requires the exact capability", () => {
    const state = context();
    expect(allowed("team", state.me, state.overview, false, false)).toBe(true);
    state.overview!.capabilities.routes = ["GET /v1/players"];
    expect(allowed("team", state.me, state.overview, false, false)).toBe(false);
  });
  it.each(["viewer", "moderator"] as const)("does not give %s whitelist authority", (role) => {
    const state = context();
    expect(allowed("whitelist-add", { ...state.me, role }, state.overview, false, false)).toBe(false);
  });
  it("blocks stale, busy, and signed-out actions", () => {
    const state = context();
    expect(allowed("kick", state.me, state.overview, true, false)).toBe(false);
    expect(allowed("kick", state.me, state.overview, false, true)).toBe(false);
    expect(allowed("kick", null, state.overview, false, false)).toBe(false);
  });
  it("permits explicit live whitelist routes even if config is locked", () => {
    const state = context();
    state.overview!.capabilities.config = { writable: false };
    expect(allowed("whitelist-add", state.me, state.overview, false, false)).toBe(true);
    state.overview!.capabilities.routes = ["PUT /v1/config"];
    expect(allowed("whitelist-add", state.me, state.overview, false, false)).toBe(false);
  });
  it("maps only unique official colors and prefers exact faction names", () => {
    const data = overview();
    const teams = liveFactions(data);
    expect(playerFaction({ name: "Player", steamId: "76561198000000000", faction: "blu" }, teams)?.name).toBe(
      "Lonestar",
    );
    expect(playerFaction({ name: "Player", steamId: "76561198000000000", faction: "Valkyra" }, teams)?.name).toBe(
      "Valkyra",
    );
    data.status.factionScores.push({ name: "Other blue", colorHex: "5b95d8", score: 0 });
    expect(liveFactions(data).filter((team) => team.code === "BLU")).toHaveLength(0);
    data.status.factionScores.push({ name: "Valkyra", colorHex: "javascript:alert(1)", score: 0 });
    expect(liveFactions(data).some((team) => team.name === "Valkyra")).toBe(false);
  });
  it("treats transport and server failures as uncertain but definite rejection as failed", () => {
    expect(rejectionState({ status: 429 })).toBe("failed");
    expect(rejectionState({ status: 503 })).toBe("unknown");
    expect(rejectionState(new Error("Network dropped"))).toBe("unknown");
  });
});
