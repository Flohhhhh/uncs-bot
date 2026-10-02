import { randomUUID } from "node:crypto";
import { parseFeed } from "./telemetry.types";

const killer = "76561198000000001";
const victim = "76561198000000002";
function batch(event: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = [
    { eventId: randomUUID(), type: "killed", eventTime: 18.25, ...event },
  ];
  return { serverId: randomUUID() as string, serverName: "The UNCs", events };
}
describe("Wardogs feed parsing", () => {
  it("keeps valid boundary IDs linked and never coerces numeric or invalid account IDs", () => {
    expect(
      parseFeed(batch({ killerSteamId: "76561197960265729", victimSteamId: "76561202255233023" })).events[0],
    ).toMatchObject({ killerSteamId: "76561197960265729", victimSteamId: "76561202255233023" });
    expect(
      parseFeed(batch({ killerSteamId: "76561200000000000", victimSteamId: 76561200000000000 })).events[0],
    ).toMatchObject({ killerSteamId: "76561200000000000", victimSteamId: null });
    expect(
      parseFeed(batch({ killerSteamId: "76561197960265728", victimSteamId: "76561202255233024" })).events[0],
    ).toMatchObject({ killerSteamId: null, victimSteamId: null });
  });
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
    expect(parseFeed(value)).toMatchObject({
      skipped: 1,
      invalid: 0,
      firstInvalid: null,
      events: [expect.objectContaining({ eventTime: 18.25 })],
    });
  });
  it.each([
    [{ eventId: "secret-value" }, "events.1.eventId (bad format)"],
    [{ eventId: undefined }, "events.1.eventId (missing or wrong type)"],
    [{ eventTime: -1 }, "events.1.eventTime (under the limit)"],
    [{ eventTime: NaN }, "events.1.eventTime (missing or wrong type)"],
    [{ eventTime: Infinity }, "events.1.eventTime"],
    [{ eventTime: "18" }, "events.1.eventTime (missing or wrong type)"],
    [{ distance: -1 }, "events.1.distance (under the limit)"],
    [{ distance: Infinity }, "events.1.distance"],
    [{ killerName: "n".repeat(201) }, "events.1.killerName (over the limit)"],
    [{ contextTags: Array.from({ length: 33 }, () => "Headshot") }, "events.1.contextTags (over the limit)"],
    [{ contextTags: ["x".repeat(201)] }, "events.1.contextTags.0 (over the limit)"],
    [{ matchId: "secret-value" }, "events.1.matchId (bad format)"],
    [{ type: undefined }, "events.1.type (missing or wrong type)"],
    [{ type: 5 }, "events.1.type (missing or wrong type)"],
  ])("skips and counts a malformed killed event %j without discarding the batch", (event, firstInvalid) => {
    const value = batch();
    const good = value.events[0];
    value.events.push({ ...good, eventId: randomUUID(), ...event }, { ...good, eventId: randomUUID() });
    const result = parseFeed(value);
    expect(result.events.map((parsed) => parsed.eventId)).toEqual([good.eventId, value.events[2].eventId]);
    expect(result).toMatchObject({ skipped: 1, invalid: 1 });
    expect(result.firstInvalid).toContain(firstInvalid);
    // The label names a schema location only, never the submitted value.
    expect(result.firstInvalid).not.toMatch(/secret-value|nnnn|Headshot|xxxx/);
  });
  it("skips non-object entries and counts every invalid entry while naming only the first", () => {
    const value: { serverId: string; serverName: string; events: unknown[] } = batch();
    value.events.push(null, 5, "killed", [], { eventId: randomUUID(), eventTime: 1 });
    value.events.push({ eventId: "bad", type: "killed", eventTime: 1 }, { type: "player-joined" });
    expect(parseFeed(value)).toMatchObject({
      skipped: 7,
      invalid: 6,
      firstInvalid: "events.1 (not an object)",
      events: [expect.objectContaining({ eventTime: 18.25 })],
    });
  });
  it("accepts any hexadecimal GUID, in either case, and stores it lowercase", () => {
    // Version 0 / variant 0 GUIDs are not RFC 4122 UUIDs, which zod's uuid() rejects.
    const eventId = "ABCDEF01-2345-0789-0BCD-EF0123456789",
      matchId = "00000000-0000-0000-0000-00000000000A",
      serverId = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
    const result = parseFeed({ ...batch({ eventId, matchId }), serverId });
    expect(result).toMatchObject({ serverId: serverId.toLowerCase(), skipped: 0, invalid: 0 });
    expect(result.events[0]).toMatchObject({ eventId: eventId.toLowerCase(), matchId: matchId.toLowerCase() });
    // Case variants of one event normalize to the same ID, so storage deduplicates them.
    const repeat = batch({ eventId });
    repeat.events.push({ ...repeat.events[0], eventId: eventId.toLowerCase() });
    const ids = parseFeed(repeat).events.map((event) => event.eventId);
    expect(ids).toEqual([eventId.toLowerCase(), eventId.toLowerCase()]);
  });
  it.each([
    "{abcdef01-2345-0789-0bcd-ef0123456789}",
    "abcdef0123450789 0bcdef0123456789",
    "abcdef0123450789-0bcd-ef0123456789",
    "abcdef01-2345-0789-0bcd-ef012345678",
    "abcdef01-2345-0789-0bcd-ef012345678g",
    " abcdef01-2345-0789-0bcd-ef0123456789",
  ])("still refuses a non-GUID ID: %s", (id) => {
    expect(parseFeed(batch({ eventId: id }))).toMatchObject({ events: [], skipped: 1, invalid: 1 });
    expect(() => parseFeed({ ...batch(), serverId: id })).toThrow("Invalid feed batch");
  });
  it("still refuses a malformed batch envelope", () => {
    const value = batch();
    const { serverId: _serverId, ...noServer } = value;
    for (const invalid of [
      noServer,
      { ...value, serverId: "not-a-uuid" },
      { ...value, serverName: "x".repeat(201) },
      { ...value, events: value.events[0] },
      { ...value, events: undefined },
      { ...value, events: Array.from({ length: 201 }, () => value.events[0]) },
      null,
      [value],
    ])
      expect(() => parseFeed(invalid)).toThrow("Invalid feed batch or event count");
    expect(() => parseFeed({ ...value, ignored: "x".repeat(65536) })).toThrow("64 KiB");
    expect(parseFeed({ ...value, events: Array.from({ length: 200 }, () => value.events[0]) }).events).toHaveLength(
      200,
    );
  });
});
