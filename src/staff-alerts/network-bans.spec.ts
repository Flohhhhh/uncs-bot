import type { EnvService } from "../env/env.service";
import { EnvWatchlistSource, withTimeout } from "./network-bans";

const listed = "76561198000000001",
  noted = "76561198000000002",
  clean = "76561198000000003";
const watchlist = [
  {
    steamId: listed,
    reason: "Aimbot",
    evidenceUrl: "https://example.com/clip",
    communities: 4,
    recordedAt: "2026-10-02",
    addedBy: "Dennis",
  },
  { steamId: noted, reason: "Teamkilling", source: "staff" as const },
];
const env = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as EnvService;
const enabled = { STAFF_ALERTS_ENABLED: true, STAFF_ALERTS_WATCHLIST_ENABLED: true, STAFF_ALERTS_WATCHLIST: watchlist };

describe("network-ban sources", () => {
  it("looks up only the requested SteamIDs in the staff watch list", async () => {
    const source = new EnvWatchlistSource(env(enabled));
    expect(source.name).toBe("Staff watch list");
    const found = await source.lookup([listed, noted, clean], new AbortController().signal);
    expect([...found.keys()]).toEqual([listed, noted]);
    expect(found.get(listed)).toEqual({
      steamId: listed,
      communities: 4,
      reasons: ["Aimbot"],
      evidenceUrls: ["https://example.com/clip"],
      recordedAt: "2026-10-02",
      source: "wardogs-network",
      addedBy: "Dennis",
    });
    expect(found.get(noted)).toMatchObject({ communities: null, evidenceUrls: [], recordedAt: null, source: "staff" });
    expect((await source.lookup([clean], new AbortController().signal)).size).toBe(0);
  });

  it("returns nothing when the watch list or staff alerts are off", async () => {
    for (const values of [
      { ...enabled, STAFF_ALERTS_WATCHLIST_ENABLED: false },
      { ...enabled, STAFF_ALERTS_ENABLED: false },
      { ...enabled, STAFF_ALERTS_WATCHLIST: undefined },
    ])
      expect((await new EnvWatchlistSource(env(values)).lookup([listed], new AbortController().signal)).size).toBe(0);
  });

  it("refuses a cancelled lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new EnvWatchlistSource(env(enabled)).lookup([listed], controller.signal)).rejects.toThrow("cancelled");
  });

  describe("lookup timeouts", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("resolves a lookup that answers in time", async () => {
      await expect(withTimeout(async () => "found", 3_000)).resolves.toBe("found");
    });

    it("rejects and aborts a lookup that takes longer than its budget", async () => {
      let signal: AbortSignal | undefined;
      const pending = withTimeout((given) => {
        signal = given;
        return new Promise<never>(() => undefined);
      }, 3_000);
      const assertion = expect(pending).rejects.toThrow("timed out");
      await jest.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
    });

    it("rejects a lookup that fails or throws", async () => {
      await expect(withTimeout(() => Promise.reject(new Error("upstream said x")), 3_000)).rejects.toThrow(
        "upstream said x",
      );
      await expect(
        withTimeout(() => {
          throw "not an error";
        }, 3_000),
      ).rejects.toThrow("failed");
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
