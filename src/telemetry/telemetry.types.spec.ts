import { randomUUID } from "node:crypto";
import { parseFeed } from "./telemetry.types";

const killer = "76561198000000001";
const victim = "76561198000000002";
function batch(event: Record<string, unknown> = {}) {
  return {
    serverId: randomUUID(),
    serverName: "The UNCs",
    events: [{ eventId: randomUUID(), type: "killed", eventTime: 18.25, ...event }],
  };
}
describe("Wardogs feed parsing", () => {
  it("keeps the game clock separate and strips non-game fields", () => {
    const input = batch({
      killerSteamId: killer,
      victimSteamId: victim,
      killerName: "Player\nName",
      distance: 12345,
      email: "private@example.test",
      discordId: "private",
      role: "admin",
      contextTags: ["Meta.Progression.Context.Player.KillContext.Headshot"],
    });
    const result = parseFeed({ ...input, token: "private", tenant: "other-server" });
    expect(result.events[0]).toMatchObject({
      eventTime: 18.25,
      killerName: "PlayerName",
      distanceCentimeters: 12345,
      headshot: true,
      suicide: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|tenant|role|email|discordId/);
    expect(result.serverId).toBe(input.serverId);
  });
  it("accepts minimal environmental deaths and retains invalid actors only as unlinked names", () => {
    const event = parseFeed(batch({ killerSteamId: { bad: "id" }, killerName: "Unlinked", victimSteamId: victim }))
      .events[0];
    expect(event).toMatchObject({
      killerSteamId: null,
      killerName: "Unlinked",
      victimSteamId: victim,
      cause: null,
      distanceCentimeters: null,
      matchId: null,
    });
    expect(parseFeed(batch()).events[0]).toMatchObject({ killerSteamId: null, victimSteamId: null });
  });
  it.each([
    { killerSteamId: killer, victimSteamId: killer },
    { contextTags: ["Meta.PlayerKillFlag.Player.Suicide"] },
    { contextTags: ["Meta.Progression.Context.Player.KillContext.Suicide"] },
  ])("recognizes suicide without crediting two unrelated unlinked actors", (event) => {
    expect(parseFeed(batch(event)).events[0].suicide).toBe(true);
    expect(parseFeed(batch()).events[0].suicide).toBe(false);
  });
  it("recognizes the second headshot namespace but not a substring", () => {
    expect(parseFeed(batch({ contextTags: ["Meta.PlayerKillFlag.Player.Headshot"] })).events[0].headshot).toBe(true);
    expect(parseFeed(batch({ contextTags: ["NotHeadshot"] })).events[0].headshot).toBe(false);
  });
  it("skips new event types without inventing combat data", () => {
    const value = batch();
    value.events.push({ eventId: randomUUID(), type: "future-event", eventTime: 1 });
    expect(parseFeed(value)).toMatchObject({ skipped: 1, events: [expect.objectContaining({ eventTime: 18.25 })] });
  });
  it.each([
    { eventId: "bad" },
    { eventTime: -1 },
    { eventTime: NaN },
    { eventTime: Infinity },
    { distance: -1 },
    { distance: Infinity },
    { killerName: "n".repeat(201) },
    { contextTags: Array.from({ length: 33 }, () => "Headshot") },
    { matchId: "bad" },
  ])("rejects malformed known event fields", (event) => {
    expect(() => parseFeed(batch(event))).toThrow("Invalid killed event fields");
  });
  it("bounds event count, metadata and payload bytes including discarded fields", () => {
    const value = batch();
    expect(() => parseFeed({ ...value, events: Array.from({ length: 201 }, () => value.events[0]) })).toThrow();
    expect(() => parseFeed({ ...value, serverId: "not-a-uuid" })).toThrow();
    expect(() => parseFeed({ ...value, serverName: "x".repeat(201) })).toThrow();
    expect(() => parseFeed({ ...value, ignored: "x".repeat(65536) })).toThrow("64 KiB");
  });
});
