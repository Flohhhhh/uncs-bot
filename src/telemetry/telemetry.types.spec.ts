import { randomUUID } from "node:crypto";
import { MAX_SAMPLE_BYTES, parseFeed } from "./telemetry.types";

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
  it("counts new event types without inventing combat data", () => {
    const value = batch();
    const future = { eventId: randomUUID(), type: "future-event", eventTime: 1 };
    value.events.push(future);
    expect(parseFeed(value)).toMatchObject({
      skipped: 1,
      invalid: 0,
      firstInvalid: null,
      types: [
        { type: "killed", count: 1, sample: null },
        { type: "future-event", count: 1, sample: future },
      ],
      events: [expect.objectContaining({ eventTime: 18.25 })],
    });
  });
  it("tallies every event type in first-seen order with the latest entry of each, killed unchanged", () => {
    const value = batch({ killerSteamId: killer, victimSteamId: victim, contextTags: ["Headshot"] });
    const kill = value.events[0];
    const joined = (name: string) => ({ type: "playerJoined", steamId: killer, name });
    value.events.push(
      joined("First"),
      { type: "Round.Result:v2", winner: "East", scores: [1, 2] },
      { ...kill, eventId: "bad", type: "killed" },
      joined("Second"),
      { ...kill, eventId: randomUUID() },
      joined("Latest"),
    );
    const result = parseFeed(value);
    expect(result.types).toEqual([
      { type: "killed", count: 2, sample: null },
      { type: "playerJoined", count: 3, sample: joined("Latest") },
      { type: "Round.Result:v2", count: 1, sample: { type: "Round.Result:v2", winner: "East", scores: [1, 2] } },
    ]);
    // Other types are counted as skipped as before; the malformed killed event is invalid, not tallied.
    expect(result).toMatchObject({ skipped: 5, invalid: 1, firstInvalid: "events.3.eventId (bad format)" });
    expect(result.events).toEqual([
      expect.objectContaining({ eventId: kill.eventId, killerSteamId: killer, headshot: true, suicide: false }),
      expect.objectContaining({ eventId: value.events[5].eventId }),
    ]);
    expect(Object.keys(result.events[0]).sort()).toEqual(Object.keys(parseFeed(batch()).events[0]).sort());
    expect(parseFeed({ ...value, events: [] }).types).toEqual([]);
  });
  it("keeps a sample only up to 4 KiB, keeping an earlier fitting one or a size marker", () => {
    // Pads an entry to an exact serialized size in bytes.
    const sized = (bytes: number, label: string) => {
      const entry = { type: "bulk", label, padding: "" };
      entry.padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(entry)));
      expect(Buffer.byteLength(JSON.stringify(entry))).toBe(bytes);
      return entry;
    };
    const atCap = sized(MAX_SAMPLE_BYTES, "fits");
    const over = sized(MAX_SAMPLE_BYTES + 1, "over");
    const types = (...events: unknown[]) => parseFeed({ ...batch(), events }).types;
    expect(types(over, atCap)).toEqual([{ type: "bulk", count: 2, sample: atCap }]);
    expect(types(atCap, over)).toEqual([{ type: "bulk", count: 2, sample: atCap }]);
    expect(types(over, sized(5_000, "later"))).toEqual([
      { type: "bulk", count: 2, sample: { tooLarge: true, bytes: 5_000 } },
    ]);
  });
  it("makes samples storable in PostgreSQL jsonb and drops IP addresses", () => {
    const [entry] = parseFeed({
      ...batch(),
      events: [
        {
          type: "playerConnected",
          name: "Nul\u0000Name\uD800",
          ["key\u0000"]: "\uDC00",
          address: "203.0.113.7:7777",
          ipv6: "2001:db8::1",
          bracketed: "[2001:db8::1]:7777",
          nested: [{ ip: " 198.51.100.2 " }],
          time: "12:30:45",
          version: "1.2.3",
        },
      ],
    }).types;
    expect(entry.sample).toEqual({
      type: "playerConnected",
      name: "NulName\uFFFD",
      key: "\uFFFD",
      address: "[IP address removed]",
      ipv6: "[IP address removed]",
      bracketed: "[IP address removed]",
      nested: [{ ip: "[IP address removed]" }],
      time: "12:30:45",
      version: "1.2.3",
    });
    expect(JSON.stringify(entry.sample)).not.toMatch(/\\u0000|\\ud[89a-f]|203\.0\.113|2001:db8|198\.51/i);
  });
  it("removes IP addresses from keys and from inside text, with or without a port", () => {
    const [entry] = parseFeed({
      ...batch(),
      events: [
        {
          type: "conn",
          keyed: { "203.0.113.5": 1 },
          mapped: "::ffff:203.0.113.5:7777",
          slashed: "203.0.113.5/7777",
          joined: "steam:76561198000000001@203.0.113.5",
          text: "from 2001:db8::1 (fe80::1%eth0), addr:198.51.100.2.",
          kept: "v1.2.3.4 at 12:30:45, Meta::Event, build 1.2.3",
        },
      ],
    }).types;
    expect(entry.sample).toEqual({
      type: "conn",
      keyed: { "[IP address removed]": 1 },
      mapped: "[IP address removed]",
      slashed: "[IP address removed]/7777",
      joined: "steam:76561198000000001@[IP address removed]",
      text: "from [IP address removed] ([IP address removed]), addr:[IP address removed].",
      kept: "v1.2.3.4 at 12:30:45, Meta::Event, build 1.2.3",
    });
    expect(JSON.stringify(entry.sample)).not.toMatch(/203\.0\.113|2001:db8|198\.51|fe80/);
  });
  it("caps a sample by its size as stored, after IP addresses are replaced", () => {
    // Each "::" is an IPv6 address that grows from 4 to 22 bytes of JSON when replaced.
    const addresses = { type: "conn", a: [] as string[] };
    while (Buffer.byteLength(JSON.stringify({ ...addresses, a: [...addresses.a, "::"] })) <= MAX_SAMPLE_BYTES)
      addresses.a.push("::");
    expect(Buffer.byteLength(JSON.stringify(addresses))).toBeGreaterThan(MAX_SAMPLE_BYTES - 5);
    const [entry] = parseFeed({ ...batch(), events: [addresses] }).types;
    expect(entry.sample).toEqual({ tooLarge: true, bytes: expect.any(Number) });
    expect((entry.sample as { bytes: number }).bytes).toBeGreaterThan(4 * MAX_SAMPLE_BYTES);
    // An entry that still fits once replaced keeps its sample.
    const [small] = parseFeed({ ...batch(), events: [{ type: "conn", a: ["::", "::"] }] }).types;
    expect(small.sample).toEqual({ type: "conn", a: ["[IP address removed]", "[IP address removed]"] });
  });
  it("keeps numbers that JSON writes with an exponent as text, so jsonb cannot print them longer", () => {
    const [entry] = parseFeed({
      ...batch(),
      events: [{ type: "probe", v: [1e308, 5e-324, 1e21, 1e-7, 1e20, 123.5, -0.000001, 0] }],
    }).types;
    expect(entry.sample).toEqual({
      type: "probe",
      v: ["1e+308", "5e-324", "1e+21", "1e-7", 1e20, 123.5, -0.000001, 0],
    });
    // 582 such numbers fit 4 KiB as sent but would print as about 180 KB from jsonb.
    const huge = { type: "probe", v: Array.from({ length: 582 }, () => 1e308) };
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(MAX_SAMPLE_BYTES);
    const [capped] = parseFeed({ ...batch(), events: [huge] }).types;
    expect(capped.sample).toEqual({ tooLarge: true, bytes: expect.any(Number) });
  });
  it.each(["", "1type", "has space", "x".repeat(65), "line\nbreak", "<script>", "naïve", "-dash"])(
    "counts an entry whose type is not a bounded name as invalid without naming it: %j",
    (type) => {
      const value = batch();
      value.events.push({ type, secret: "secret-value" });
      const result = parseFeed(value);
      expect(result).toMatchObject({ skipped: 1, invalid: 1, firstInvalid: "events.1.type (bad format)" });
      expect(result.types.map((entry) => entry.type)).toEqual(["killed"]);
      expect(result.events).toHaveLength(1);
      // Such an entry was skipped, not refused, before type names were checked.
      expect(result.firstMalformed).toBeNull();
    },
  );
  it("keeps the valid types of a batch whose only invalid entry is a badly named type", () => {
    const result = parseFeed({ ...batch(), events: [{ type: "playerSpawned" }, { type: "Round Ended" }] });
    expect(result).toMatchObject({
      skipped: 2,
      invalid: 1,
      firstInvalid: "events.1.type (bad format)",
      firstMalformed: null,
      types: [{ type: "playerSpawned", count: 1, sample: { type: "playerSpawned" } }],
      events: [],
    });
    // A malformed entry after it is named for a refusal.
    const mixed = parseFeed({ ...batch(), events: [{ type: "Round Ended" }, null] });
    expect(mixed).toMatchObject({
      firstInvalid: "events.0.type (bad format)",
      firstMalformed: "events.1 (not an object)",
    });
  });
  it("accepts a 64-character type name and dotted, namespaced names", () => {
    const names = ["a".repeat(64), "Meta.Event:Spawn_2", "k-d"];
    const result = parseFeed({ ...batch(), events: names.map((type) => ({ type })) });
    expect(result.types.map((entry) => entry.type)).toEqual(names);
    expect(result).toMatchObject({ skipped: 3, invalid: 0 });
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
    expect(result.firstMalformed).toBe(result.firstInvalid);
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
