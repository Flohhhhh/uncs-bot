import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import type { Database } from "../database/database.types";
import type { TelemetryDeliveries } from "../telemetry/telemetry.deliveries";
import { TelemetryStore } from "../telemetry/telemetry.store";
import { TelemetryFeedContext } from "./feed-context";

const steamId = "76561198000000001";
const until = Date.parse("2026-10-02T23:10:00Z");
const range = { since: Date.parse("2026-10-02T22:40:00Z"), windowSince: until - 5 * 60_000, until };

function fixture(lastBatchAt: string | null, row: Record<string, unknown> = {}) {
  const query = jest.fn(async (_config: { text: string }, _params: unknown[]) => ({
    rows: [
      {
        kills: 12,
        windowKills: 9,
        headshotKills: 6,
        maxDistanceMeters: "212.4",
        topCauses: ["Rifle", "Grenade"],
        ...row,
      },
    ],
  }));
  const store = new TelemetryStore(drizzle({ query } as unknown as Client) as Database);
  const deliveries = {
    status: jest.fn(() => ({
      lastBatch: lastBatchAt ? { at: lastBatchAt, accepted: 3, skipped: 0, invalid: 0, firstInvalid: null } : null,
    })),
  };
  return { context: new TelemetryFeedContext(deliveries as unknown as TelemetryDeliveries, store), query };
}

describe("optional combat-feed context for performance alerts", () => {
  it("reads nothing until the feed is delivering", async () => {
    for (const at of [null, "2026-10-02T22:59:59.000Z"]) {
      const { context, query } = fixture(at);
      await expect(context.context("primary", steamId, range)).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("summarizes this killer's recent feed events, capped at 500 rows", async () => {
    const { context, query } = fixture("2026-10-02T23:05:00.000Z");
    await expect(context.context("primary", steamId, range)).resolves.toEqual({
      kills: 12,
      windowKills: 9,
      headshotShare: 0.5,
      topCauses: ["Rifle", "Grenade"],
      maxDistanceMeters: 212,
      since: "2026-10-02T22:40:00.000Z",
    });
    const [config, params] = query.mock.calls[0];
    expect(config.text).toContain("killer_steam_id =");
    expect(config.text).toContain("NOT suicide");
    expect(config.text).toContain("LIMIT 500");
    expect(params).toEqual(expect.arrayContaining(["primary", steamId]));
  });

  it("returns empty context when the player has no feed kills", async () => {
    const { context } = fixture("2026-10-02T23:05:00.000Z", {
      kills: 0,
      windowKills: 0,
      headshotKills: 0,
      maxDistanceMeters: null,
      topCauses: null,
    });
    await expect(context.context("primary", steamId, range)).resolves.toMatchObject({
      kills: 0,
      headshotShare: null,
      topCauses: [],
      maxDistanceMeters: null,
    });
  });
});
