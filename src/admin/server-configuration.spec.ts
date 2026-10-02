import { randomUUID } from "node:crypto";
import { WardogsClient } from "./wardogs.client";
import { AdminSettings } from "./admin.settings";
import { actionSchema, type ConfigDocument } from "./admin.types";
import { auditAction, formatRotation, parseRotation, planMapNext } from "./server-configuration";
import { SESSION, ROTATION, type MapSelection } from "../common/server-settings";
import { AdminService } from "./admin.service";
import { AdminStore } from "./admin.store";
import { fixtureServers } from "./game-server-fixture";
import { RconError } from "./rcon-protocol";

const original = `[${SESSION}]\r\n; keep identity comment\r\nServerName="The UNCs"\r\nServerPassword="private-join-secret"\r\nServerMinPlayerCash=0\r\nServerMaxPlayerCash=0\r\n+DefaultReservedPlayerIds=76561198000000001\r\n[MatchState.Playing.KOTH]\r\nScorePeriod=24\r\n[${ROTATION}]\r\nbEnabled=True\r\nRotationMode=Ordered\r\n+RotationEntries=(Map="Kavkazi",Experiences="KOTH",Lighting="DayClear")\r\n+RotationEntries=(Map="Europe",Experiences="KOTH",Lighting="DayClear")\r\n[WDServerFeed]\r\nUrl=http://127.0.0.1:32190\r\nToken=private-feed-secret\r\n`;
function fixture() {
  let document: ConfigDocument = {
    text: original,
    revision: "r1",
    writable: true,
    sections: [{ section: "MatchState.Playing.KOTH", appliesWhen: "next-match" }],
  };
  const capabilities = {
    routes: [
      "GET /v1/config",
      "PUT /v1/config",
      "POST /v1/config/validate",
      "GET /v1/catalog/maps",
      "GET /v1/catalog/lightings",
      "GET /v1/catalog/experiences",
    ],
  };
  const status = {
    serverName: "The UNCs",
    map: "Kavkazi",
    players: { current: 2, max: 100 },
    scoreTick: { current: 24, min: 20, max: 30 },
    rotation: { nowIndex: 0 },
  };
  const game = new WardogsClient({} as AdminSettings);
  const request = jest.spyOn(game, "request").mockImplementation(async (method, path, body, revision) => {
    if (path === "/v1/capabilities") return capabilities;
    if (path === "/v1/status") return status;
    if (path === "/v1/config/validate") return { ok: true };
    if (path === "/v1/config" && method === "GET") return document;
    if (path === "/v1/config" && method === "PUT") {
      expect(revision).toBe(document.revision);
      document = { ...document, text: String(body), revision: "r2" };
      return { ok: true, outcomes: [{ section: "MatchState.Playing.KOTH", state: "next-match" }] };
    }
    if (path === "/v1/catalog/maps") return { maps: [{ id: "Kavkazi" }, { id: "Europe" }] };
    if (path === "/v1/catalog/lightings") return { lightings: [{ id: "DayClear" }] };
    if (path === "/v1/catalog/experiences") return { experiences: [{ id: "KOTH" }, { id: "KOTH_InfantryOnly" }] };
    throw new Error("Unexpected test route");
  });
  return { game, request, status, capabilities, document, saved: () => document };
}
const save = (changes: Record<string, string | number | boolean>, revision = "r1") =>
  actionSchema.parse({
    id: randomUUID(),
    reason: "Reviewed server settings",
    action: "settings-save",
    revision,
    changes,
  });
