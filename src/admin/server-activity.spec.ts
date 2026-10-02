import { ServerActivity } from "./server-activity";
import type { Overview } from "./wardogs.client";
const a = { steamId: "76561198000000001", name: "Alice", faction: "RED" };
const b = { steamId: "76561198000000002", name: "Bob", faction: "BLU" };
const base = Date.parse("2026-10-02T04:00:00Z");
function snapshot(seconds: number, players = [a], status: Partial<Overview["status"]> = {}): Overview {
  return {
    status: {
      serverName: "Preview",
      map: "Europe",
      lighting: "DayClear",
      matchSeconds: 600 + seconds,
      factionScores: [],
      experiences: ["Madrid_KOTH_01"],
      players: { current: players.length, max: 100 },
      ...status,
    },
    observedAt: new Date(base + seconds * 1000).toISOString(),
    capabilities: { routes: [] },
    players,
  };
}
it("baselines existing players and records joins, team changes, leaves and map changes", () => {
  const feed = new ServerActivity();
  feed.observe(snapshot(0));
  expect(feed.view().events.map((event) => event.category)).toEqual(["connection"]);
  feed.observe(snapshot(5, [a, b]));
  feed.observe(snapshot(10, [{ ...a, faction: "BLU" }, b]));
  feed.observe(snapshot(15, [b]));
  feed.observe(snapshot(20, [], { map: "Kavkazi" }));
  expect(feed.view().events.map((event) => event.message)).toEqual([
    "Map changed: Ozeti → Bakurani",
    "Alice left",
    "Alice: RED → BLU",
    "Bob joined",
    "Game connection observed",
  ]);
});
it("does not manufacture departures during a partial roster or a map transition", () => {
  const feed = new ServerActivity();
  feed.observe(snapshot(0, [a, b]));
  feed.observe(snapshot(5, [], { players: { current: 2, max: 100 } }));
  feed.observe(snapshot(10, [a, b]));
  feed.observe(snapshot(15, [], { map: "Kavkazi" }));
  expect(feed.view().events.filter((event) => event.category === "players")).toEqual([]);
});
it("recognizes a known map alias without inventing a map or clock change or hiding a join", () => {
  const feed = new ServerActivity();
  feed.observe(snapshot(0));
  feed.observe(snapshot(5, [a, b], { map: "Ozeti" }));
  expect(feed.view().events.map((event) => event.message)).toEqual(["Bob joined", "Game connection observed"]);
  feed.observe(snapshot(10, [a, b], { map: "Europe", matchSeconds: 2 }));
  expect(feed.view().events[0].message).toBe("Round clock changed");
});
it("marks gaps and lost connections, then baselines without inventing missed events", () => {
  const feed = new ServerActivity();
  feed.observe(snapshot(0));
  feed.observe(snapshot(80, [b]));
  feed.failed();
  feed.failed();
  feed.observe(snapshot(90, [a]));
  expect(feed.view().events.map((event) => event.message)).toEqual([
    "Game connection restored",
    "Game connection unavailable",
    "Observation gap · changes during this interval are unknown",
    "Game connection observed",
  ]);
});
it("reports changes in the clock, mode and lighting without inventing a match-ended event", () => {
  const feed = new ServerActivity();
  feed.observe(snapshot(0));
  feed.observe(snapshot(5, [a], { matchSeconds: undefined, factionScores: [{ name: "Lonestar", score: 0 }] }));
  expect(feed.view().events).toHaveLength(1);
  feed.observe(snapshot(10));
  feed.observe(
    snapshot(15, [a], {
      matchSeconds: 3,
      lighting: "NightClear",
      experiences: ["Madrid_KOTH_01", "KOTH_InfantryOnly"],
    }),
  );
  expect(feed.view().events.filter((event) => event.category === "match")).toHaveLength(3);
  expect(feed.view().events.some((event) => event.message === "Round clock changed")).toBe(true);
});
it("records an advertised zone change and a clock correction without claiming a new round", () => {
  const feed = new ServerActivity();
  feed.observe(snapshot(0, [a], { alternator: "ZoneAlternator.Ozeti.Default.Circle" }));
  feed.observe(snapshot(5, [a], { matchSeconds: 900, alternator: "ZoneAlternator.Ozeti.Church.Circle" }));
  expect(
    feed
      .view()
      .events.filter((event) => event.category === "match")
      .map((event) => event.message),
  ).toEqual(["Zone layout changed: Church", "Round clock changed"]);
});
it("keeps a bounded independent history and ignores duplicate or late snapshots", () => {
  const feed = new ServerActivity(),
    other = new ServerActivity();
  for (let i = 0; i < 350; i++) feed.observe(snapshot(i, i % 2 ? [a] : [a, b]));
  const state = feed.view();
  expect(state.events).toHaveLength(300);
  feed.observe(snapshot(5));
  feed.observe(snapshot(349));
  expect(feed.view()).toEqual(state);
  expect(other.view().events).toEqual([]);
  state.events[0].message = "changed by caller";
  expect(feed.view().events[0].message).not.toBe("changed by caller");
});
