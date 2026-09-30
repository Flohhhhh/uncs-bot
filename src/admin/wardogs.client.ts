import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AdminSettings } from "./admin.settings";
import {
  bansSchema,
  capabilitiesSchema,
  configDocumentSchema,
  playersSchema,
  reservedSchema,
  statusSchema,
  type ActionResult,
  type AdminAction,
  type Capabilities,
  type ConfigDocument,
} from "./admin.types";
import { configuredWhitelist, editWhitelist } from "./whitelist-document";

export class RconError extends Error {
  constructor(
    message: string,
    readonly unknownResult = false,
  ) {
    super(message);
  }
}
export function serves(capabilities: Capabilities, method: string, path: string) {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/\{[^}]*\}|:[^/\s]+/g, "*")
      .replace(/\s+/g, " ");
  return capabilities.routes.some((route) => normalize(route) === normalize(`${method} ${path}`));
}
const catalogItem = z.object({ id: z.string(), displayName: z.string().optional() });
const hasProblems = (value: unknown) => value === true || (Array.isArray(value) && value.length > 0);
const rejected = (result: any) =>
  !result ||
  typeof result !== "object" ||
  result.ok === false ||
  !!result.error ||
  hasProblems(result.errors) ||
  hasProblems(result.conflict) ||
  hasProblems(result.stripped);
// These are the exact palette/code pairs used by the current official RCON
// client. Status exposes faction names, while player rows expose these codes.
// Names are always read from the current status rather than assumed from a map.
const factionCodesByColor: Record<string, string> = {
  "#d86060": "RED",
  "#5b95d8": "BLU",
  "#7bc462": "GRN",
};
type CurrentFaction = z.infer<typeof statusSchema>["factionScores"][number];
const teamPlayersSchema = z.object({
  players: z.array(z.object({ steamId: z.string().nullable().optional(), faction: z.string().nullable().optional() })),
});
function assignedTo(faction: string | null | undefined, target: CurrentFaction, factions: CurrentFaction[]) {
  if (!faction) return false;
  if (!["RED", "BLU", "GRN"].includes(faction)) return faction === target.name;
  const sameCode = factions.filter(
    (entry) => factionCodesByColor[entry.colorHex?.trim().toLowerCase() ?? ""] === faction,
  );
  return sameCode.length === 1 && sameCode[0].name === target.name;
}

@Injectable()
export class WardogsClient {
  private capabilitiesCache?: { until: number; value: Capabilities };
  private holdUntil = 0;
  constructor(private readonly settings: AdminSettings) {}

