import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATCH_UP_HOURS } from "./weekly-schedule";

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

it("has the board previewed while it is still off, and warns about the catch-up window", () => {
  const steps = from("## Before turning it on");
  const off = steps.indexOf("leave `WEEKLY_LEADERBOARD_ENABLED=false`");
  const preview = steps.indexOf("preview?week=last");
  const on = steps.indexOf("`WEEKLY_LEADERBOARD_ENABLED=true`");
  expect(off).toBeGreaterThanOrEqual(0);
  expect(preview).toBeGreaterThan(off);
  expect(on).toBeGreaterThan(preview);
  // The guide spells the window out in words; update both together.
  expect(CATCH_UP_HOURS).toBe(6);
  expect(steps).toContain("six-hour catch-up window");
});

it("has the board previewed for the week that will post next", () => {
  const steps = from("## Before turning it on");
  // Before the first slot `last` is a week before anything can post, and outside the catch-up window the next
  // post is the week in progress, so `last` is right only inside the window.
  const current = steps.indexOf("preview?week=current");
  expect(current).toBeGreaterThan(steps.indexOf("leave `WEEKLY_LEADERBOARD_ENABLED=false`"));
  expect(current).toBeLessThan(steps.indexOf("`WEEKLY_LEADERBOARD_ENABLED=true`"));
  expect(steps).toContain("Before the first slot, or when turning it on outside the catch-up window");
  expect(steps).toContain("Run `preview?week=last` only when turning it on inside the window");
});
