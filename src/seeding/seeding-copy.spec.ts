import {
  CHANNEL_PROBLEMS,
  MEMBER_COPY,
  MENTIONABLE_WARNING,
  ROLE_PROBLEMS,
  SEEDING_BUTTONS,
  SEEDING_NOTE_MAX_LENGTH,
  STAFF_COPY,
  formatDuration,
  panelMessage,
  sanitizeNote,
  seedingCall,
} from "./seeding-copy";

const ROLE = "300000000000000001";
const CHANNEL = "400000000000000001";
const MINUTE = 60_000;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

function everyLine() {
  const panel = panelMessage();
  return [
    ...Object.values(MEMBER_COPY),
    ...Object.values(STAFF_COPY).filter((copy): copy is string => typeof copy === "string"),
    STAFF_COPY.pingSent(CHANNEL, 120 * MINUTE),
    STAFF_COPY.pingRefused(CHANNEL),
    STAFF_COPY.pingUnknown(CHANNEL),
    STAFF_COPY.cooldown(90 * MINUTE),
    ...Object.values(ROLE_PROBLEMS),
    ...Object.values(CHANNEL_PROBLEMS),
    MENTIONABLE_WARNING,
    panel.content,
    ...panel.components[0].components.map((button) => JSON.stringify(button.toJSON())),
    seedingCall({ roleId: ROLE, players: { current: 2, max: 64 }, joinId: "11111111-1111-4111-8111-111111111111" }),
    seedingCall({ roleId: ROLE, players: null }),
  ];
}

describe("seeding copy", () => {
  it("never says free and never promises rewards, points, whitelist or queue perks for seeding", () => {
    for (const line of everyLine())
      expect(line).not.toMatch(/\bfree|reward|\bpoints?\b|whitelist|priority|\bearn|prize|\bxp\b|bonus/i);
  });

  it("never claims pings happen automatically", () => {
    for (const line of everyLine()) expect(line).not.toMatch(/automatic/i);
    expect(panelMessage().content).toContain("Staff send these pings by hand");
  });

  it("puts the role mention first, then the call, join details, note and opt-out", () => {
    const content = seedingCall({
      roleId: ROLE,
      players: { current: 0, max: 64 },
      joinId: "11111111-1111-4111-8111-111111111111",
      note: "Map night at 8",
    });
    expect(content.split("\n")).toEqual([
      `<@&${ROLE}> **Seeders, it's go time.** The WARDOGS server is quieter than an early-bird dinner at 3:45. Come help get a match going.`,
      "Players on right now: **0/64**",
      "Join by ID: `11111111-1111-4111-8111-111111111111` (the **Join by ID** button is bottom-left in the server browser)",
      "Staff note: Map night at 8",
      "-# You get these because you joined the Seeder role. `/seeding leave` turns them off.",
    ]);
  });

  it("points to the website when no join ID is configured", () => {
    expect(seedingCall({ roleId: ROLE, players: null })).toContain("How to join: https://theuncsgaming.com");
  });

  it("keeps the longest possible call well within Discord's message limit", () => {
    const content = seedingCall({
      roleId: "12345678901234567890",
      players: { current: 100, max: 100 },
      joinId: "11111111-1111-4111-8111-111111111111",
      note: "n".repeat(SEEDING_NOTE_MAX_LENGTH),
    });
    expect(content.length).toBeLessThan(1000);
  });

  it("builds a panel with two stable buttons and no mentions", () => {
    const panel = panelMessage();
    expect(panel.allowedMentions).toEqual({ parse: [] });
    expect(panel.content).not.toContain("<@");
    expect(panel.components[0].components.map((button) => button.toJSON())).toEqual([
      expect.objectContaining({ custom_id: "uncs-seeding/join", label: "I'll help seed" }),
      expect.objectContaining({ custom_id: "uncs-seeding/leave", label: "Stop pinging me" }),
    ]);
    expect(SEEDING_BUTTONS).toEqual({ join: "uncs-seeding/join", leave: "uncs-seeding/leave" });
  });
});

describe("formatDuration", () => {
  it.each([
    [1, "1 min"],
    [MINUTE, "1 min"],
    [MINUTE + 1, "2 min"],
    [59 * MINUTE, "59 min"],
    [60 * MINUTE, "1 h"],
    [61 * MINUTE, "1 h 1 min"],
    [120 * MINUTE, "2 h"],
    [1440 * MINUTE, "24 h"],
  ])("formats %d ms as %s, rounding up", (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe("sanitizeNote", () => {
  it("keeps an ordinary note", () => {
    expect(sanitizeNote("Map night at 8, bring a friend!")).toBe("Map night at 8, bring a friend!");
  });

  it.each([undefined, null, "", "   ", "\n\t", "<@123456789012345678>", ZERO_WIDTH_SPACE])(
    "returns nothing for an empty note (%p)",
    (note) => expect(sanitizeNote(note)).toBeUndefined(),
  );

  it("folds line breaks, tabs and control characters into single spaces", () => {
    expect(sanitizeNote("Line one\nline two\r\n\tline\u0007three")).toBe("Line one line two line three");
  });

  it("removes user and role mentions", () => {
    expect(sanitizeNote("Ask <@123456789012345678>, <@!123456789012345678> or <@&123456789012345678>")).toBe(
      "Ask , or",
    );
  });

  it("defuses @everyone and @here, including doubled or hidden @ signs", () => {
    const note = sanitizeNote(`@everyone @@here @${ZERO_WIDTH_SPACE}everyone @HERE`);
    expect(note).toBe("everyone here everyone HERE");
    expect(note).not.toContain("@");
  });

  it("removes invisible and bidirectional formatting characters", () => {
    expect(sanitizeNote(`Seed${ZERO_WIDTH_SPACE} now${RIGHT_TO_LEFT_OVERRIDE}!`)).toBe("Seed now!");
  });

  it("never returns more than the note limit", () => {
    expect(sanitizeNote("x".repeat(500))).toHaveLength(SEEDING_NOTE_MAX_LENGTH);
  });
});
