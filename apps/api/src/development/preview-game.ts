/** Shared in-memory game fixtures for isolated preview and the local backend sample adapter. */
import { WardogsClient } from "../admin/wardogs.client";
import { configuredWhitelist } from "../admin/whitelist-document";
import { settingFields, SESSION, ROTATION } from "../common/server-settings";
import { scalarValue } from "../admin/config-document";
import { parseRotation } from "../admin/server-configuration";
import { mapLabel } from "../common/map-labels";

export const sampleServerDefinitions = [
  { id: "primary", name: "UNCs Primary (sample)", rconUrl: "https://primary.example.test", password: "sample-only" },
  { id: "event", name: "UNCs Events (sample)", rconUrl: "https://event.example.test", password: "sample-only" },
];

type SamplePlayer = {
  name: string;
  steamId: string;
  faction: string;
  kills: number;
  deaths: number;
  cash: number;
  pingMs: number;
};

export function createPreviewGame(
  name: string,
  reportsClock: boolean,
  options: { mode?: string; clock?: boolean; readOnly?: boolean } = {},
): { game: WardogsClient; players: SamplePlayer[] } {
  const previewMode = options.mode ?? "live";
  const previewClock = options.clock ?? true;
  let previewRoundStart = Date.now() - 600_000;
  const clock = reportsClock && previewClock && previewMode !== "pre-round";

  const players = [
    { name: "UncDap", steamId: "76561198066952872", faction: "RED", kills: 18, deaths: 7, cash: 14300, pingMs: 32 },
    {
      name: "MossyBoots",
      steamId: "76561198123456789",
      faction: "RED",
      kills: 11,
      deaths: 6,
      cash: 8700,
      pingMs: 47,
    },
    {
      name: "[UNC] OldManRiver",
      steamId: "76561198123456780",
      faction: "BLU",
      kills: 16,
      deaths: 9,
      cash: 12200,
      pingMs: 61,
    },
    {
      name: "TeaAndTanks",
      steamId: "76561198123456781",
      faction: "GRN",
      kills: 8,
      deaths: 4,
      cash: 7800,
      pingMs: 39,
    },
    {
      name: "NightShift",
      steamId: "76561198123456782",
      faction: "BLU",
      kills: 14,
      deaths: 8,
      cash: 10500,
      pingMs: 52,
    },
    {
      name: "RustyCompass",
      steamId: "76561198123456783",
      faction: "GRN",
      kills: 6,
      deaths: 5,
      cash: 6200,
      pingMs: 44,
    },
  ];
  // The read-only backend waiting scenario has a matching one-player roster.
  // Keep the isolated preview roster unchanged for its multi-player event demonstrations.
  if (options.readOnly && previewMode === "pre-round") players.splice(1);
  if (previewMode === "full-server")
    // A full server: 34/33/33 across the three teams, every identity linked and unique.
    players.push(
      ...Array.from({ length: 100 - players.length }, (_, index) => ({
        name: `Preview player ${index + 1}`,
        steamId: String(76561198100000000n + BigInt(index)),
        faction: ["RED", "BLU", "GRN"][(index + players.length) % 3],
        kills: 0,
        deaths: 0,
        cash: 1000,
        pingMs: 40,
      })),
    );
  const factions = [
    { code: "RED", name: "Valkyra", colorHex: "#D86060", score: 82 },
    { code: "BLU", name: "Lonestar", colorHex: "#5B95D8", score: 64 },
    { code: "GRN", name: "Manticore", colorHex: "#7BC462", score: 47 },
  ];
  const bans: { steamId: string; reason: string; bannedBy: string; bannedAtUtc: string }[] = [
    {
      steamId: "76561198123456000",
      reason: "Repeated team disruption (sample)",
      bannedBy: "Demo staff",
      bannedAtUtc: new Date().toISOString(),
    },
  ];
  const sampleSettings: Record<string, string | number | boolean> = {
    serverName: name,
    imageUrl: "",
    serverPassword: "",
    maxPlayers: 100,
    maxReservedSlots: 0,
    minPlayerCash: 0,
    maxPlayerCash: 0,
    minPlayerLevel: 0,
    maxPlayerLevel: 0,
    minRequiredPlayers: 60,
    scorePeriod: 24,
    lockOverpopulated: true,
    overpopThreshold: 2,
    rotationEnabled: true,
    rotationMode: "Ordered",
  };
  let text =
    [...new Set(settingFields.map((field) => field.section))]
      .map((section) => {
        const values = settingFields
          .filter((field) => field.section === section)
          .map((field) => `${field.key}=${sampleSettings[field.id]}`);
        if (section === SESSION)
          values.push(...players.slice(0, 3).map((player) => `+DefaultReservedPlayerIds=${player.steamId}`));
        if (section === ROTATION)
          values.push(
            ...["Kavkazi", "Europe", "NorthAmerica"].map(
              (map) => `+RotationEntries=(Map="${map}",Experiences="",Lighting="DayClear")`,
            ),
          );
        return `[${section}]\n${values.join("\n")}\n`;
      })
      .join("\n") + "[WDServerFeed]\nUrl=http://127.0.0.1:32190\n";
  let revision = 1,
    currentMap = "Kavkazi",
    lighting = "DayClear";
  const routes = [
    "GET /v1/status",
    "GET /v1/players",
    "GET /v1/bans",
    "GET /v1/audit",
    "GET /v1/server-id",
    "GET /v1/sponsor",
    "GET /v1/reserved-slots",
    "GET /v1/config",
    "PUT /v1/config",
    "POST /v1/config/validate",
    "POST /v1/bans",
    "DELETE /v1/bans/{id}",
    "POST /v1/players/{id}/kick",
    "POST /v1/players/{id}/kill",
    "POST /v1/players/{id}/message",
    "PATCH /v1/players/{id}",
    "POST /v1/broadcast",
    "POST /v1/match/end",
    "POST /v1/match/restart",
    "POST /v1/match/map",
    "PUT /v1/world/lighting",
    "GET /v1/catalog/maps",
    "GET /v1/catalog/lightings",
    "GET /v1/catalog/experiences",
    "GET /v1/catalog/maps/{map}/experiences",
    "GET /v1/catalog/maps/{map}/alternators",
    "GET /v1/rotation",
  ];
  class PreviewGame extends WardogsClient {
    override async request(method: string, path: string, body?: any, expectedRevision?: string) {
      if (options.readOnly && !["GET", "HEAD"].includes(method)) throw new Error("Sample game data is read-only.");
      if (path === "/v1/capabilities")
        return {
          routes: options.readOnly ? routes.filter((route) => route.startsWith("GET ")) : routes,
          build: "LOCAL PREVIEW · SAMPLE DATA",
          config: { writable: !options.readOnly },
        };
      if (path === "/v1/status")
        return {
          serverName: scalarValue(text, SESSION, "ServerName") || "Local preview",
          map: mapLabel(currentMap),
          ...(clock ? { matchSeconds: (Date.now() - previewRoundStart) / 1000 } : {}),
          lighting,
          alternator: currentMap === "Kavkazi" ? "ZoneAlternator.Bakurani.Farmland.Circle" : "None",
          experiences: ["KOTH"],
          scoreTick: { current: 24, min: 18, max: 30 },
          ...(reportsClock ? { rotation: { nowIndex: 0, nextIndex: 1 } } : {}),
          players: {
            current: previewMode === "pre-round" ? 1 : previewMode === "full-server" ? 100 : players.length,
            max: 100,
          },
          scoreCap: 100,
          factionScores: factions.map(({ name, colorHex, score }, index) => ({
            name,
            colorHex,
            score:
              previewMode === "pre-round"
                ? 0
                : previewMode === "full-server"
                  ? Math.min(99, Math.floor(((Date.now() - previewRoundStart) / 18_000) * (1 - index * 0.2)))
                  : score,
          })),
        };
      if (path === "/v1/players") return { players };
      if (path === "/v1/server-id") return { serverId: `preview-${name}` };
      if (path === "/v1/sponsor") return { imageUrl: "https://example.com/preview-banner.png" };
      if (path === "/v1/audit?limit=100")
        return {
          entries: [
            { timestampUtc: new Date().toISOString(), event: "HTTP", detail: "POST /v1/broadcast -> 200" },
            { timestampUtc: new Date().toISOString(), event: "HTTP", detail: "GET /v1/players -> 200" },
            { timestampUtc: new Date().toISOString(), event: "AUTH_OK", detail: null },
          ],
        };
      if (path === "/v1/reserved-slots") return { reservedSlots: configuredWhitelist(text) };
      if (path === "/v1/config/validate") return { ok: true };
      if (path === "/v1/config") {
        if (method === "GET")
          return {
            text,
            revision: String(revision),
            writable: !options.readOnly,
            sections: [...new Set(settingFields.map((field) => field.section))].map((section) => ({
              section,
              appliesWhen: section === "MatchState.Playing.KOTH" ? "next-match" : "live",
            })),
          };
        if (expectedRevision !== String(revision)) throw new Error("Preview revision conflict");
        text = body;
        revision++;
        return { ok: true };
      }
      if (path === "/v1/bans") {
        if (method === "GET") return { bans };
        bans.push({
          steamId: body.steamId,
          reason: body.reason,
          bannedBy: "Preview staff",
          bannedAtUtc: new Date().toISOString(),
        });
        const index = players.findIndex((p) => p.steamId === body.steamId);
        if (index >= 0) players.splice(index, 1);
        return { ok: true };
      }
      if (path.startsWith("/v1/bans/")) {
        const index = bans.findIndex((b) => b.steamId === path.split("/").pop());
        if (index >= 0) bans.splice(index, 1);
        return { ok: true };
      }
      if (path === "/v1/catalog/maps")
        return { maps: ["Kavkazi", "Europe", "NorthAmerica"].map((id) => ({ id, displayName: id })) };
      if (path === "/v1/catalog/lightings")
        return { lightings: ["DayClear", "DayEarlyFog", "DayLateClear"].map((id) => ({ id })) };
      if (path === "/v1/catalog/experiences")
        return {
          experiences: [
            "Bakurani_KOTH_01",
            "Madrid_KOTH_01",
            "Detroit_KOTH_01",
            "KOTH_InfantryOnly",
            "KOTH_Hardcore",
          ].map((id) => ({ id })),
        };
      const mapOptions = /^\/v1\/catalog\/maps\/(Kavkazi|Europe|NorthAmerica)\/(experiences|alternators)$/.exec(path);
      if (mapOptions) {
        const maps: Record<string, { base: string; town: string; zones: string[] }> = {
          Kavkazi: { base: "Bakurani", town: "Bakurani", zones: ["Default", "Farmland", "Lumberyard"] },
          Europe: { base: "Madrid", town: "Ozeti", zones: ["Default", "Farmland", "Church", "River"] },
          NorthAmerica: {
            base: "Detroit",
            town: "Zestafona",
            zones: ["Default", "SmallFactory", "WaterTreatment", "Houses"],
          },
        };
        const map = maps[mapOptions[1]];
        return mapOptions[2] === "experiences"
          ? { experiences: [map.base + "_KOTH_01", "KOTH_InfantryOnly", "KOTH_Hardcore"] }
          : { alternators: map.zones.map((zone) => ({ tag: `ZoneAlternator.${map.town}.${zone}.Circle` })) };
      }
      if (path === "/v1/rotation")
        return {
          enabled: scalarValue(text, ROTATION, "bEnabled")?.toLowerCase() === "true",
          mode: scalarValue(text, ROTATION, "RotationMode") || "Ordered",
          entries: parseRotation(text).map((entry, index) => ({
            ...entry,
            index,
            lighting: entry.lighting || "DayClear",
            status: index === 0 ? "now" : index === 1 ? "next" : null,
          })),
        };
      if (path === "/v1/match/map") currentMap = body.map;
      if (path === "/v1/match/map" || path === "/v1/match/restart") previewRoundStart = Date.now();
      if (path === "/v1/world/lighting") lighting = body.lighting;
      const playerMatch = path.match(/^\/v1\/players\/(\d+)(?:\/(\w+))?$/);
      if (playerMatch) {
        const index = players.findIndex((p) => p.steamId === playerMatch[1]);
        if (index >= 0 && playerMatch[2] === "kick") players.splice(index, 1);
        if (index >= 0 && method === "PATCH") {
          const faction = factions.find((entry) => entry.name === body.faction);
          if (!faction) throw new Error("Unknown preview faction");
          players[index].faction = faction.code;
        }
      }
      if (options.readOnly) throw new Error("Unknown sample game resource.");
      return { ok: true };
    }
  }
  return {
    game: new PreviewGame({
      rcon: () => {
        throw new Error("No network transport exists in this preview.");
      },
    }),
    players,
  };
}