  async request(method: string, path: string, body?: unknown, revision?: string): Promise<any> {
    if (Date.now() < this.holdUntil) throw new RconError("The game requested a short pause. Wait before trying again.");
    const config = this.settings.get();
    const mutates = method !== "GET" && !(method === "POST" && path === "/v1/config/validate");
    let response: Response;
    try {
      response = await fetch(`${config.rconUrl.replace(/\/$/, "")}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: {
          Authorization: `Bearer ${config.password}`,
          "Content-Type": typeof body === "string" ? "text/plain" : "application/json",
          ...(revision ? { "If-Match": `"${revision.replace(/^"|"$/g, "")}"` } : {}),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    } catch {
      this.capabilitiesCache = undefined;
      throw new RconError(
        !mutates
          ? "The game server could not be reached."
          : "The connection ended before confirmation. Check the server before repeating this action.",
        mutates,
      );
    }
    if (!response.ok) {
      // Translate only known codes. Never forward upstream text, which can
      // include credentials, configuration internals or untrusted player input.
      const error = await response.json().catch(() => null);
      const errorCode = typeof error?.error?.code === "string" ? error.error.code : "";
      if (response.status === 429) {
        const retry = response.headers.get("retry-after") ?? "5";
        const seconds = Number(retry);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        this.holdUntil = Date.now() + Math.max(1000, Math.min(300_000, Number.isFinite(delay) ? delay : 5000));
      }
      const messages: Record<number, string> = {
        400: "The game rejected this action. Check the player, message length and selected options.",
        401: "The RCON connection credentials were rejected.",
        403: "The game refused access to this action.",
        404: "The player, entry or action is unavailable on the current server. Refresh before trying again.",
        409: "This action conflicts with the current server state. Refresh and review it.",
        412: "Another administrator changed the configuration. Refresh and review your change again.",
        429: "The game requested a short pause. Wait before trying again.",
      };
      const codedMessages: Record<string, string> = {
        player_not_found:
          "The game could not find that connected player. This build may require the player to be online, including for bans.",
        ban_not_found: "That player is not in the running ban list. Refresh before trying again.",
        message_too_long: "The game rejected the message length. Shorten it before sending again.",
        already_reserved: "That SteamID is already whitelisted. Refresh the list.",
        reserved_not_found: "That SteamID is not in the running whitelist. Refresh the list.",
      };
      throw new RconError(
        codedMessages[errorCode] ??
          messages[response.status] ??
          "The game returned an error. Check its state before repeating the action.",
        mutates && response.status >= 500,
      );
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw new RconError(
        "The game returned an unreadable response. Check its state before repeating the action.",
        mutates,
      );
    }
  }

  async capabilities() {
    if (this.capabilitiesCache && this.capabilitiesCache.until > Date.now()) return this.capabilitiesCache.value;
    const value = capabilitiesSchema.parse(await this.request("GET", "/v1/capabilities"));
    this.capabilitiesCache = { value, until: Date.now() + 60_000 };
    return value;
  }

  async overview() {
    const capabilities = await this.capabilities();
    const [status, players] = await Promise.all([
      this.request("GET", "/v1/status").then((data) => statusSchema.parse(data)),
      this.request("GET", "/v1/players").then((data) => playersSchema.parse(data).players),
    ]);
    return { status, players, capabilities, observedAt: new Date().toISOString() };
  }

  async bans() {
    return bansSchema.parse(await this.request("GET", "/v1/bans")).bans;
  }

  async document(): Promise<ConfigDocument> {
    const parsed = configDocumentSchema.safeParse(await this.request("GET", "/v1/config"));
    if (!parsed.success) {
      throw new RconError("This game build does not expose an editable configuration document.");
    }
    return parsed.data;
  }

  async whitelist() {
    const live = reservedSchema.parse(await this.request("GET", "/v1/reserved-slots")).reservedSlots;
    let configured: string[] | null = null;
    try {
      configured = configuredWhitelist((await this.document()).text);
    } catch {
      /* Live list remains useful when document access is unavailable. */
    }
    const ids = [...new Set([...live, ...(configured ?? [])])].sort();
    const entries = ids.map((id) => ({
      steamId: id,
      active: live.includes(id),
      configured: configured === null ? null : configured.includes(id),
    }));
    return { entries, configurationAvailable: configured !== null };
  }

  async catalog() {
    const capabilities = await this.capabilities();
    const read = async (path: string, field: string) =>
      serves(capabilities, "GET", path) ? z.array(catalogItem).parse((await this.request("GET", path))[field]) : [];
    const [maps, lightings, experiences] = await Promise.all([
      read("/v1/catalog/maps", "maps"),
      read("/v1/catalog/lightings", "lightings"),
      read("/v1/catalog/experiences", "experiences"),
    ]);
    return { maps, lightings, experiences };
  }

  async rotation() {
    return z
      .object({
        enabled: z.boolean(),
        mode: z.string(),
        entries: z.array(
          z.object({
            index: z.number(),
            map: z.string(),
            experiences: z.array(z.string()).optional(),
            lighting: z.string().optional(),
            status: z.string().nullable().optional(),
            denied: z.boolean().optional(),
          }),
        ),
      })
      .parse(await this.request("GET", "/v1/rotation"));
  }

  private async whitelistAction(
    action: Extract<AdminAction, { action: "whitelist-add" | "whitelist-remove" }>,
    capabilities: Capabilities,
  ): Promise<ActionResult> {
    const add = action.action === "whitelist-add";
    const method = add ? "POST" : "DELETE";
    const path = add ? "/v1/reserved-slots" : `/v1/reserved-slots/${action.steamId}`;
    if (serves(capabilities, method, add ? path : "/v1/reserved-slots/{id}")) {
      const result = await this.request(method, path, add ? { steamId: action.steamId } : undefined);
      if (rejected(result)) throw new RconError("The game did not accept the whitelist change.");
    } else {
      if (!serves(capabilities, "PUT", "/v1/config"))
        throw new RconError("This build does not expose whitelist editing.");
      if (capabilities.config?.writable === false)
        throw new RconError("The game reports that its configuration is read-only.");
      const doc = await this.document();
      let text: string;
      try {
        text = editWhitelist(doc, action.steamId, add);
      } catch (error) {
        throw new RconError((error as Error).message);
      }
      if (text !== doc.text) {
        if (capabilities.limits?.maxBodyBytes && Buffer.byteLength(text, "utf8") > capabilities.limits.maxBodyBytes)
          throw new RconError("The updated configuration exceeds the game server's request limit. No change was sent.");
        if (serves(capabilities, "POST", "/v1/config/validate")) {
          const validation = await this.request("POST", "/v1/config/validate", text);
          if (rejected(validation))
            throw new RconError("The game could not validate a safe whitelist edit. No change was sent.");
        }
        const result = await this.request("PUT", "/v1/config", text, doc.revision);
        if (rejected(result)) {
          throw new RconError(
            "The game did not fully accept the whitelist change. Refresh and review the running and configured lists.",
            true,
          );
        }
      }
    }
    try {
      const live = reservedSchema.parse(await this.request("GET", "/v1/reserved-slots")).reservedSlots;
      return live.includes(action.steamId) === add
        ? {
            state: "applied",
            message: add
              ? "Whitelist access is active in the running game."
              : "Whitelist access is removed from the running game.",
          }
        : {
            state: "pending",
            message:
              "Saved, but the running whitelist has not changed yet. It may apply at the next server restart; refresh to verify.",
          };
    } catch {
      return {
        state: "unknown",
        message:
          "The change was submitted, but the running whitelist could not be verified. Refresh before making another change.",
      };
    }
  }

  private async teamAction(
    action: Extract<AdminAction, { action: "team" }>,
    capabilities: Capabilities,
  ): Promise<ActionResult> {
    if (!serves(capabilities, "PATCH", "/v1/players/{id}"))
      throw new RconError("The current game build does not expose team changes.");
    const readTeams = async () => {
      const [status, data] = await Promise.all([
        this.request("GET", "/v1/status").then((value) => statusSchema.parse(value)),
        this.request("GET", "/v1/players").then((value) => teamPlayersSchema.parse(value)),
      ]);
      return {
        factions: status.factionScores,
        players: data.players.filter((player) => player.steamId === action.steamId),
      };
    };
    let before: Awaited<ReturnType<typeof readTeams>>;
    try {
      before = await readTeams();
    } catch (error) {
      if (error instanceof RconError) throw error;
      throw new RconError("The current player and team lists could not be read safely. No move was sent.");
    }
    const targets = before.factions.filter((team) => team.name === action.faction);
    if (targets.length !== 1)
      throw new RconError("Choose one faction currently reported by the game. Refresh the teams.");
    if (before.players.length === 0)
      throw new RconError("The selected player is no longer connected. Refresh the player list.");
    if (before.players.length !== 1)
      throw new RconError("The game returned an ambiguous player identity. Refresh before moving anyone.");
    if (assignedTo(before.players[0].faction, targets[0], before.factions))
      return { state: "applied", message: `The player is already assigned to ${action.faction}. No move was sent.` };

    const result = await this.request("PATCH", `/v1/players/${action.steamId}`, { faction: targets[0].name });
    if (rejected(result)) throw new RconError("The game did not accept the team change.");
    try {
      const after = await readTeams();
      const currentTargets = after.factions.filter((team) => team.name === action.faction);
      if (after.players.length !== 1 || currentTargets.length !== 1)
        return {
          state: "unknown",
          message:
            "The move was accepted, but the player or team is no longer available to confirm it. Refresh before another move.",
        };
      if (assignedTo(after.players[0].faction, currentTargets[0], after.factions))
        return {
          state: "applied",
          message: `Faction assignment confirmed for ${action.faction}. The player may still need to respawn; no forced kill was sent.`,
        };
      return {
        state: "pending",
        message: `The move was accepted, but the player list does not yet show ${action.faction}. The player may need to respawn. Refresh before another move.`,
      };
    } catch {
      return {
        state: "unknown",
        message: "The move was accepted, but its faction assignment could not be checked. Refresh before another move.",
      };
    }
  }

  async execute(action: AdminAction): Promise<ActionResult> {
    const capabilities = await this.capabilities();
    if (action.action === "whitelist-add" || action.action === "whitelist-remove")
      return this.whitelistAction(action, capabilities);
    if (action.action === "team") return this.teamAction(action, capabilities);
    let method = "POST",
      path: string,
      route: string,
      body: unknown;
    switch (action.action) {
      case "kick":
      case "kill":
      case "message":
        route = `/v1/players/{id}/${action.action}`;
        path = `/v1/players/${action.steamId}/${action.action}`;
        body =
          action.action === "kick"
            ? { reason: action.reason }
            : action.action === "message"
              ? { message: action.message }
              : undefined;
        break;
      case "ban":
        route = path = "/v1/bans";
        body = { steamId: action.steamId, reason: action.reason };
        break;
      case "unban":
        method = "DELETE";
        route = "/v1/bans/{id}";
        path = `/v1/bans/${action.steamId}`;
        break;
      case "broadcast":
        route = path = "/v1/broadcast";
        body = { message: action.message };
        break;
      case "match-end":
        route = path = "/v1/match/end";
        break;
      case "match-restart":
        route = path = "/v1/match/restart";
        break;
      case "map":
        route = path = "/v1/match/map";
        body = {
          map: action.map,
          ...(action.experiences?.length ? { experiences: action.experiences } : {}),
          ...(action.lighting ? { lighting: action.lighting } : {}),
          ...(action.zoneAlternator && action.zoneAlternator !== "None"
            ? { zoneAlternator: action.zoneAlternator }
            : {}),
        };
        break;
      case "lighting":
        method = "PUT";
        route = path = "/v1/world/lighting";
        body = { lighting: action.lighting };
        break;
    }
    if (!serves(capabilities, method, route))
      throw new RconError("The current game build does not expose this action.");
    if (action.action === "map" || action.action === "lighting") {
      const catalog = await this.catalog();
      if (
        ("map" in action && !catalog.maps.some((item) => item.id === action.map)) ||
        (action.lighting && !catalog.lightings.some((item) => item.id === action.lighting))
      )
        throw new RconError("Choose a map or lighting option from the current server catalog.");
      if (
        action.action === "map" &&
        action.experiences?.some((id) => !catalog.experiences.some((item) => item.id === id))
      )
        throw new RconError("The selected experience is not available on this server.");
      if (action.action === "map" && action.experiences?.length) {
        if (serves(capabilities, "GET", "/v1/catalog/maps/{map}/experiences")) {
          const available = z
            .object({ experiences: z.array(z.string()) })
            .parse(await this.request("GET", `/v1/catalog/maps/${encodeURIComponent(action.map)}/experiences`));
          if (action.experiences.some((id) => !available.experiences.includes(id)))
            throw new RconError("The selected experience is not available for this map.");
        }
      }
      if (action.action === "map" && action.zoneAlternator && action.zoneAlternator !== "None") {
        if (!serves(capabilities, "GET", "/v1/catalog/maps/{map}/alternators"))
          throw new RconError("This server cannot verify the selected zone layout. Leave it unset.");
        const available = z
          .object({ alternators: z.array(z.object({ tag: z.string() })) })
          .parse(await this.request("GET", `/v1/catalog/maps/${encodeURIComponent(action.map)}/alternators`));
        if (!available.alternators.some((item) => item.tag === action.zoneAlternator))
          throw new RconError("The selected zone layout is not available for this map.");
      }
    }
    const result = await this.request(method, path, body);
    if (rejected(result)) throw new RconError("The game did not accept this action.");
    if (action.action === "ban" || action.action === "unban") {
      try {
        const present = (await this.bans()).some((ban) => ban.steamId === action.steamId);
        if (present === (action.action === "ban"))
          return {
            state: "applied",
            message:
              action.action === "ban"
                ? "Ban confirmed in the running game."
                : "Ban removal confirmed in the running game.",
          };
        return {
          state: "pending",
          message: "The game accepted the request but its ban list has not confirmed the change yet.",
        };
      } catch {
        return {
          state: "unknown",
          message: "The request was accepted, but the ban list could not be checked. Refresh before repeating it.",
        };
      }
    }
    return {
      state: result.pending ? "pending" : "accepted",
      message:
        action.action === "match-restart"
          ? "Match restart accepted. This reloads the match; it does not restart the server process."
          : action.action === "map"
            ? "Map change accepted. The game may finish its end-of-match screen before travelling."
            : "The game accepted the action.",
    };
  }
}
