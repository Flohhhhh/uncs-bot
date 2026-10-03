import { readFileSync } from "node:fs";
import { join } from "node:path";

// Deployers follow this guide when a send fails or when switching the board on, so it must match the service.
const guide = readFileSync(join(__dirname, "..", "..", "docs/guides/WEEKLY_LEADERBOARD.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** The guide's text from an exact line up to the next heading. */
function from(line: string) {
  const start = guide.indexOf(`\n${line}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = guide.indexOf("\n## ", start + 1);
  return guide.slice(start, end === -1 ? undefined : end);
}

it("says an administrator can post a week after a failed send without a restart", () => {
  const risk = from("Remaining risks:")
    .split("\n")
    .find((line) => line.includes("`failed`"));
  expect(risk).toContain("After `failed` nothing was posted, so an administrator can post-now in the same process");
  expect(risk).toContain("After `unknown`, post-now is refused until a restart.");
  expect(risk).not.toContain("including post-now");
});
