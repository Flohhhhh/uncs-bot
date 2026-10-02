import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import { AdminSettings } from "./admin.settings";
import {
  bansSchema,
  capabilitiesSchema,
  configDocumentSchema,
  playersSchema,
  steamId,
  statusSchema,
  type ActionResult,
  type AdminAction,
  type Capabilities,
  type ConfigDocument,
} from "./admin.types";
import { editWhitelist, inspectConfiguredWhitelist } from "./whitelist-document";
import {
  readServerConfiguration,
  changeServerConfiguration,
  validateMapSelection,
  checkSavedRotation,
} from "./server-configuration";
import { serves } from "../common/admin-policy";
import { assignedFaction } from "../common/faction-colors";
import { roundStamp, sameRound, type RoundStamp } from "../common/game-round";
import { RconError, rejected } from "./rcon-protocol";
import { GAME_LOG_LIMIT, parseGameLog, type GameLog } from "./game-log";
import type { RconConnectionSource } from "../common/game-server";
import type { IdentityValue, ServerIdentity } from "../common/server-identity";
import { ServerActivity } from "./server-activity";
export { RconError } from "./rcon-protocol";
export { serves } from "../common/admin-policy";

const catalogItem = z.object({ id: z.string(), displayName: z.string().optional() });
export type Overview = {
  status: z.infer<typeof statusSchema>;
  players: z.infer<typeof playersSchema>["players"];
  unlinkedPlayerCount?: number;
  capabilities: Capabilities;
  observedAt: string;
};
const teamPlayersSchema = z.object({
  players: z.array(z.object({ steamId: z.string().nullable().optional(), faction: z.string().nullable().optional() })),
});

@Injectable()
export class WardogsClient {
  private readonly observations = new ServerActivity();
  private capabilitiesCache?: { until: number; value: Capabilities };
  private overviewCache?: { until: number; promise: Promise<Overview> };
  private holdUntil = 0;
  constructor(private readonly settings: RconConnectionSource) {}

  async request(method: string, path: string, body?: unknown, revision?: string): Promise<any> {
    if (Date.now() < this.holdUntil) throw new RconError("The game requested a short pause. Wait before trying again.");
    let config: ReturnType<AdminSettings["rcon"]>;
    try {
      config = this.settings.rcon();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw new RconError(error.message);
      throw error;
    }
    const mutates = method !== "GET" && !(method === "POST" && path === "/v1/config/validate");
    if (mutates) this.overviewCache = undefined;
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
    } finally {
      // Discard observations started during an action, including uncertain ones.
      if (mutates) this.overviewCache = undefined;
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

  async overview(): Promise<Overview> {
    if (this.overviewCache && this.overviewCache.until > Date.now()) return this.overviewCache.promise;
    const entry = { until: Infinity, promise: this.readOverview() };
    this.overviewCache = entry;
    try {
      const value = await entry.promise;
      entry.until = Date.now() + 5_000;
      return value;
    } catch (error) {
      if (this.overviewCache === entry) this.overviewCache = undefined;
      this.observations.failed();
      throw error;
    }
  }

  private async readOverview(): Promise<Overview> {
    const capabilities = await this.capabilities();
    const [status, roster] = await Promise.all([
      this.request("GET", "/v1/status").then((data) => statusSchema.parse(data)),
      this.request("GET", "/v1/players").then((data) => playersSchema.parse(data)),
    ]);
    const value = { status, ...roster, capabilities, observedAt: new Date().toISOString() };
    this.observations.observe(value);
    return value;
  }

  async activity() {
    try {
      await this.overview();
    } catch {
      /* The observation records the unavailable connection. */
    }
    return this.observations.view();
  }

  async bans() {
    return bansSchema.parse(await this.request("GET", "/v1/bans")).bans;
  }

  async gameLog(): Promise<GameLog> {
    const available = serves(await this.capabilities(), "GET", "/v1/audit");
    const entries = available ? parseGameLog(await this.request("GET", `/v1/audit?limit=${GAME_LOG_LIMIT}`)) : [];
    return { available, entries, limit: GAME_LOG_LIMIT, observedAt: new Date().toISOString() };
  }

  async identity(): Promise<ServerIdentity> {
    const capabilities = await this.capabilities();
    const read = async (path: string, field: string, banner = false): Promise<IdentityValue> => {
      if (!serves(capabilities, "GET", path)) return { available: false, value: null };
      try {
        const response = await this.request("GET", path);
        const value = z
          .string()
          .max(banner ? 2048 : 512)
          .refine((text) => [...text].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127))
          .parse(response?.[field])
          .trim();
        if (banner && value) {
          const url = new URL(value);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("Invalid image URL");
        }
        return { available: true, value: value || null };
      } catch {
        return {
          available: true,
          value: null,
          error: banner ? "The current banner could not be read." : "The server ID could not be read.",
        };
      }
    };
    const [serverId, banner] = await Promise.all([
      read("/v1/server-id", "serverId"),
      read("/v1/sponsor", "imageUrl", true),
    ]);
    return { serverId, banner };
  }

