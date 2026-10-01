import { AdminSettings } from "./admin.settings";
import { AdminService } from "./admin.service";
import type { AdminStore } from "./admin.store";
import { RconError, serves, WardogsClient } from "./wardogs.client";
import { actionSchema, playersSchema, type AdminAction } from "./admin.types";
import { configuredWhitelist } from "./whitelist-document";
import { randomUUID } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import { fixtureServers } from "./game-server-fixture";
const id = "76561198123456789",
  existing = "76561198066952872";
const settings = {
  rcon: () => ({ rconUrl: "https://rcon.example.test", password: "never-send-to-browser" }),
} as AdminSettings;
const document = {
  revision: "r1",
  writable: true,
  text: `[/Script/WDGame.WDGameSession]\nMaxReservedSlots=0\n+DefaultReservedPlayerIds=${existing}\n[WDServerFeed]\nToken=secret\n`,
};

describe("shared dashboard and community observations", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => jest.spyOn(Date, "now").mockImplementation(() => now));
  afterEach(() => jest.restoreAllMocks());

  function fixture() {
    const transport = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const body =
        path === "/v1/capabilities"
          ? { routes: [] }
          : path === "/v1/status"
            ? { serverName: "UNCs", map: "Test", players: { current: 0, max: 100 } }
            : path === "/v1/players"
              ? { players: [] }
              : { ok: true };
      return new Response(JSON.stringify(body));
    });
    const client = new WardogsClient(settings);
    const dashboard = new AdminService(fixtureServers(client), {} as AdminStore);
    const playerReads = () => transport.mock.calls.filter(([url]) => String(url).endsWith("/v1/players")).length;
    return { transport, client, dashboard, playerReads };
  }

  it("shares concurrent and recent roster reads, then refreshes at five seconds", async () => {
    const { client, dashboard, playerReads } = fixture();
    const [staff, community] = await Promise.all([dashboard.read("overview"), client.overview()]);
    expect(staff).toEqual(community);
    expect(playerReads()).toBe(1);
    now += 4_999;
    await dashboard.read("overview");
    expect(playerReads()).toBe(1);
    now += 1;
    await client.overview();
    expect(playerReads()).toBe(2);
  });

  it.each([false, true])("reads fresh state after a mutation, including a lost response (lost=%s)", async (lost) => {
    const { transport, client, dashboard, playerReads } = fixture();
    await dashboard.read("overview");
    if (lost) transport.mockRejectedValueOnce(new Error("Lost response"));
    const action = client.request("POST", "/v1/broadcast", { message: "Test" });
    if (lost) await expect(action).rejects.toMatchObject({ unknownResult: true });
    else await action;
    await dashboard.read("overview");
    expect(playerReads()).toBe(2);
  });

  it("does not cache a failed observation", async () => {
    const { transport, client, dashboard, playerReads } = fixture();
    transport.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(client.overview()).rejects.toThrow("could not be reached");
    await dashboard.read("overview");
    expect(playerReads()).toBe(1);
  });
});

describe("roster identity compatibility", () => {
  it("keeps known player controls available beside the official null-SteamID shape", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/capabilities") return { routes: [] };
      if (path === "/v1/status") return { serverName: "Local test", map: "Test", players: { current: 3, max: 100 } };
      if (path === "/v1/players")
        return {
          players: [
            { name: "Tea", steamId: id, faction: "RED" },
            { name: "Tea", steamId: null, faction: "BLU" },
            { name: "Tea", steamId: existing, faction: "GRN" },
          ],
        };
      throw new Error("Unexpected route");
    });
    const result = await client.overview();
    expect(result.players.map((player) => player.steamId)).toEqual([id, existing]);
    expect(result.unlinkedPlayerCount).toBe(1);
    expect(result.status.players.current).toBe(3);
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("reports an entirely unlinked roster without manufacturing player IDs", () => {
    expect(playersSchema.parse({ players: [{ name: "Unlinked", steamId: null }] })).toEqual({
      players: [],
      unlinkedPlayerCount: 1,
    });
  });
  it.each([undefined, "invalid", "", Number(id)])(
    "counts an undocumented or malformed roster identity as unlinked without accepting actions: %s",
    (steamId) => {
      expect(
        playersSchema.parse({
          players: [
            { name: "Known", steamId: id },
            { name: "Player", steamId },
          ],
        }),
      ).toEqual({ players: [{ name: "Known", steamId: id }], unlinkedPlayerCount: 1 });
      expect(
        actionSchema.safeParse({ id: randomUUID(), action: "kick", reason: "Identity check", steamId }).success,
      ).toBe(false);
    },
  );
  it("never accepts an unlinked identity as an action target", () => {
    expect(
      actionSchema.safeParse({ id: randomUUID(), action: "kick", reason: "Identity check", steamId: null }).success,
    ).toBe(false);
  });
});