describe("server configuration boundaries", () => {
  it("checks repeated saved selections once per catalog path, reports unavailable zones, and never writes", async () => {
    const f = fixture();
    f.capabilities.routes.push("GET /v1/catalog/maps/{map}/experiences", "GET /v1/catalog/maps/{map}/alternators");
    f.document.text = `[${ROTATION}]\n${Array.from({ length: 73 }, (_, i) => `.RotationEntries=(Map="Kavkazi",Experiences="KOTH",Lighting="DayClear",ZoneAlternator="${i % 12 === 10 ? "Zone.River" : "Zone.Default"}")`).join("\n")}`;
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, path, body, revision) => {
      if (path.endsWith("/experiences") && path.includes("/maps/")) return { experiences: ["KOTH"] };
      if (path.endsWith("/alternators")) return { alternators: [{ tag: "Zone.Default" }] };
      return fallback(method, path, body, revision);
    });
    const result = await f.game.checkRotation();
    expect(result).toMatchObject({ revision: "r1", total: 73 });
    expect(result.issues).toHaveLength(6);
    expect(result.issues.every((issue) => issue.unavailable && issue.message.includes("Zone.River"))).toBe(true);
    expect(f.request.mock.calls.filter(([, path]) => path.includes("/catalog/maps/Kavkazi/"))).toHaveLength(2);
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    f.request.mockClear();
    await f.game.checkRotation();
    expect(f.request.mock.calls.filter(([, path]) => path.includes("/catalog/maps/Kavkazi/"))).toHaveLength(2);
  });
  it("distinguishes an unreadable map catalog from a confirmed unavailable option", async () => {
    const f = fixture();
    f.capabilities.routes.push("GET /v1/catalog/maps/{map}/experiences");
    const result = await f.game.checkRotation();
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => !issue.unavailable && issue.message.includes("could not be verified"))).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain("Unexpected test route");
  });
  it("reuses map validation reads during a rotation save while still checking every entry", async () => {
    const f = fixture();
    f.capabilities.routes.push("GET /v1/catalog/maps/{map}/experiences", "GET /v1/catalog/maps/{map}/alternators");
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, path, body, revision) => {
      if (path.endsWith("/experiences") && path.includes("/maps/")) return { experiences: ["KOTH"] };
      if (path.endsWith("/alternators")) return { alternators: [{ tag: "Zone.Default" }] };
      return fallback(method, path, body, revision);
    });
    await f.game.execute({
      id: randomUUID(),
      action: "rotation-save",
      reason: "Review rotation",
      revision: "r1",
      entries: Array.from({ length: 73 }, () => ({
        map: "Kavkazi",
        experiences: ["KOTH"],
        zoneAlternator: "Zone.Default",
      })),
    });
    expect(f.request.mock.calls.filter(([, path]) => path.includes("/catalog/maps/Kavkazi/"))).toHaveLength(2);
    expect(f.request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
    expect(parseRotation(f.saved().text)).toHaveLength(73);
  });
  it.each(["wrong-map-mode", "missing-zone", "catalog-outage", "stale-revision", "game-rejection"])(
    "does not write an unsafe rotation: %s",
    async (kind) => {
      const f = fixture();
      f.capabilities.routes.push("GET /v1/catalog/maps/{map}/experiences", "GET /v1/catalog/maps/{map}/alternators");
      const fallback = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (method, path, body, revision) => {
        if (path.includes("/maps/") && path.endsWith("/experiences")) {
          if (kind === "catalog-outage") throw new Error("Read failed");
          return { experiences: kind === "wrong-map-mode" ? [] : ["KOTH"] };
        }
        if (path.endsWith("/alternators")) return { alternators: [{ tag: "Zone.Default" }] };
        if (path === "/v1/config/validate" && kind === "game-rejection") return { ok: false };
        return fallback(method, path, body, revision);
      });
      await expect(
        f.game.execute({
          id: randomUUID(),
          action: "rotation-save",
          reason: "Review rotation",
          revision: kind === "stale-revision" ? "old" : "r1",
          entries: [
            {
              map: "Kavkazi",
              experiences: ["KOTH"],
              zoneAlternator: kind === "missing-zone" ? "Zone.River" : "Zone.Default",
            },
          ],
        }),
      ).rejects.toThrow();
      expect(f.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
      expect(f.saved().text).toBe(original);
    },
  );
  it("shows documented values and timings without disclosing passwords, raw INI or feed credentials", async () => {
    const { game } = fixture();
    const view = await game.configuration();
    expect(view.fields.find((field) => field.id === "serverPassword")).toMatchObject({ value: null, editable: true });
    expect(view.fields.find((field) => field.id === "scorePeriod")).toMatchObject({ value: 24, state: "next-match" });
    expect(view.scoreTick).toMatchObject({ min: 20, max: 30 });
    expect(JSON.stringify(view)).not.toMatch(/private-|WDServerFeed|DefaultReservedPlayerIds/);
  });
  it.each(["Europe", "Ozeti"])(
    "uses the running marker with status map %s when status omits its position",
    async (map) => {
      const f = fixture();
      f.status.map = map;
      f.capabilities.routes.push("GET /v1/rotation");
      const originalRequest = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (...args) => {
        if (args[1] === "/v1/status") return { ...f.status, rotation: undefined };
        if (args[1] === "/v1/rotation")
          return {
            enabled: true,
            mode: "Ordered",
            entries: parseRotation(original).map((entry, index) => ({
              ...entry,
              map: map === "Ozeti" ? (index === 0 ? "Bakurani" : "Ozeti") : entry.map,
              index,
              status: index === 1 ? "now" : null,
            })),
          };
        return originalRequest(...args);
      });
      expect((await f.game.configuration()).rotation.currentIndex).toBe(1);
      expect(f.request.mock.calls.some(([method]) => method !== "GET")).toBe(false);
      await f.game.execute({
        id: randomUUID(),
        action: "map-next",
        reason: "Next round choice",
        revision: "r1",
        currentIndex: 1,
        currentMap: map,
        entry: { map: "Kavkazi", experiences: ["KOTH"], lighting: "DayClear" },
      });
      expect(parseRotation(f.saved().text).map((entry) => entry.map)).toEqual(["Kavkazi", "Europe", "Kavkazi"]);
      expect(f.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
    },
  );
  it.each([
    ["Kavkazi", "Bakurani"],
    ["Europe", "Ozeti"],
    ["NorthAmerica", "Zestafona"],
  ])("matches saved %s to live %s without rewriting catalog IDs", async (id, name) => {
    const f = fixture();
    f.document.text = original.replace('Map="Kavkazi"', `Map="${id}"`);
    f.status.map = name;
    const snapshot = await f.game.configuration();
    expect(snapshot.rotation).toMatchObject({ currentIndex: 0, currentMap: name, positionNote: "" });
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    await f.game.execute({
      id: randomUUID(),
      action: "map-next",
      reason: "Next round choice",
      revision: "r1",
      currentIndex: 0,
      currentMap: name,
      entry: { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] },
    });
    expect(parseRotation(f.saved().text).slice(0, 2)).toEqual([
      { map: id, experiences: ["KOTH"], lighting: "DayClear" },
      { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] },
    ]);
    expect(f.request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
    expect(f.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
  });
  it("uses the marked occurrence for duplicate maps without requiring a numeric index", async () => {
    const f = fixture();
    f.document.text = original.replace(
      'Map="Europe",Experiences="KOTH"',
      'Map="Kavkazi",Experiences="KOTH+KOTH_InfantryOnly"',
    );
    f.status.rotation.nowIndex = -1;
    f.capabilities.routes.push("GET /v1/rotation");
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) =>
      args[1] === "/v1/rotation"
        ? {
            enabled: true,
            mode: "ordered",
            entries: parseRotation(f.document.text).map((entry, i) => ({ ...entry, status: i === 1 ? "now" : null })),
          }
        : fallback(...args),
    );
    expect((await f.game.configuration()).rotation.currentIndex).toBe(1);
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it.each([
    "unadvertised",
    "outage",
    "no-marker",
    "two-markers",
    "wrong-index",
    "wrong-map",
    "wrong-rules",
    "wrong-light",
    "wrong-zone",
    "wrong-length",
    "wrong-order",
    "disabled",
    "denied",
    "conflicting-status-index",
  ])("keeps next-map writes blocked when rotation evidence is unsafe: %s", async (kind) => {
    const f = fixture();
    f.status.rotation.nowIndex = kind === "conflicting-status-index" ? 1 : -1;
    if (kind !== "unadvertised") f.capabilities.routes.push("GET /v1/rotation");
    if (kind === "wrong-zone")
      f.document.text = original.replace('Lighting="DayClear"', 'Lighting="DayClear",ZoneAlternator="Zone.Default"');
    const running = {
      enabled: kind !== "disabled",
      mode: kind === "wrong-order" ? "random" : "ordered",
      entries: parseRotation(f.document.text).map((entry, i) => ({
        ...entry,
        index: i,
        status: (kind === "two-markers" || i === 0) && kind !== "no-marker" ? "now" : null,
        denied: kind === "denied",
      })),
    };
    if (kind === "wrong-index") running.entries[0].index = 1;
    if (kind === "wrong-map") running.entries[1].map = "Kavkazi";
    if (kind === "wrong-rules") running.entries[1].experiences = ["KOTH_InfantryOnly"];
    if (kind === "wrong-light") running.entries[1].lighting = "Night";
    if (kind === "wrong-zone") running.entries[0].zoneAlternator = "Zone.River";
    if (kind === "wrong-length") running.entries.pop();
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[1] === "/v1/rotation") {
        if (kind === "outage") throw new Error("private-upstream-error");
        return running;
      }
      return fallback(...args);
    });
    const view = await f.game.configuration();
    expect(view.rotation.currentIndex).toBeNull();
    expect(view.rotation.positionNote).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain("private-upstream-error");
    expect(view.rotation.entries).toHaveLength(2);
    await expect(
      f.game.execute({
        id: randomUUID(),
        action: "map-next",
        reason: "Next round choice",
        revision: "r1",
        currentIndex: 0,
        currentMap: "Kavkazi",
        entry: { map: "Europe", experiences: ["KOTH"] },
      }),
    ).rejects.toThrow();
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    if (kind === "conflicting-status-index" || kind === "unadvertised")
      expect(f.request.mock.calls.some(([, path]) => path === "/v1/rotation")).toBe(false);
  });
  it("rechecks the running marker before writing and refuses a round that moved after review", async () => {
    const f = fixture();
    f.status.rotation.nowIndex = -1;
    f.capabilities.routes.push("GET /v1/rotation");
    let now = 0;
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) =>
      args[1] === "/v1/rotation"
        ? {
            enabled: true,
            mode: "ordered",
            entries: parseRotation(original).map((entry, index) => ({
              ...entry,
              index,
              status: index === now ? "now" : null,
            })),
          }
        : fallback(...args),
    );
    expect((await f.game.configuration()).rotation.currentIndex).toBe(0);
    now = 1;
    f.status.map = "Europe";
    await expect(
      f.game.execute({
        id: randomUUID(),
        action: "map-next",
        reason: "Next round choice",
        revision: "r1",
        currentIndex: 0,
        currentMap: "Kavkazi",
        entry: { map: "Europe", experiences: ["KOTH"] },
      }),
    ).rejects.toThrow("current round changed");
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  // The primary server's reads on October 2: no running entry, next entry 0, and a queued
  // Infantry Only entry saved without lighting. Unset details are reported as null here.
  function betweenRotationRounds(nextIndex: number | null = 0) {
    const f = fixture();
    f.document.text = original.replace(
      '+RotationEntries=(Map="Europe"',
      '+RotationEntries=(Map="Kavkazi",Experiences="KOTH+KOTH_InfantryOnly")\r\n+RotationEntries=(Map="Europe"',
    );
    f.status.map = "Bakurani";
    f.status.rotation = { nowIndex: null, nextIndex } as never;
    f.capabilities.routes.push("GET /v1/rotation");
    const running = {
      enabled: true,
      mode: "Ordered",
      entries: parseRotation(f.document.text).map((entry) => ({
        map: entry.map,
        experiences: entry.experiences,
        lighting: entry.lighting ?? null,
        zoneAlternator: entry.zoneAlternator ?? null,
        status: null as string | null,
        denied: null,
      })),
    };
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => (args[1] === "/v1/rotation" ? running : fallback(...args)));
    return { ...f, running };
  }
  const queueNext = (currentIndex: number) => ({
    id: randomUUID(),
    action: "map-next" as const,
    reason: "Next round choice",
    revision: "r1",
    currentIndex,
    currentMap: "Bakurani",
    entry: { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] },
  });
  it("shows the game's own next entry but does not queue when no running entry is named", async () => {
    const f = betweenRotationRounds();
    const { rotation } = await f.game.configuration();
    expect(rotation).toMatchObject({ currentIndex: null, nextIndex: 0 });
    expect(rotation.positionNote).toContain("will play entry 1 next");
    // Live, a row inserted before the game's next entry was skipped. Never write one in this state.
    await expect(f.game.execute(queueNext(0))).rejects.toThrow("will play entry 1 next");
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("reads entries with unset details and queues after the running entry", async () => {
    const f = betweenRotationRounds(1);
    f.running.entries[0].status = "now";
    f.running.entries[1].status = "next";
    expect((await f.game.configuration()).rotation).toMatchObject({ currentIndex: 0, nextIndex: 1, positionNote: "" });
    expect(await f.game.execute(queueNext(0))).toMatchObject({ state: "pending" });
    expect(parseRotation(f.saved().text)).toEqual([
      { map: "Kavkazi", experiences: ["KOTH"], lighting: "DayClear" },
      { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"] },
      { map: "Kavkazi", experiences: ["KOTH", "KOTH_InfantryOnly"] },
      { map: "Europe", experiences: ["KOTH"], lighting: "DayClear" },
    ]);
    expect(f.request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
    expect(f.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
  });
  it.each(["no-next", "outside", "conflicting-marker", "unset-differs", "two-current"])(
    "keeps next-map writes blocked when the rotation position is not confirmed: %s",
    async (kind) => {
      const f = betweenRotationRounds(kind === "no-next" ? null : kind === "outside" ? 3 : 0);
      if (kind === "conflicting-marker") f.running.entries[2].status = "next";
      // A saved value is never matched by an unset running value.
      if (kind === "unset-differs") f.running.entries[0].lighting = null;
      if (kind === "two-current") f.running.entries[0].status = f.running.entries[1].status = "now";
      const view = await f.game.configuration();
      expect(view.rotation).toMatchObject({ currentIndex: null, nextIndex: null });
      expect(view.rotation.positionNote).toBeTruthy();
      await expect(f.game.execute(queueNext(0))).rejects.toThrow();
      expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    },
  );
  it.each([
    [
      "a requested pause",
      new RconError("The game requested a short pause. Wait before trying again."),
      "The running rotation could not be read. The game requested a short pause. Wait before trying again.",
    ],
    [
      "an unexpected reply",
      { enabled: true, mode: "Ordered", entries: [{ map: 42 }] },
      "The running rotation could not be read. The game's reply was not in the expected format (entries #1 map: Invalid input: expected string, received number). Refresh to try again.",
    ],
  ])("names why the running rotation could not be read: %s", async (_, reply, note) => {
    const f = betweenRotationRounds();
    const fallback = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[1] !== "/v1/rotation") return fallback(...args);
      if (reply instanceof Error) throw reply;
      return reply;
    });
    expect((await f.game.configuration()).rotation).toMatchObject({ currentIndex: null, positionNote: note });
    await expect(f.game.execute(queueNext(0))).rejects.toThrow(note);
    expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("changes only reviewed fields, validates, uses If-Match and confirms the stored values", async () => {
    const { game, saved, request } = fixture();
    const result = await game.execute(save({ serverName: "The UNCs Event", scorePeriod: 30 }));
    expect(result).toMatchObject({ state: "pending", revision: "r2", message: expect.stringContaining("next match") });
    expect(saved().text).toBe(
      original
        .replace('ServerName="The UNCs"', 'ServerName="The UNCs Event"')
        .replace("ScorePeriod=24", "ScorePeriod=30"),
    );
    expect(request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
    expect(request.mock.calls.filter(([, path]) => path === "/v1/config/validate")).toHaveLength(1);
  });
  it("does not provide an automatic restoration revision when unrelated saved text changed", async () => {
    const { game, request } = fixture();
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const result = await originalRequest(...args);
      return args[0] === "GET" && args[1] === "/v1/config" && result.revision === "r2"
        ? { ...result, text: result.text + "; another edit\r\n", revision: "r3" }
        : result;
    });
    const result = await game.execute(save({ serverName: "Event name" }));
    expect(result.state).toBe("pending");
    expect(result.revision).toBeUndefined();
  });
  it.each<Record<string, string | number | boolean>>([
    { scorePeriod: 19 },
    { scorePeriod: 31 },
    { scorePeriod: 24.5 },
    { serverName: "bad\nPassword=injected" },
    { imageUrl: "javascript:alert(1)" },
    { unknown: true },
    { minPlayerCash: 100, maxPlayerCash: 50 },
  ])("refuses invalid settings %j without a write", async (changes) => {
    const { game, request } = fixture();
    await expect(game.execute(save(changes))).rejects.toThrow();
    expect(request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("refuses stale drafts without automatic rebasing or retries", async () => {
    const { game, request } = fixture();
    await expect(game.execute(save({ scorePeriod: 25 }, "r0"))).rejects.toThrow("changed");
    expect(request.mock.calls.some(([method]) => method !== "GET")).toBe(false);
  });
  it.each(["redacted", "locked", "notAllowed"])("refuses a %s document or key", async (kind) => {
    const f = fixture();
    if (kind === "redacted") f.document.redacted = true;
    if (kind === "locked")
      f.document.sections = [{ section: SESSION, keyOverrides: [{ key: "ServerName", lockedBy: "command-line" }] }];
    if (kind === "notAllowed") f.document.sections = [{ section: SESSION, allowedKeys: ["MaxReservedSlots"] }];
    await expect(f.game.execute(save({ serverName: "New" }))).rejects.toThrow();
    expect(f.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("retains failure context without forwarding upstream strings", async () => {
    const { game, request } = fixture();
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body, revision) =>
      path === "/v1/config/validate"
        ? { ok: false, errors: [{ message: "Password=private" }] }
        : originalRequest(method, path, body, revision),
    );
    await expect(game.execute(save({ scorePeriod: 25 }))).rejects.toThrow("refused");
    expect(request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("redacts join passwords in audit storage while sending the intended value to the game", async () => {
    const f = fixture();
    const store = {
      begin: jest.fn().mockResolvedValue({ created: true }),
      finish: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(fixtureServers(f.game), store as unknown as AdminStore);
    const action = save({ serverPassword: "replacement-secret" });
    await service.act({ id: "staff", name: "Staff", role: "admin", csrf: "csrf" }, action);
    expect(JSON.stringify(store.begin.mock.calls)).not.toContain("replacement-secret");
    expect(f.saved().text).toContain('ServerPassword="replacement-secret"');
    expect(JSON.stringify(auditAction(action))).toContain("[redacted]");
  });
  it.each(["viewer", "moderator"] as const)("refuses settings reads and writes by %s", async (role) => {
    const f = fixture();
    const service = new AdminService(fixtureServers(f.game), {} as AdminStore);
    const staff = { id: "staff", name: "Staff", role, csrf: "csrf" };
    await expect(service.configuration(staff)).rejects.toThrow("administrators");
    expect(() => service.rotationCheck(staff)).toThrow("administrators");
    await expect(service.act(staff, save({ scorePeriod: 25 }))).rejects.toThrow("staff role");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("queues a supported next map without ending the current round", async () => {
    const f = fixture();
    const result = await f.game.execute({
      id: randomUUID(),
      reason: "Event next round",
      action: "map-next",
      revision: "r1",
      currentIndex: 0,
      currentMap: "Kavkazi",
      entry: { map: "Europe", experiences: ["KOTH_InfantryOnly"], lighting: "DayClear" },
    });
    expect(result.state).toBe("pending");
    expect(parseRotation(f.saved().text)[1]).toMatchObject({ map: "Europe", experiences: ["KOTH_InfantryOnly"] });
    expect(f.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
  });
  it.each([
    ["Kavkazi", "Bakurani"],
    ["Europe", "Ozeti"],
    ["NorthAmerica", "Zestafona"],
  ])("keeps a reviewed next-map choice valid when %s is reported as %s", async (id, name) => {
    const f = fixture();
    f.document.text = original.replace('Map="Kavkazi"', `Map="${id}"`);
    f.status.map = id;
    const reviewed = await f.game.configuration();
    f.status.map = name;
    const result = await f.game.execute({
      id: randomUUID(),
      reason: "Next round choice",
      action: "map-next",
      revision: reviewed.revision,
      currentIndex: reviewed.rotation.currentIndex!,
      currentMap: reviewed.rotation.currentMap,
      entry: { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"], lighting: "DayClear" },
    });
    expect(result.state).toBe("pending");
    expect(parseRotation(f.saved().text)[0].map).toBe(id);
    expect(parseRotation(f.saved().text)[1]).toEqual({
      map: "Europe",
      experiences: ["KOTH", "KOTH_InfantryOnly"],
      lighting: "DayClear",
    });
    expect(f.request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
    expect(f.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
  });
  it("preserves old unavailable rotation entries when queuing a valid Infantry Only round", async () => {
    const f = fixture();
    f.document.text = original.replace('Map="Europe",Experiences="KOTH"', 'Map="Europe",Experiences="RemovedMode"');
    await f.game.execute({
      id: randomUUID(),
      reason: "Next round choice",
      action: "map-next",
      revision: "r1",
      currentIndex: 0,
      currentMap: "Kavkazi",
      entry: { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"], lighting: "DayClear" },
    });
    expect(parseRotation(f.saved().text)).toEqual([
      { map: "Kavkazi", experiences: ["KOTH"], lighting: "DayClear" },
      { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"], lighting: "DayClear" },
      { map: "Europe", experiences: ["RemovedMode"], lighting: "DayClear" },
    ]);
    expect(f.request.mock.calls.some(([method, path]) => method === "POST" && path === "/v1/config/validate")).toBe(
      true,
    );
    expect(f.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
  });
  const kavkazi = { map: "Kavkazi", experiences: ["KOTH"], lighting: "DayClear" };
  const europe = { map: "Europe", experiences: ["KOTH"], lighting: "DayClear" };
  const europeInfantry = { map: "Europe", experiences: ["KOTH", "KOTH_InfantryOnly"], lighting: "DayClear" };
  const kavkaziInfantry = { map: "Kavkazi", experiences: ["KOTH", "KOTH_InfantryOnly"], lighting: "DayClear" };
  function withRotation(f: ReturnType<typeof fixture>, entries: MapSelection[], running: number) {
    // "." keeps duplicate rows; "+" would add each distinct entry only once.
    const rows = entries.map((entry) => `.RotationEntries=${formatRotation(entry)}`).join("\r\n");
    f.document.text = original.replace(
      /\+RotationEntries=\(Map="Kavkazi"[^\r]*\r\n\+RotationEntries=\(Map="Europe"[^\r]*/,
      rows,
    );
    f.status.map = entries[running].map;
    f.status.rotation = { nowIndex: running } as never;
    return (entry: MapSelection) =>
      f.game.execute({
        id: randomUUID(),
        reason: "Next round choice",
        action: "map-next",
        revision: "r1",
        currentIndex: running,
        currentMap: entries[running].map,
        entry,
      });
  }
  it("returns to the first entry after the last one only when the game reports it", async () => {
    // Europe runs last and Kavkazi wins. With nextIndex 0 the game already plays Kavkazi next.
    const wrap = fixture();
    const queueWrap = withRotation(wrap, [kavkazi, europe], 1);
    wrap.status.rotation = { nowIndex: 1, nextIndex: 0 } as never;
    expect(await queueWrap(kavkazi)).toMatchObject({ state: "applied", changed: false });
    expect(wrap.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
    // Without that confirmation, the old append is kept: the rotation grows by one entry.
    const unconfirmed = fixture();
    await withRotation(unconfirmed, [kavkazi, europe], 1)(kavkazi);
    expect(parseRotation(unconfirmed.saved().text).map((entry) => entry.map)).toEqual(["Kavkazi", "Europe", "Kavkazi"]);
    expect(parseRotation(unconfirmed.saved().text)[1].map).toBe("Europe");
    expect(unconfirmed.request.mock.calls.some(([, path]) => path.startsWith("/v1/match"))).toBe(false);
  });
  it("swaps an earlier copy into the next slot without growing the rotation or moving the running entry", async () => {
    const f = fixture();
    const queue = withRotation(f, [kavkazi, europe, europeInfantry], 1);
    expect(await queue(kavkazi)).toMatchObject({ state: "pending" });
    const saved = parseRotation(f.saved().text);
    expect(saved).toEqual([europeInfantry, europe, kavkazi]);
    expect(saved[1].map).toBe(f.status.map);
    expect(f.request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
  });
  it("still moves a later copy up and inserts a new entry after the running one", async () => {
    const moved = fixture();
    await withRotation(moved, [kavkazi, europe, europeInfantry, kavkaziInfantry], 0)(kavkaziInfantry);
    expect(parseRotation(moved.saved().text)).toEqual([kavkazi, kavkaziInfantry, europe, europeInfantry]);
    const inserted = fixture();
    await withRotation(inserted, [kavkazi, europe, europeInfantry], 0)(kavkaziInfantry);
    expect(parseRotation(inserted.saved().text)).toEqual([kavkazi, kavkaziInfantry, europe, europeInfantry]);
  });
  it("refuses a 101st entry cleanly, before any write", async () => {
    const f = fixture();
    const queue = withRotation(
      f,
      Array.from({ length: 100 }, (_, index) => (index % 2 ? europe : kavkazi)),
      0,
    );
    const error = await queue(kavkaziInfantry).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RconError);
    expect((error as RconError).message).toContain("100 entries or fewer");
    expect((error as RconError).unknownResult).toBeFalsy();
    expect(f.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  describe("next-round placement", () => {
    const a = { map: "Kavkazi", experiences: ["KOTH"] },
      b = { map: "Europe", experiences: ["KOTH"] },
      c = { map: "NorthAmerica", experiences: ["KOTH"] },
      d = { map: "Europe", experiences: ["KOTH_Hardcore"] };
    it.each([
      ["already next", [a, b, c], 0, null, b, "already-next", [a, b, c], 1],
      ["later copy", [a, b, c], 0, null, c, "move", [a, c, b], 1],
      ["earlier copy", [a, b, c], 1, null, a, "swap", [c, b, a], 2],
      ["new entry", [a, b, c], 1, null, d, "insert", [a, b, d, c], 2],
      ["wrap confirmed, first already next", [a, b, c], 2, 0, a, "already-next", [a, b, c], 0],
      ["wrap confirmed, earlier copy", [a, b, c], 2, 0, b, "swap", [b, a, c], 0],
      ["wrap confirmed, new entry", [a, b, c], 2, 0, d, "append", [a, b, c, d], 3],
      ["wrap unconfirmed", [a, b, c], 2, null, a, "append", [a, b, c, a], 3],
      ["single entry replays", [a], 0, 0, a, "already-next", [a], 0],
      ["running entry itself", [a, b, c], 1, null, b, "insert", [a, b, b, c], 2],
    ] as const)("%s", (_, entries, current, next, entry, placement, expected, slot) => {
      const plan = planMapNext([...entries], current, next, entry);
      expect(plan).toMatchObject({ placement, slot });
      expect(plan.entries).toEqual(expected);
      expect(plan.entries[current]).toBe(entries[current]);
    });
  });
  it.each(["round", "random", "disabled", "unknown-mode"])("refuses unsafe next-map selection: %s", async (kind) => {
    const f = fixture();
    if (kind === "round") f.status.map = "Europe";
    if (kind === "random") f.document.text = original.replace("RotationMode=Ordered", "RotationMode=Random");
    if (kind === "disabled") f.document.text = original.replace("bEnabled=True", "bEnabled=False");
    await expect(
      f.game.execute({
        id: randomUUID(),
        reason: "Event next round",
        action: "map-next",
        revision: "r1",
        currentIndex: 0,
        currentMap: "Kavkazi",
        entry: { map: "Europe", experiences: [kind === "unknown-mode" ? "Invented50v50" : "KOTH"] },
      }),
    ).rejects.toThrow();
    expect(f.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("does not discard unknown rotation fields during editing", async () => {
    const f = fixture();
    f.document.text = original.replace('Map="Europe"', 'Unrecognized="keep-me",Map="Europe"');
    await expect(
      f.game.execute({
        id: randomUUID(),
        reason: "Review rotation",
        action: "rotation-save",
        revision: "r1",
        entries: [{ map: "Europe", experiences: [] }],
      }),
    ).rejects.toThrow("unsupported");
    expect(f.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
});