  async document(): Promise<ConfigDocument> {
    const parsed = configDocumentSchema.safeParse(await this.request("GET", "/v1/config"));
    if (!parsed.success) {
      throw new RconError("This game build does not expose an editable configuration document.");
    }
    return parsed.data;
  }

  configuration() {
    return readServerConfiguration(this);
  }

  async writeDocument(doc: ConfigDocument, text: string, capabilities: Capabilities) {
    if (!serves(capabilities, "PUT", "/v1/config") || capabilities.config?.writable === false)
      throw new RconError("This server does not allow configuration changes.");
    if (capabilities.limits?.maxBodyBytes && Buffer.byteLength(text, "utf8") > capabilities.limits.maxBodyBytes)
      throw new RconError("The updated configuration exceeds the server’s request limit.");
    if (serves(capabilities, "POST", "/v1/config/validate")) {
      if (rejected(await this.request("POST", "/v1/config/validate", text)))
        throw new RconError("The game refused this configuration. Nothing was saved.");
    }
    const result = await this.request("PUT", "/v1/config", text, doc.revision);
    if (rejected(result))
      throw new RconError("The game did not confirm the configuration change. Refresh before trying again.", true);
    return result;
  }

  async whitelist() {
    // Tolerate individual bad rows for display, without weakening action input
    // validation or the strict readback used to confirm a whitelist mutation.
    const slots = z
      .object({ reservedSlots: z.array(z.unknown()) })
      .parse(await this.request("GET", "/v1/reserved-slots")).reservedSlots;
    const live = slots.flatMap((value) => {
      const parsed = steamId.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    let configured: string[] | null = null;
    let configuredInvalidEntryCount = 0;
    try {
      const saved = inspectConfiguredWhitelist((await this.document()).text);
      configured = saved.ids;
      configuredInvalidEntryCount = saved.invalidEntryCount;
    } catch {
      /* Live list remains useful when document access is unavailable. */
    }
    const ids = [...new Set([...live, ...(configured ?? [])])].sort();
    const entries = ids.map((id) => ({
      steamId: id,
      active: live.includes(id),
      configured: configured === null ? null : configured.includes(id),
    }));
    return {
      entries,
      configurationAvailable: configured !== null,
      invalidEntryCount: slots.length - live.length,
      configuredInvalidEntryCount,
    };
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

  async mapOptions(map: string) {
    const [capabilities, catalog] = await Promise.all([this.capabilities(), this.catalog()]);
    if (!catalog.maps.some((entry) => entry.id === map)) throw new RconError("Choose a map from the current catalog.");
    let experiences = catalog.experiences;
    if (serves(capabilities, "GET", "/v1/catalog/maps/{map}/experiences")) {
      const result = z
        .object({ experiences: z.array(z.string()) })
        .parse(await this.request("GET", `/v1/catalog/maps/${encodeURIComponent(map)}/experiences`));
      experiences = experiences.filter((entry) => result.experiences.includes(entry.id));
    }
    const zones = serves(capabilities, "GET", "/v1/catalog/maps/{map}/alternators")
      ? z
          .object({ alternators: z.array(z.object({ tag: z.string() })) })
          .parse(await this.request("GET", `/v1/catalog/maps/${encodeURIComponent(map)}/alternators`))
          .alternators.map((entry) => entry.tag)
      : null;
    return { experiences, zones };
  }

  async rotation() {
    const rotation = z
      .object({
        enabled: z.boolean(),
        mode: z.string(),
        entries: z.array(
          z.object({
            index: z.number().int().nonnegative().optional(),
            map: z.string(),
            experiences: z.array(z.string()).optional(),
            lighting: z.string().optional(),
            zoneAlternator: z.string().optional(),
            status: z.string().nullable().optional(),
            denied: z.boolean().optional(),
          }),
        ),
      })
      .parse(await this.request("GET", "/v1/rotation"));
    return {
      ...rotation,
      entries: rotation.entries.map((entry, index) => ({ ...entry, index: entry.index ?? index })),
    };
  }

  checkRotation() {
    return checkSavedRotation(this);
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
        await this.writeDocument(doc, text, capabilities);
      }
    }
    try {
      // Confirm this exact target without rejecting unrelated malformed strings
      // loaded from the config. Non-string values remain ambiguous: never coerce IDs.
      const live = z
        .object({ reservedSlots: z.array(z.string()) })
        .parse(await this.request("GET", "/v1/reserved-slots")).reservedSlots;
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

  private async playerTeams(steamId: string) {
    const [status, data] = await Promise.all([
      this.request("GET", "/v1/status").then((value) => statusSchema.parse(value)),
      this.request("GET", "/v1/players").then((value) => teamPlayersSchema.parse(value)),
    ]);
    return {
      factions: status.factionScores,
      players: data.players.filter((player) => player.steamId === steamId),
      roster: data.players,
      round: roundStamp(status, Date.now()),
    };
  }

  private changedRound(expected: RoundStamp | undefined, actual: RoundStamp | null) {
    return expected && (!actual || !sameRound(expected, actual));
  }

  private async teamAction(
    action: Extract<AdminAction, { action: "team" }>,
    capabilities: Capabilities,
  ): Promise<ActionResult> {
    if (!serves(capabilities, "PATCH", "/v1/players/{id}"))
      throw new RconError("The current game build does not expose team changes.");
    const readTeams = () => this.playerTeams(action.steamId);
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
    if (this.changedRound(action.expectedRound, before.round))
      return { state: "failed", changed: false, message: "The round changed before this move. No move was sent." };
    if (assignedFaction(before.players[0].faction, before.factions) === targets[0].name)
      return {
        state: "applied",
        changed: false,
        message: `The player is already assigned to ${action.faction}. No move was sent.`,
      };
    if (
      action.expectedFaction &&
      assignedFaction(before.players[0].faction, before.factions) !== action.expectedFaction
    )
      return {
        state: "failed",
        changed: false,
        message: "The player's team changed before this move. No move was sent.",
      };
    if (action.maximumTargetPlayers) {
      const teams = before.roster.map((player) => assignedFaction(player.faction, before.factions));
      if (
        before.roster.some((player) => !player.steamId) ||
        new Set(before.roster.map((player) => player.steamId)).size !== before.roster.length ||
        teams.some((team) => team === null) ||
        teams.filter((team) => team === action.faction).length >= action.maximumTargetPlayers
      )
        return {
          state: "failed",
          changed: false,
          message: "The target team is full or the roster is incomplete. No move was sent.",
        };
    }

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
      if (assignedFaction(after.players[0].faction, after.factions) === currentTargets[0].name)
        return {
          state: "applied",
          changed: true,
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
    if (action.action === "kill" && (action.expectedFaction || action.expectedRound)) {
      const before = await this.playerTeams(action.steamId);
      if (
        before.players.length !== 1 ||
        this.changedRound(action.expectedRound, before.round) ||
        (action.expectedFaction &&
          assignedFaction(before.players[0].faction, before.factions) !== action.expectedFaction)
      )
        return {
          state: "failed",
          changed: false,
          message: "The player or round changed before this respawn. No respawn was sent.",
        };
    }
    if (action.action === "settings-save" || action.action === "rotation-save" || action.action === "map-next")
      return changeServerConfiguration(this, action, capabilities);
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
    if (action.action === "map") {
      await validateMapSelection(this, { ...action, experiences: action.experiences ?? [] }, capabilities);
    } else if (action.action === "lighting") {
      const catalog = await this.catalog();
      if (!catalog.lightings.some((entry) => entry.id === action.lighting))
        throw new RconError("Choose lighting from the current server catalog.");
    }
    if (action.action === "map" || action.action === "match-end" || action.action === "match-restart") {
      let current: z.infer<typeof statusSchema>;
      try {
        current = statusSchema.parse(await this.request("GET", "/v1/status"));
      } catch {
        throw new RconError(
          "The current round could not be verified. Nothing was sent. Close this review and refresh the dashboard.",
        );
      }
      const reviewed = action.expectedRound;
      const currentRound = roundStamp(current, Date.now());
      if (
        !reviewed ||
        reviewed.map !== current.map ||
        (reviewed.startedAt !== null &&
          (!currentRound || !sameRound({ map: reviewed.map, startedAt: reviewed.startedAt }, currentRound)))
      )
        return {
          state: "failed",
          changed: false,
          message:
            "The reviewed round changed or its clock is unavailable. Nothing was sent. Review the current match again.",
        };
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