describe("ban list compatibility", () => {
  it("shows valid bans beside a malformed configured ID without allowing that ID as an action target", async () => {
    const client = new WardogsClient(settings);
    const invalid = "76561197960265728";
    const bans = [
      { steamId: invalid, bannedAtUtc: "0001-01-01T00:00:00.000Z", bannedBy: "config", reason: null },
      { steamId: id, reason: "Existing ban" },
    ];
    const request = jest.spyOn(client, "request").mockResolvedValue({ bans });
    await expect(client.bans()).resolves.toEqual(bans);
    expect(request).toHaveBeenCalledWith("GET", "/v1/bans");
    for (const action of ["ban", "unban"])
      expect(
        actionSchema.safeParse({ id: randomUUID(), action, steamId: invalid, reason: "Review ban", confirm: invalid })
          .success,
      ).toBe(false);
  });
  it("does not present a malformed ban-list response as an empty list", async () => {
    const client = new WardogsClient(settings);
    jest.spyOn(client, "request").mockResolvedValue({ bans: null });
    await expect(client.bans()).rejects.toThrow();
  });
});

describe("Wardogs action outcomes", () => {
  afterEach(() => jest.restoreAllMocks());
  it("reads and confirms a whitelist addition beyond the old SteamID prefix", async () => {
    const steamId = "76561200000000000";
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["POST /v1/reserved-slots"] };
      if (path === "/v1/reserved-slots")
        return method === "POST" ? { ok: true } : { reservedSlots: [existing, steamId] };
      if (path === "/v1/config") return document;
      throw new Error("Unexpected route");
    });
    await expect(client.whitelist()).resolves.toMatchObject({
      entries: [
        { steamId: existing, active: true },
        { steamId, active: true },
      ],
      invalidEntryCount: 0,
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId, reason: "Requested access" }),
    ).resolves.toMatchObject({ state: "applied" });
    expect(request).toHaveBeenCalledWith("POST", "/v1/reserved-slots", { steamId });
  });
  it("keeps valid whitelist entries visible when one or more reserved slots are malformed", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/reserved-slots") return { reservedSlots: [existing, "not-a-steam-id", id, null, Number(id)] };
      if (path === "/v1/config") return document;
      throw new Error("Unexpected route");
    });
    await expect(client.whitelist()).resolves.toMatchObject({
      entries: [
        { steamId: existing, active: true, configured: true },
        { steamId: id, active: true, configured: false },
      ],
      invalidEntryCount: 3,
      configurationAvailable: true,
    });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("keeps saved whitelist status available beside malformed numeric config entries", async () => {
    const client = new WardogsClient(settings);
    const shortId = "7656119800000000";
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/reserved-slots") return { reservedSlots: [existing, shortId] };
      if (path === "/v1/config")
        return {
          ...document,
          text: document.text.replace(
            `+DefaultReservedPlayerIds=${existing}`,
            `!DefaultReservedPlayerIds=ClearArray\n.DefaultReservedPlayerIds=${shortId}\n.DefaultReservedPlayerIds=${existing}\n.DefaultReservedPlayerIds=${id}`,
          ),
        };
      throw new Error("Unexpected route");
    });
    await expect(client.whitelist()).resolves.toEqual({
      entries: [
        { steamId: existing, active: true, configured: true },
        { steamId: id, active: false, configured: true },
      ],
      configurationAvailable: true,
      invalidEntryCount: 1,
      configuredInvalidEntryCount: 1,
    });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("rejects an invalid reserved-list envelope instead of claiming the server whitelist is empty", async () => {
    const client = new WardogsClient(settings);
    jest.spyOn(client, "request").mockResolvedValue({ reservedSlots: null });
    await expect(client.whitelist()).rejects.toThrow();
  });
  it.each([true, false])("confirms only the target ID beside unrelated malformed strings (add=%s)", async (add) => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["POST /v1/reserved-slots", "DELETE /v1/reserved-slots/{id}"] };
      if (method !== "GET") return { ok: true };
      if (path === "/v1/reserved-slots")
        return { reservedSlots: [existing, "7656119800000000", "76561197960265728", ...(add ? [id] : [])] };
      throw new Error("Unexpected route");
    });
    await expect(
      client.execute({
        id: randomUUID(),
        ...(add ? { action: "whitelist-add" as const } : { action: "whitelist-remove" as const, confirm: id }),
        steamId: id,
        reason: "Test approval",
      }),
    ).resolves.toMatchObject({ state: "applied" });
    expect(request.mock.calls.filter(([method]) => method !== "GET")).toHaveLength(1);
  });
  it("does not coerce numeric or structurally malformed readback values to confirm a whitelist mutation", async () => {
    const client = new WardogsClient(settings);
    jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["POST /v1/reserved-slots"] };
      if (path === "/v1/reserved-slots") return method === "POST" ? { ok: true } : { reservedSlots: [id, Number(id)] };
      throw new Error("Unexpected route");
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Test approval" }),
    ).resolves.toMatchObject({ state: "unknown" });
  });
  it("reports an unconfigured game as unsent instead of an uncertain mutation", async () => {
    const transport = jest.spyOn(globalThis, "fetch");
    const client = new WardogsClient({
      rcon: () => {
        throw new ServiceUnavailableException("The game server has not been connected yet.");
      },
    } as unknown as AdminSettings);
    await expect(client.request("POST", "/v1/bans", { steamId: id })).rejects.toMatchObject({
      unknownResult: false,
      message: "The game server has not been connected yet.",
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([true, false])("reads the actual whitelist after a config change (live = %s)", async (live) => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["PUT /v1/config"] };
      if (path === "/v1/config") return method === "GET" ? document : { ok: true };
      if (path === "/v1/reserved-slots") return { reservedSlots: live ? [existing, id] : [existing] };
      throw new Error("Unexpected route");
    });
    const result = await client.execute({
      id: randomUUID(),
      action: "whitelist-add",
      steamId: id,
      reason: "Community member",
    });
    expect(result.state).toBe(live ? "applied" : "pending");
    const write = request.mock.calls.find(([method]) => method === "PUT")!;
    expect(write[3]).toBe("r1");
    expect(configuredWhitelist(write[2] as string)).toEqual([existing, id]);
    expect(write[2]).toContain("MaxReservedSlots=0");
    expect(write[2]).toContain("Token=secret");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("uses a supported live route and confirms removal", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["DELETE /v1/reserved-slots/{steamId}"] };
      if (method === "DELETE") return { message: "OK" };
      if (path === "/v1/reserved-slots") return { reservedSlots: [existing] };
      throw new Error("Unexpected route");
    });
    expect(
      (
        await client.execute({
          id: randomUUID(),
          action: "whitelist-remove",
          steamId: id,
          confirm: id,
          reason: "Requested removal",
        })
      ).state,
    ).toBe("applied");
    expect(request).toHaveBeenCalledWith("DELETE", `/v1/reserved-slots/${id}`, undefined);
    expect(request.mock.calls.some(([, path]) => path === "/v1/config")).toBe(false);
  });
  it("does not retry conflicting config writes or reveal upstream secrets", async () => {
    const transport = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "Password=secret" } }), { status: 412 }));
    const client = new WardogsClient(settings);
    await expect(client.request("PUT", "/v1/config", document.text, "r1")).rejects.toMatchObject({
      unknownResult: false,
      message: expect.stringContaining("Another administrator"),
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { "If-Match": '"r1"' } });
  });
  it("classifies a lost mutation response as unknown without retrying", async () => {
    const transport = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("timeout with Authorization: secret"));
    await expect(new WardogsClient(settings).request("POST", "/v1/bans", { steamId: id })).rejects.toMatchObject({
      unknownResult: true,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("honors the server's rate-limit hold", async () => {
    const transport = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    const client = new WardogsClient(settings);
    await expect(client.request("GET", "/v1/status")).rejects.toThrow("pause");
    await expect(client.request("GET", "/v1/status")).rejects.toThrow("pause");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("matches the route templates and whitespace used by the official capability detector", () => {
    expect(serves({ routes: [" PATCH  /v1/players/:steamId "] }, "PATCH", "/v1/players/{id}")).toBe(true);
    expect(serves({ routes: ["DELETE /v1/reserved-slots/{steamId}"] }, "POST", "/v1/reserved-slots")).toBe(false);
  });
  it.each([
    { conflict: true },
    { conflict: [{}] },
    { error: { code: "invalid" } },
    { errors: [{}] },
    { stripped: [{}] },
  ])("refuses an unsafe config validation result %j before writing", async (refusal) => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["PUT /v1/config", "POST /v1/config/validate"] };
      if (path === "/v1/config" && method === "GET") return document;
      if (path === "/v1/config/validate") return { ok: true, ...refusal };
      throw new Error("Unexpected mutation");
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Community member" }),
    ).rejects.toMatchObject({ unknownResult: false });
    expect(request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("accepts Standard-detail validation without timings or other internal fields", async () => {
    const client = new WardogsClient(settings);
    const calls: string[] = [];
    jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === "/v1/capabilities") return { routes: ["PUT /v1/config", "POST /v1/config/validate"] };
      if (path === "/v1/config" && method === "GET") return document;
      if (path === "/v1/config/validate") return { ok: true };
      if (path === "/v1/config" && method === "PUT") return { ok: true };
      if (path === "/v1/reserved-slots") return { reservedSlots: [existing, id] };
      throw new Error("Unexpected route");
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Community member" }),
    ).resolves.toMatchObject({ state: "applied" });
    expect(calls).toEqual([
      "GET /v1/capabilities",
      "GET /v1/config",
      "POST /v1/config/validate",
      "PUT /v1/config",
      "GET /v1/reserved-slots",
    ]);
  });
  it("treats boolean config conflicts returned after PUT as unknown, never successful", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["PUT /v1/config"] };
      if (path === "/v1/config") return method === "GET" ? document : { ok: true, conflict: true };
      throw new Error("Unexpected readback after refusal");
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Community member" }),
    ).rejects.toMatchObject({ unknownResult: true });
    expect(request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
  });
  it("does not report applied from a direct route's explicit refusal", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/capabilities") return { routes: ["POST /v1/reserved-slots"] };
      return { ok: false };
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Community member" }),
    ).rejects.toMatchObject({ unknownResult: false });
    expect(request.mock.calls.filter(([method]) => method === "GET")).toHaveLength(1);
  });
  it("refuses redacted config writes even if PUT is advertised", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/capabilities") return { routes: ["PUT /v1/config"] };
      return { ...document, text: document.text.replace("Token=secret", "Token=<redacted>") };
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Community member" }),
    ).rejects.toThrow("redacted");
    expect(request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("honors the advertised config body limit before sending validation or mutation", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/capabilities") return { routes: ["PUT /v1/config"], limits: { maxBodyBytes: 32 } };
      return document;
    });
    await expect(
      client.execute({ id: randomUUID(), action: "whitelist-add", steamId: id, reason: "Community member" }),
    ).rejects.toThrow("request limit");
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("uses the running ban list to confirm bans without silently editing an offline ID into config", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["POST /v1/bans"] };
      if (path === "/v1/bans") return method === "POST" ? { message: "OK" } : { bans: [{ steamId: id }] };
      throw new Error("Unexpected route");
    });
    await expect(
      client.execute({ id: randomUUID(), action: "ban", steamId: id, confirm: id, reason: "Reviewed evidence" }),
    ).resolves.toMatchObject({ state: "applied" });
    expect(request.mock.calls.some(([, path]) => path === "/v1/config")).toBe(false);
  });
  it("explains a current-build offline-player refusal without exposing upstream details", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "player_not_found", message: "Password=secret" } }), {
        status: 404,
      }),
    );
    await expect(new WardogsClient(settings).request("POST", "/v1/bans", { steamId: id })).rejects.toEqual(
      new RconError(
        "The game could not find that connected player. This build may require the player to be online, including for bans.",
      ),
    );
  });
  it("keeps a timed-out validation non-mutating and never retries it", async () => {
    const transport = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    await expect(
      new WardogsClient(settings).request("POST", "/v1/config/validate", document.text),
    ).rejects.toMatchObject({ unknownResult: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("retains the official console's conservative 200-character message limit", () => {
    const action = {
      id: randomUUID(),
      action: "broadcast",
      reason: "Community announcement",
      message: "x".repeat(200),
    };
    expect(actionSchema.safeParse(action).success).toBe(true);
    expect(actionSchema.safeParse({ ...action, message: "x".repeat(201) }).success).toBe(false);
  });
});

describe("current server map catalogs", () => {
  afterEach(() => jest.restoreAllMocks());
  const mapAction: AdminAction = {
    id: randomUUID(),
    action: "map",
    map: "Kavkazi",
    experiences: ["NorthAmerica_KOTH_01"],
    confirm: "CHANGE MAP",
    reason: "Next community match",
  };
  const catalogResponse = (path: string) => {
    if (path === "/v1/catalog/maps") return { maps: [{ id: "Kavkazi" }] };
    if (path === "/v1/catalog/lightings") return { lightings: [{ id: "DayClear" }] };
    if (path === "/v1/catalog/experiences")
      return { experiences: [{ id: "Kavkazi_KOTH_01" }, { id: "NorthAmerica_KOTH_01" }] };
    if (path === "/v1/catalog/maps/Kavkazi/experiences") return { experiences: ["Kavkazi_KOTH_01"] };
    if (path === "/v1/catalog/maps/Kavkazi/alternators")
      return { alternators: [{ tag: "ZoneAlternator.Bakurani.Default.Circle" }] };
    throw new Error("Unexpected route");
  };
  const routes = [
    "POST /v1/match/map",
    "GET /v1/catalog/maps",
    "GET /v1/catalog/lightings",
    "GET /v1/catalog/experiences",
    "GET /v1/catalog/maps/{map}/experiences",
    "GET /v1/catalog/maps/{map}/alternators",
  ];
  it("rejects an experience belonging to a different map even if it exists globally", async () => {
    const client = new WardogsClient(settings);
    const request = jest
      .spyOn(client, "request")
      .mockImplementation(async (_method, path) => (path === "/v1/capabilities" ? { routes } : catalogResponse(path)));
    await expect(client.execute(mapAction)).rejects.toThrow("not available for this map");
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("rejects a zone layout absent from the selected map's catalog", async () => {
    const client = new WardogsClient(settings);
    const request = jest
      .spyOn(client, "request")
      .mockImplementation(async (_method, path) => (path === "/v1/capabilities" ? { routes } : catalogResponse(path)));
    await expect(
      client.execute({ ...mapAction, experiences: [], zoneAlternator: "ZoneAlternator.NorthAmerica.Other" }),
    ).rejects.toThrow("not available for this map");
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("omits empty optional selections exactly as the official console does", async () => {
    const client = new WardogsClient(settings);
    const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
      if (path === "/v1/capabilities") return { routes };
      if (path === "/v1/match/map") return { message: "OK" };
      return catalogResponse(path);
    });
    await expect(client.execute({ ...mapAction, experiences: [], zoneAlternator: "None" })).resolves.toMatchObject({
      state: "accepted",
    });
    expect(request).toHaveBeenCalledWith("POST", "/v1/match/map", { map: "Kavkazi" });
  });
});

describe("live faction assignment", () => {
  afterEach(() => jest.restoreAllMocks());
  const factions = [
    { name: "Valkyra", colorHex: "#D86060", score: 12 },
    { name: "Lonestar", colorHex: "#5B95D8", score: 15 },
    { name: "Manticore", colorHex: "#7BC462", score: 18 },
  ];
  const status = { serverName: "The UNCs", map: "Kavkazi", players: { current: 2, max: 100 }, factionScores: factions };
  const teamAction: Extract<AdminAction, { action: "team" }> = {
    id: randomUUID(),
    action: "team",
    steamId: id,
    confirm: id,
    faction: "Lonestar",
    reason: "Requested by this player",
  };

  function mockTeamChange(
    options: {
      before?: string | null;
      after?: string | null;
      targetPresent?: boolean;
      currentStatus?: typeof status;
      afterStatus?: typeof status;
      disconnectAfter?: boolean;
      failReadback?: boolean;
      refusal?: boolean;
    } = {},
  ) {
    const client = new WardogsClient(settings);
    let sent = false;
    const request = jest.spyOn(client, "request").mockImplementation(async (method, path) => {
      if (path === "/v1/capabilities") return { routes: ["PATCH /v1/players/{steamId}"] };
      if (path === "/v1/status")
        return sent ? (options.afterStatus ?? options.currentStatus ?? status) : (options.currentStatus ?? status);
      if (path === "/v1/players") {
        if (sent && options.failReadback) throw new RconError("Connection unavailable");
        return {
          players: [
            { steamId: null, faction: "RED" },
            ...(options.targetPresent === false || (sent && options.disconnectAfter)
              ? []
              : [{ steamId: id, faction: sent ? (options.after ?? "BLU") : (options.before ?? "RED") }]),
          ],
        };
      }
      if (method === "PATCH" && path === `/v1/players/${id}`) {
        sent = true;
        return options.refusal ? { ok: false } : { ok: true, pending: false };
      }
      throw new Error("Unexpected route; no automatic kill or retry is permitted");
    });
    return { client, request };
  }

  it("rejects a changed expected faction without moving or killing the player", async () => {
    const { client, request } = mockTeamChange({ before: "GRN" });
    expect(await client.execute({ ...teamAction, expectedFaction: "Valkyra" })).toMatchObject({
      state: "failed",
      changed: false,
    });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("does not treat an already-correct faction as a move requiring respawn", async () => {
    const { client } = mockTeamChange({ before: "BLU" });
    expect(await client.execute(teamAction)).toMatchObject({ state: "applied", changed: false });
  });
  it("rejects a move from a previous or unreadable round", async () => {
    const { client, request } = mockTeamChange();
    expect(
      await client.execute({ ...teamAction, expectedRound: { map: "Kavkazi", startedAt: Date.now() - 120_000 } }),
    ).toMatchObject({ state: "failed", changed: false });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it.each(["wrong team", "wrong round", "missing", "duplicate", "valid"])(
    "checks the %s condition immediately before an optional respawn",
    async (condition) => {
      const client = new WardogsClient(settings);
      const request = jest.spyOn(client, "request").mockImplementation(async (_method, path) => {
        if (path === "/v1/capabilities") return { routes: ["POST /v1/players/{id}/kill"] };
        if (path === "/v1/status") return { ...status, matchSeconds: condition === "wrong round" ? 0 : 120 };
        if (path === "/v1/players")
          return {
            players:
              condition === "missing"
                ? []
                : Array.from({ length: condition === "duplicate" ? 2 : 1 }, () => ({
                    steamId: id,
                    faction: condition === "wrong team" ? "RED" : "BLU",
                  })),
          };
        if (path.endsWith("/kill")) return { ok: true };
        throw new Error("Unexpected test route");
      });
      const result = await client.execute({
        id: randomUUID(),
        action: "kill",
        steamId: id,
        confirm: id,
        reason: "Reviewed optional respawn",
        expectedFaction: "Lonestar",
        expectedRound: { map: "Kavkazi", startedAt: Date.now() - 120_000 },
      });
      expect(result.state).toBe(condition === "valid" ? "accepted" : "failed");
      expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(condition === "valid" ? 1 : 0);
    },
  );

  it.each([
    ["Lonestar", "BLU", "RED"],
    ["Valkyra", "RED", "GRN"],
    ["Manticore", "GRN", "BLU"],
  ])("sends the current faction name %s and confirms player code %s", async (faction, after, before) => {
    const { client, request } = mockTeamChange({ before, after });
    const result = await client.execute({ ...teamAction, faction });
    expect(result.state).toBe("applied");
    expect(result.message).toContain("Faction assignment confirmed");
    expect(result.message).toContain("may still need to respawn");
    expect(request).toHaveBeenCalledWith("PATCH", `/v1/players/${id}`, { faction });
    expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    expect(request.mock.calls.some(([, path]) => path.endsWith("/kill"))).toBe(false);
  });
  it("uses live names and the official palette instead of assuming Lonestar always exists", async () => {
    const currentStatus = {
      ...status,
      factionScores: factions.map((team) =>
        team.name === "Lonestar" ? { ...team, name: "CurrentBlueFaction", colorHex: "#5b95d8" } : team,
      ),
    };
    const { client, request } = mockTeamChange({ currentStatus });
    await expect(client.execute({ ...teamAction, faction: "CurrentBlueFaction" })).resolves.toMatchObject({
      state: "applied",
    });
    expect(request).toHaveBeenCalledWith("PATCH", `/v1/players/${id}`, { faction: "CurrentBlueFaction" });
  });
  it("does not send a redundant move when the player is already on the chosen faction", async () => {
    const { client, request } = mockTeamChange({ before: "BLU" });
    await expect(client.execute(teamAction)).resolves.toMatchObject({
      state: "applied",
      message: expect.stringContaining("already assigned"),
    });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("refuses a color code passed as if it were a currently reported faction name", async () => {
    const { client, request } = mockTeamChange();
    await expect(client.execute({ ...teamAction, faction: "BLU" })).rejects.toThrow("currently reported");
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("refuses a disconnected player before any move", async () => {
    const { client, request } = mockTeamChange({ targetPresent: false });
    await expect(client.execute(teamAction)).rejects.toThrow("no longer connected");
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("does not label an accepted but unchanged assignment as applied", async () => {
    const { client, request } = mockTeamChange({ after: "RED" });
    await expect(client.execute(teamAction)).resolves.toMatchObject({ state: "pending" });
    expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
  });
  it.each([{ disconnectAfter: true }, { failReadback: true }])(
    "returns unknown when readback cannot confirm the player: %j",
    async (options) => {
      const { client, request } = mockTeamChange(options);
      await expect(client.execute(teamAction)).resolves.toMatchObject({ state: "unknown" });
      expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    },
  );
  it("does not force a kill or retry after a refused move", async () => {
    const { client, request } = mockTeamChange({ refusal: true });
    await expect(client.execute(teamAction)).rejects.toThrow("did not accept");
    expect(request.mock.calls.filter(([method]) => method !== "GET")).toEqual([
      ["PATCH", `/v1/players/${id}`, { faction: "Lonestar" }],
    ]);
  });
  it("checks refreshed faction metadata rather than confirming a stale color assignment", async () => {
    const afterStatus = {
      ...status,
      factionScores: factions.map((team) => ({
        ...team,
        colorHex: team.name === "Lonestar" ? "#7BC462" : team.name === "Manticore" ? "#5B95D8" : team.colorHex,
      })),
    };
    const { client } = mockTeamChange({ afterStatus });
    await expect(client.execute(teamAction)).resolves.toMatchObject({ state: "pending" });
  });
  it("does not guess a team from unfamiliar or ambiguous color values", async () => {
    for (const colorHex of ["#5B95D8FF", "5B95D8", "#7BC462"]) {
      const currentStatus = {
        ...status,
        factionScores: factions.map((team) => (team.name === "Lonestar" ? { ...team, colorHex } : team)),
      };
      const { client } = mockTeamChange({ currentStatus, after: colorHex === "#7BC462" ? "GRN" : "BLU" });
      await expect(client.execute(teamAction)).resolves.toMatchObject({ state: "pending" });
    }
  });
  it("can confirm a future server returning the exact faction name instead of a known player code", async () => {
    const { client } = mockTeamChange({ after: "Lonestar" });
    await expect(client.execute(teamAction)).resolves.toMatchObject({ state: "applied" });
  });
});
