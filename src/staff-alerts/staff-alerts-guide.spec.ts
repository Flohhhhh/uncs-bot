import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../env/env";

// Every staff-alert feature stays off until its own switch is set, so the guide's setup steps must name each one.
const guide = readFileSync(join(__dirname, "..", "..", "docs/guides/STAFF_ALERTS.md"), "utf8").replace(/\r\n/g, "\n");

it("names every staff-alert switch in the guide's setup section", () => {
  const start = guide.indexOf("## 2. Setup");
  expect(start).toBeGreaterThanOrEqual(0);
  const setup = guide.slice(start, guide.indexOf("\n## ", start + 1));
  const switches = Object.keys(Env.shape).filter((name) => /^STAFF_ALERTS_(\w+_)?ENABLED$/.test(name));
  expect(switches).toEqual(expect.arrayContaining(["STAFF_ALERTS_ENABLED", "STAFF_ALERTS_WATCHLIST_ENABLED"]));
  for (const name of switches) expect(setup).toMatch(new RegExp(`\\b${name}=`));
});
