import {
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_WELCOME_VERSIONS,
  describeWelcomeTemplate,
  MAX_DISCORD_CONTENT_LENGTH,
  parseWelcomeVersions,
  pickWelcomeVersion,
  welcomeVersions,
} from "../../../src/welcome/welcome-template";

/** Small deterministic PRNG (mulberry32) so the property-style checks are repeatable. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What an admin pastes into `/welcome message`: slash-command options hold a single line. */
const ONE_LINE_DEFAULT = DEFAULT_WELCOME_VERSIONS.map((version) => version.replaceAll("\n\n", " ")).join(" --- ");

describe("welcome template versions", () => {
  it("splits on a line holding only ---, trimming each version", () => {
    expect(parseWelcomeVersions("  Hi {user}!\n\nSay hey.\n---\nWelcome, {user}.  \n  ---  \nYo {user}")).toEqual([
      "Hi {user}!\n\nSay hey.",
      "Welcome, {user}.",
      "Yo {user}",
    ]);
  });

  it("splits on the one-line ' --- ' form that slash-command options allow", () => {
    expect(parseWelcomeVersions("Hi {user}! --- Welcome, {user}. ---   Yo {user}")).toEqual([
      "Hi {user}!",
      "Welcome, {user}.",
      "Yo {user}",
    ]);
  });

  it("parses Discord's one-line paste of the line-separated form, where line breaks become spaces", () => {
    expect(parseWelcomeVersions("Hi {user}!  Say hey.   ---   Welcome, {user}.")).toEqual([
      "Hi {user}!  Say hey.",
      "Welcome, {user}.",
    ]);
  });

  it("keeps one copy of a version repeated with the same text, in first-seen order", () => {
    expect(parseWelcomeVersions("Hi {user} --- Hi {user}")).toEqual(["Hi {user}"]);
    expect(parseWelcomeVersions("A {user}\n---\nB {user} ---  A {user}  --- B {user} --- C {user}")).toEqual([
      "A {user}",
      "B {user}",
      "C {user}",
    ]);
    expect(welcomeVersions("Hi --- Hi --- Hi")).toEqual(["Hi"]);
  });

  it("ignores empty versions, including leading, trailing and doubled separators", () => {
    expect(parseWelcomeVersions("--- Hi {user} --- --- \n---\n Yo {user} ---")).toEqual(["Hi {user}", "Yo {user}"]);
    expect(parseWelcomeVersions(" --- \n---\n --- ")).toEqual([]);
  });

  it.each([
    ["no separator", "Hi {user}!\n\nPick your games in **Channels & Roles**."],
    ["surrounding whitespace", "  Hi {user}  "],
    ["dashes inside words", "Hi {user}---welcome---aboard"],
    ["four or more dashes", "Hi {user} ---- welcome\n-----\nback"],
    ["Discord spoilers", "Hi {user} || secret || and ||more||"],
    ["an em dash", "Hi {user} — welcome"],
  ])("keeps a template with %s unchanged as its only version", (_, template) => {
    expect(parseWelcomeVersions(template)).toEqual([template]);
  });

  it("keeps the five default versions with their placeholders and paragraph breaks", () => {
    expect(parseWelcomeVersions(DEFAULT_WELCOME_MESSAGE)).toEqual([...DEFAULT_WELCOME_VERSIONS]);
    expect(DEFAULT_WELCOME_VERSIONS).toHaveLength(5);
    for (const version of DEFAULT_WELCOME_VERSIONS) {
      expect(version).toContain("{user}");
      expect(version).toContain("{general}");
      expect(version).toContain("{squad-up}");
      expect(version).toMatch(/\n\nPick your games and roles in \*\*Channels & Roles\*\*\.$/);
    }
    expect(DEFAULT_WELCOME_VERSIONS[2]).toContain("Rated M for Mortgage.");
  });

  it("accepts the one-line default an admin can paste, within the option's 4000 characters", () => {
    expect(ONE_LINE_DEFAULT).not.toContain("\n");
    expect(ONE_LINE_DEFAULT.length).toBeLessThanOrEqual(4000);
    expect(parseWelcomeVersions(ONE_LINE_DEFAULT)).toEqual(
      DEFAULT_WELCOME_VERSIONS.map((version) => version.replace("\n\n", " ")),
    );
  });

  it("falls back to the default versions only when a template has no text", () => {
    expect(welcomeVersions(" --- ")).toEqual([...DEFAULT_WELCOME_VERSIONS]);
    expect(welcomeVersions("   ")).toEqual([...DEFAULT_WELCOME_VERSIONS]);
    expect(welcomeVersions("Hi {user}")).toEqual(["Hi {user}"]);
  });
});

