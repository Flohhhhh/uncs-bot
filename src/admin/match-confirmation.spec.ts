import { randomUUID } from "node:crypto";
import { actionSchema, type AdminAction } from "./admin.types";
import { WardogsClient } from "./wardogs.client";

describe("reviewed match changes", () => {
  const now = 1_800_000_000_000;
  const expectedRound = { map: "Kavkazi", startedAt: now - 600_000 };
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());

  function fixture(status: unknown) {
    const client = new WardogsClient({
      rcon: () => {
        throw new Error("No live transport");
      },
    });
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities")
        return { routes: ["POST /v1/match/end", "POST /v1/match/restart", "POST /v1/match/map"] };
      if (path === "/v1/status") return status;
      if (method === "POST") return { ok: true };
      throw new Error(`Unexpected ${path}`);
    });
    return { client, request };
  }
  const status = { serverName: "Test", map: "Kavkazi", matchSeconds: 600, players: { current: 100, max: 100 } };
  const action = (kind: "match-end" | "match-restart") =>
    ({
      id: randomUUID(),
      action: kind,
      confirm: kind === "match-end" ? "END MATCH" : "RESTART MATCH",
      reason: "Staff reviewed the current match.",
      expectedRound,
    }) as Extract<AdminAction, { action: "match-end" | "match-restart" }>;

  it.each(["match-end", "match-restart"] as const)(
    "does not send %s after the reviewed round has changed",
    async (kind) => {
      for (const current of [
        { ...status, map: "Europe" },
        { ...status, matchSeconds: 3 },
        { ...status, matchSeconds: undefined },
      ]) {
        const { client, request } = fixture(current);
        await expect(client.execute(action(kind))).resolves.toMatchObject({ state: "failed", changed: false });
        expect(request.mock.calls.some(([method]) => method !== "GET")).toBe(false);
      }
    },
  );
  it.each(["match-end", "match-restart"] as const)(
    "checks the running round immediately before %s and sends only the native request",
    async (kind) => {
      const { client, request } = fixture(status);
      await expect(client.execute(action(kind))).resolves.toMatchObject({ state: "accepted" });
      expect(request.mock.calls.slice(-2)).toEqual([
        ["GET", "/v1/status"],
        ["POST", kind === "match-end" ? "/v1/match/end" : "/v1/match/restart", undefined],
      ]);
    },
  );
  it("refuses unreadable round evidence before issuing a mutation", async () => {
    const { client, request } = fixture({ ok: true });
    await expect(client.execute(action("match-restart"))).rejects.toMatchObject({ unknownResult: false });
    expect(request.mock.calls.some(([method]) => method !== "GET")).toBe(false);
  });
  it.each(["match-end", "match-restart"] as const)(
    "uses the reviewed map for %s when this build supplies no clock",
    async (kind) => {
      const input = { ...action(kind), expectedRound: { map: status.map, startedAt: null } };
      expect(actionSchema.safeParse(input).success).toBe(true);
      const sameMap = fixture({ ...status, matchSeconds: undefined });
      await expect(sameMap.client.execute(input)).resolves.toMatchObject({ state: "accepted" });
      const otherMap = fixture({ ...status, map: "Europe", matchSeconds: undefined });
      await expect(otherMap.client.execute(input)).resolves.toMatchObject({ state: "failed", changed: false });
      expect(otherMap.request.mock.calls.some(([method]) => method !== "GET")).toBe(false);
    },
  );
  it("rejects older clients without the reviewed round and accepts complete current requests", () => {
    for (const input of [
      action("match-end"),
      action("match-restart"),
      {
        id: randomUUID(),
        action: "map",
        map: "Europe",
        confirm: "CHANGE MAP",
        reason: "Staff reviewed map travel.",
        expectedRound,
      },
    ]) {
      expect(actionSchema.safeParse({ ...input, expectedRound: undefined }).success).toBe(false);
      expect(actionSchema.safeParse(input).success).toBe(true);
    }
  });
  it.each([false, true])("checks the round after map catalog validation (round changes: %s)", async (changes) => {
    const { client, request } = fixture(status);
    let finishCatalog!: (value: Awaited<ReturnType<WardogsClient["catalog"]>>) => void;
    jest.spyOn(client, "catalog").mockReturnValue(
      new Promise((resolve) => {
        finishCatalog = resolve;
      }),
    );
    const pending = client.execute({
      id: randomUUID(),
      action: "map",
      map: "Europe",
      confirm: "CHANGE MAP",
      reason: "Staff reviewed map travel.",
      expectedRound,
    });
    await Promise.resolve();
    expect(request).not.toHaveBeenCalledWith("GET", "/v1/status");
    request.mockImplementation(async (method, path) => {
      if (path === "/v1/status") return changes ? { ...status, matchSeconds: 0 } : status;
      if (method === "POST") return { ok: true };
      throw new Error(`Unexpected ${path}`);
    });
    finishCatalog({ maps: [{ id: "Europe" }], experiences: [], lightings: [] });
    await expect(pending).resolves.toMatchObject({ state: changes ? "failed" : "accepted" });
    const writes = request.mock.calls.filter(([method]) => method !== "GET");
    expect(writes).toEqual(changes ? [] : [["POST", "/v1/match/map", { map: "Europe" }]]);
    expect(request.mock.calls[request.mock.calls.length - (changes ? 1 : 2)]).toEqual(["GET", "/v1/status"]);
  });
  it("does not reuse an overview cached before the round transition", async () => {
    const { client, request } = fixture(status);
    request.mockImplementation(async (_method, path) => {
      if (path === "/v1/capabilities") return { routes: ["POST /v1/match/restart"] };
      if (path === "/v1/players") return { players: [] };
      if (path === "/v1/status") return status;
      throw new Error(`Unexpected ${path}`);
    });
    await client.overview();
    request.mockClear().mockImplementation(async (_method, path) => {
      if (path === "/v1/status") return { ...status, map: "Europe" };
      throw new Error(`Unexpected ${path}`);
    });
    await expect(client.execute(action("match-restart"))).resolves.toMatchObject({ state: "failed", changed: false });
    expect(request.mock.calls).toEqual([["GET", "/v1/status"]]);
  });
});
