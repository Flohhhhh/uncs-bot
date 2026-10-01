import type { EnvService } from "../env/env.service";
import { Env } from "../env/env";
import { AdminSettings } from "./admin.settings";
import { GameServers } from "./game-servers";

const servers = [
  { id: "east", name: "UNCs East", rconUrl: "https://east.example.test", password: "east-test-secret" },
  { id: "central", name: "UNCs Central", rconUrl: "https://central.example.test", password: "central-test-secret" },
];
function settings(registry: unknown = servers) {
  const values: Record<string, unknown> = {
    WARDOGS_SERVERS: registry,
    WARDOGS_RCON_URL: "https://legacy.example.test",
    WARDOGS_RCON_PASSWORD: "legacy-test-secret",
  };
  return new AdminSettings({ get: (key: string) => values[key] } as EnvService);
}

describe("explicit game-server registry", () => {
  afterEach(() => jest.restoreAllMocks());

  it("exposes only labels, requires an explicit exact ID and makes no discovery requests", () => {
    const transport = jest.spyOn(globalThis, "fetch");
    const registry = new GameServers(settings());
    expect(registry.list()).toMatchObject([
      { id: "east", name: "UNCs East" },
      { id: "central", name: "UNCs Central" },
    ]);
    expect(JSON.stringify(registry.list())).not.toMatch(/secret|https:/);
    for (const id of ["", "primary", "East", "toString", "https://evil.example"]) {
      expect(() => registry.get(id)).toThrow("Choose a configured");
    }
    expect(registry.get("east")).toBe(registry.get("east"));
    expect(registry.get("east")).not.toBe(registry.get("central"));
    expect(transport).not.toHaveBeenCalled();
  });

  it("separates overlapping player reads and uses only each target's credential", async () => {
    const transport = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const server = servers.find((candidate) => candidate.rconUrl === url.origin)!;
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${server.password}`);
      return new Response(
        JSON.stringify(
          url.pathname === "/v1/capabilities"
            ? { routes: [] }
            : url.pathname === "/v1/status"
              ? { serverName: server.name, map: server.id, players: { current: 1, max: 100 } }
              : { players: [{ steamId: "76561198000000001", name: server.name }] },
        ),
      );
    });
    const registry = new GameServers(settings());
    const east = registry.get("east"),
      central = registry.get("central");
    const [first, second, duplicate] = await Promise.all([east.overview(), central.overview(), east.overview()]);
    expect(first.status.map).toBe("east");
    expect(second.status.map).toBe("central");
    expect(first.players[0].name).toBe("UNCs East");
    expect(second.players[0].name).toBe("UNCs Central");
    expect(duplicate).toEqual(first);
    expect(transport).toHaveBeenCalledTimes(6);
    await central.overview();
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it("keeps one server's Retry-After pause from blocking another", async () => {
    const transport = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).startsWith(servers[0].rconUrl)
          ? new Response("{}", { status: 429, headers: { "Retry-After": "60" } })
          : new Response('{"ok":true}'),
      );
    const registry = new GameServers(settings());
    await expect(registry.get("east").request("GET", "/v1/status")).rejects.toThrow("short pause");
    await expect(registry.get("central").request("GET", "/v1/status")).resolves.toEqual({ ok: true });
    await expect(registry.get("east").request("GET", "/v1/status")).rejects.toThrow("short pause");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not retarget a created client if a mutable caller changes its configuration", async () => {
    const config = servers.map((server) => ({ ...server }));
    const registry = new GameServers(settings(config));
    const east = registry.get("east");
    config[0].rconUrl = "https://wrong.example.test";
    config[0].password = "wrong-secret";
    expect(() => registry.get("east")).toThrow("Restart this instance");
    const transport = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await east.request("GET", "/v1/status");
    expect(transport).toHaveBeenCalledWith(
      "https://east.example.test/v1/status",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer east-test-secret" }),
      }),
    );
  });

  it("preserves legacy connection behavior and refuses implicit registry targets", () => {
    const absent = new AdminSettings({
      get: (key: string) =>
        key === "WARDOGS_SERVERS"
          ? undefined
          : key === "WARDOGS_RCON_URL"
            ? "https://legacy.example.test"
            : "legacy-test-secret",
    } as EnvService);
    expect(absent.servers()).toMatchObject([{ id: "primary", name: "The UNCs" }]);
    expect(absent.rcon()).toEqual({ rconUrl: "https://legacy.example.test", password: "legacy-test-secret" });
    expect(() => absent.connection("east")).toThrow("not configured");
    expect(() => settings().rcon()).toThrow("explicit server selection");
    expect(() => settings([servers[0]]).rcon()).toThrow("explicit server selection");
  });
});

describe("server deployment configuration", () => {
  it("validates the whole registry without involving a game connection", () => {
    expect(Env.shape.WARDOGS_SERVERS.parse(JSON.stringify(servers))).toEqual(servers);
    expect(Env.shape.WARDOGS_SERVERS.parse(undefined)).toBeUndefined();
  });

  it("preserves spaces in a password instead of silently changing its credential", () => {
    const configured = [{ ...servers[0], password: " a valid password " }];
    expect(Env.shape.WARDOGS_SERVERS.parse(JSON.stringify(configured))).toEqual(configured);
  });

  it.each(
    [
      [],
      [{ ...servers[0], id: "" }],
      [{ ...servers[0], id: "../east" }],
      [{ ...servers[0], name: "Unsafe\nlabel" }],
      [servers[0], { ...servers[1], id: "east" }],
      [servers[0], { ...servers[1], rconUrl: "https://EAST.example.test/" }],
      [{ ...servers[0], rconUrl: "https://user:password@example.test" }],
      [{ ...servers[0], rconUrl: "file:///secret" }],
      [{ ...servers[0], rconUrl: "https://east.example.test?server=other" }],
      [{ ...servers[0], rconUrl: "https://east.example.test#other" }],
      [{ ...servers[0], rconUrl: "https://east.example.test\n" }],
      [{ ...servers[0], password: "" }],
      [{ ...servers[0], password: "   " }],
      [{ ...servers[0], password: "header\ninjection" }],
      [{ ...servers[0], unknown: true }],
    ].map((input) => ({ input })),
  )("rejects ambiguous, malformed or unsafe server definitions: %#", ({ input }) => {
    expect(Env.shape.WARDOGS_SERVERS.safeParse(JSON.stringify(input)).success).toBe(false);
  });

  it("does not echo credentials when JSON is malformed", () => {
    const parsed = Env.shape.WARDOGS_SERVERS.safeParse('{"password":"private-test-secret"');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).not.toContain("private-test-secret");
  });
  it("rejects shared feed credentials, reused game passwords and shared status-card destinations", () => {
    const token = "a-separate-feed-token-long-enough-123";
    const card = { channelId: "123456789012345678", messageId: "234567890123456789" };
    for (const input of [
      servers.map((server) => ({ ...server, feedToken: token })),
      [
        { ...servers[0], password: token },
        { ...servers[1], feedToken: token },
      ],
      servers.map((server) => ({ ...server, communityStatus: card })),
    ])
      expect(Env.shape.WARDOGS_SERVERS.safeParse(JSON.stringify(input)).success).toBe(false);
  });
});
