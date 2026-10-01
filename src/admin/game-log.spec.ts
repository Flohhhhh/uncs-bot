import { parseGameLog } from "./game-log";
import { WardogsClient } from "./wardogs.client";

const timestampUtc = "2026-10-01T22:00:00Z";
describe("game command log", () => {
  it("exposes only recognized request metadata, without raw secrets or connection details", () => {
    const rows = parseGameLog({
      entries: [
        {
          timestampUtc,
          event: "HTTP",
          detail: "PUT /v1/config?token=secret-query -> 200",
          peer: "private-peer",
          sessionId: "secret-session",
        },
        { timestampUtc, event: "HTTP", detail: "POST /v1/players/76561198000000001/kick -> 404" },
        { timestampUtc, event: "HTTP", detail: "POST /v1/config/validate -> 200" },
        { timestampUtc, event: "COMMAND", detail: "password=secret-password" },
        { timestampUtc: "secret-date", event: "secret-event", detail: "GET /v1/secret-route -> 200" },
        { timestampUtc, event: "HTTP", detail: "GET /v1/catalog/maps/secret-map/experiences -> 200" },
        null,
      ],
    });
    expect(rows[0]).toMatchObject({ operation: "PUT /v1/config", statusCode: 200, changesState: true });
    expect(rows[1]).toMatchObject({ operation: "POST /v1/players/76561198000000001/kick", statusCode: 404 });
    expect(rows[2].changesState).toBe(false);
    expect(rows[3]).toMatchObject({ event: "COMMAND", operation: null });
    expect(rows[4]).toMatchObject({ timestamp: null, event: "OTHER", operation: null });
    expect(rows[5].operation).toBe("GET /v1/catalog/maps/{map}/experiences");
    expect(JSON.stringify(rows)).not.toMatch(/secret|private-peer/);
  });
  it("rejects an unreadable envelope instead of representing it as an empty history", () => {
    expect(() => parseGameLog({ entries: "unexpected" })).toThrow();
    expect(() => parseGameLog({ entries: Array(501).fill(null) })).toThrow();
    expect(parseGameLog({ entries: Array(120).fill(null) })).toHaveLength(100);
  });
  it("uses only advertised read routes", async () => {
    const client = new WardogsClient({
      rcon: () => {
        throw new Error("No network permitted");
      },
    });
    const capabilities = jest.spyOn(client, "capabilities").mockResolvedValue({ routes: [] });
    const request = jest.spyOn(client, "request").mockResolvedValue({ entries: [] });
    expect(await client.gameLog()).toMatchObject({ available: false, entries: [] });
    expect(request).not.toHaveBeenCalled();
    capabilities.mockResolvedValue({ routes: ["GET /v1/audit"] });
    expect(await client.gameLog()).toMatchObject({ available: true, entries: [], limit: 100 });
    expect(request.mock.calls).toEqual([["GET", "/v1/audit?limit=100"]]);
  });
});
