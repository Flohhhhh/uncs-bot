import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../env/env";

// Operators paste the recommended copy from the guide into the deployment, and a build refuses to start on an
// invalid value. So the guide's paste blocks, its readable tables and .env.example must agree and stay valid.
const read = (path: string) => readFileSync(join(__dirname, "..", "..", path), "utf8").replace(/\r\n/g, "\n");
const guide = read("docs/guides/SERVER_COMMUNITY.md");
const envExample = read(".env.example");

const sets = ["Ready-now set", "Queue-priority set"] as const;
type CopySet = (typeof sets)[number];
const whitelistedCopy = "### Recommended whitelisted welcome copy";

/** Lines after an exact heading, up to the next heading of any level. */
function section(heading: string) {
  const lines = guide.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`docs/guides/SERVER_COMMUNITY.md has no "${heading}" heading.`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,6} /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** The single-line value in the plain-text block under a `NAME` label. A reflowed block does not match. */
function pasteValue(heading: string, name: string) {
  const block = new RegExp(`^\`${name}\`\\n\\n\`\`\`text\\n(.*)\\n\`\`\`$`, "gm");
  const values = [...section(heading).matchAll(block)].map((match) => match[1]);
  expect(values).toHaveLength(1);
  return values[0];
}

function envExampleValue(name: string) {
  const values = [...envExample.matchAll(new RegExp(`^# ${name}='(.*)'$`, "gm"))].map((match) => match[1]);
  expect(values).toHaveLength(1);
  return values[0];
}

function literal(cell: string) {
  const match = /^`([^`]+)`$/.exec(cell);
  if (!match) throw new Error(`Expected one backticked message, got: ${cell}`);
  return match[1];
}

/** Each table's numbered rows under a heading, as trimmed cells after the number column. */
function tableRows(heading: string) {
  return section(heading)
    .split(/\n{2,}/)
    .filter((block) => block.startsWith("|"))
    .map((table) =>
      table
        .split("\n")
        .filter((line) => /^\| *\d+ *\|/.test(line))
        .map((line) =>
          line
            .split("|")
            .slice(2, -1)
            .map((cell) => cell.trim()),
        ),
    );
}

/** The copy as the guide's two tables show it; "Same" repeats the ready-now message. */
function tables() {
  const [welcome, round] = tableRows("### Recommended rotating UNCs copy");
  if (!welcome || !round) throw new Error("Expected the welcome-variant table followed by the round-message table.");
  const pick = (cell: string, readyNow: string) => (cell === "Same" ? readyNow : literal(cell));
  return {
    "Ready-now set": {
      variants: welcome.map(([first, second]) => [literal(first), literal(second)]),
      rounds: round.map(([message]) => literal(message)),
    },
    "Queue-priority set": {
      variants: welcome.map(([first, second, queued]) => [literal(first), pick(queued, literal(second))]),
      rounds: round.map(([message, queued]) => pick(queued, literal(message))),
    },
  } satisfies Record<CopySet, { variants: string[][]; rounds: string[] }>;
}

describe("recommended UNCs community copy", () => {
  it.each(sets)("keeps the %s paste values single-line, valid and identical to the guide's tables", (set) => {
    const expected = tables()[set];
    const variants = pasteValue(`#### ${set}`, "SERVER_COMMUNITY_WELCOME_VARIANTS");
    const rounds = pasteValue(`#### ${set}`, "SERVER_COMMUNITY_ROUND_MESSAGES");
    expect(expected.variants).toHaveLength(8);
    expect(expected.rounds).toHaveLength(5);
    expect(JSON.parse(variants)).toEqual(expected.variants);
    expect(JSON.parse(rounds)).toEqual(expected.rounds);
    expect(Env.shape.SERVER_COMMUNITY_WELCOME_VARIANTS.parse(variants)).toEqual(expected.variants);
    expect(Env.shape.SERVER_COMMUNITY_ROUND_MESSAGES.parse(rounds)).toEqual(expected.rounds);
  });

  it.each(["SERVER_COMMUNITY_WELCOME_VARIANTS", "SERVER_COMMUNITY_ROUND_MESSAGES"])(
    "repeats the guide's ready-now %s in .env.example exactly",
    (name) => {
      const value = envExampleValue(name);
      expect(value).toBe(pasteValue("#### Ready-now set", name));
      // An apostrophe would end the single-quoted .env value early.
      expect(value).not.toContain("'");
    },
  );

  it("keeps queue promises out of the ready-now set, as the newcomer guidance requires", () => {
    const { variants, rounds } = tables()["Ready-now set"];
    const promisesQueue = (messages: string[]) =>
      messages.some((message) => /queue/i.test(message)) && messages.some((message) => /whitelist/i.test(message));
    expect(variants.filter(promisesQueue)).toEqual([]);
    expect(rounds.filter((message) => /queue/i.test(message))).toEqual([]);
    expect(tables()["Queue-priority set"]).not.toEqual(tables()["Ready-now set"]);
  });
});

describe("recommended whitelisted welcome copy", () => {
  const name = "SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS";
  /** The whitelisted variants as the guide's one table shows them. */
  function table() {
    const tables = tableRows(whitelistedCopy);
    expect(tables).toHaveLength(1);
    return tables[0].map((row) => row.map(literal));
  }

  it("keeps the paste value single-line, valid, identical to the guide's table and repeated in .env.example", () => {
    const expected = table();
    const value = pasteValue(whitelistedCopy, name);
    expect(expected).toHaveLength(4);
    expect(JSON.parse(value)).toEqual(expected);
    expect(Env.shape[name].parse(value)).toEqual(expected);
    expect(envExampleValue(name)).toBe(value);
    // An apostrophe would end the single-quoted .env value early.
    expect(value).not.toContain("'");
    for (const message of expected.flat()) expect(message.length).toBeLessThan(200);
  });

  it("never tells whitelisted players to get whitelisted or promises queue priority, rewards or points", () => {
    const promises = /whitelist|queue|priority|reward|\bpoints?\b|bonus|\bXP\b|cash|\bfree\b/i;
    expect(
      table()
        .flat()
        .filter((message) => promises.test(message)),
    ).toEqual([]);
  });

  it("shares no variant with either standard set", () => {
    const standard = new Set(sets.flatMap((set) => tables()[set].variants.map((variant) => JSON.stringify(variant))));
    expect(table().filter((variant) => standard.has(JSON.stringify(variant)))).toEqual([]);
  });
});