describe("welcome version pick", () => {
  it("always uses a single version without consulting the random source", () => {
    const random = jest.fn(() => 0.5);
    expect(pickWelcomeVersion(["Only"], undefined, random)).toBe("Only");
    expect(pickWelcomeVersion(["Only"], "Only", random)).toBe("Only");
    expect(random).not.toHaveBeenCalled();
  });

  it("uses the random source to choose among the versions", () => {
    const versions = ["A", "B", "C", "D"];
    expect(pickWelcomeVersion(versions, undefined, () => 0)).toBe("A");
    expect(pickWelcomeVersion(versions, undefined, () => 0.5)).toBe("C");
    expect(pickWelcomeVersion(versions, undefined, () => 0.99)).toBe("D");
  });

  it("never repeats the previous version, even when the random source prefers it", () => {
    expect(pickWelcomeVersion(["A", "B", "C"], "A", () => 0)).toBe("B");
    expect(pickWelcomeVersion(["A", "B"], "B", () => 0.99)).toBe("A");
  });

  it("keeps an out-of-range or invalid random value within the versions", () => {
    expect(pickWelcomeVersion(["A", "B", "C"], undefined, () => 1)).toBe("C");
    expect(pickWelcomeVersion(["A", "B", "C"], undefined, () => -1)).toBe("A");
    expect(pickWelcomeVersion(["A", "B", "C"], undefined, () => Number.NaN)).toBe("A");
  });

  it("repeats only when every version has the same text", () => {
    expect(pickWelcomeVersion(["A", "A"], "A", () => 0.5)).toBe("A");
    expect(pickWelcomeVersion(["A", "A", "B"], "A", () => 0)).toBe("B");
  });

  it.each([2, 3, 5, 12])("never sends the same version twice in a row and reaches every one of %i", (count) => {
    const versions = Array.from({ length: count }, (_, index) => `Version ${index}`);
    const random = seeded(count);
    const seen = new Set<string>();
    let previous: string | undefined;
    for (let join = 0; join < 2_000; join++) {
      const version = pickWelcomeVersion(versions, previous, random);
      expect(versions).toContain(version);
      expect(version).not.toBe(previous);
      seen.add(version);
      previous = version;
    }
    expect(seen.size).toBe(count);
  });
});

describe("welcome template view", () => {
  it("shows a single version as before, with its count", () => {
    const view = describeWelcomeTemplate("Hi {user}, say hey in {general}.");
    expect(view).toBe(
      [
        "**Current welcome message:** 1 version. Add more by separating them with ` --- ` (see `/welcome help`).",
        "Hi {user}, say hey in {general}.",
        "Stored in Neon PostgreSQL.",
      ].join("\n\n"),
    );
  });

  it("numbers every version and says how many there are", () => {
    const view = describeWelcomeTemplate(DEFAULT_WELCOME_MESSAGE);
    expect(view).toContain(
      "**Current welcome message:** 5 versions. Each new member gets one at random, skipping the one sent last unless the bot has restarted since.",
    );
    expect(view).not.toContain("never the same");
    DEFAULT_WELCOME_VERSIONS.forEach((version, index) => {
      expect(view).toContain(`**Version ${index + 1}**\n${version}`);
    });
    expect(view).not.toContain("not shown");
    expect(view.length).toBeLessThanOrEqual(MAX_DISCORD_CONTENT_LENGTH);
    expect(view.endsWith("Stored in Neon PostgreSQL.")).toBe(true);
  });

  it("shows versions that all have the same text as one version, without promising variety", () => {
    expect(describeWelcomeTemplate("Hi {user} --- Hi {user}")).toBe(describeWelcomeTemplate("Hi {user}"));
    const view = describeWelcomeTemplate("A {user} --- A {user} --- B {user}");
    expect(view).toContain("**Current welcome message:** 2 versions.");
    expect(view).toContain("**Version 1**\nA {user}\n\n**Version 2**\nB {user}");
    expect(view).not.toContain("**Version 3**");
  });

  it("explains when the stored template has no text and the default is used", () => {
    const view = describeWelcomeTemplate(" --- ");
    expect(view).toContain("the saved template has no text, so new members get the built-in default (5 versions)");
    expect(view).toContain(`**Version 1**\n${DEFAULT_WELCOME_VERSIONS[0]}`);
  });

  it.each([
    ["one 4000-character version", "x".repeat(4000), 1],
    ["three long versions", Array.from({ length: 3 }, (_, index) => `${index}`.repeat(1300)).join(" --- "), 3],
    ["many short versions", Array.from({ length: 400 }, (_, index) => `Hi ${index}`).join(" --- "), 400],
  ])("keeps %s within Discord's message limit", (_, template, count) => {
    const view = describeWelcomeTemplate(template);
    expect(view.length).toBeLessThanOrEqual(MAX_DISCORD_CONTENT_LENGTH);
    expect(view).toContain(count === 1 ? "1 version." : `${count} versions.`);
    expect(view.endsWith("Stored in Neon PostgreSQL.")).toBe(true);
  });

  it("truncates the version that does not fit and counts the versions left out", () => {
    const template = ["a".repeat(900), "b".repeat(900), "c".repeat(900), "d".repeat(900)].join(" --- ");
    const view = describeWelcomeTemplate(template);
    expect(view).toContain(`**Version 1**\n${"a".repeat(900)}`);
    expect(view).toContain(`**Version 2**\n${"b".repeat(100)}`);
    expect(view).not.toContain(`**Version 2**\n${"b".repeat(900)}`);
    expect(view).toContain("…\n\n…and 2 more versions not shown.");
    expect(view).not.toContain("**Version 3**");
    expect(view.length).toBeLessThanOrEqual(MAX_DISCORD_CONTENT_LENGTH);
  });

  it("respects a smaller limit", () => {
    const view = describeWelcomeTemplate(DEFAULT_WELCOME_MESSAGE, 600);
    expect(view.length).toBeLessThanOrEqual(600);
    expect(view).toMatch(/…and \d more versions? not shown\./);
  });
});
