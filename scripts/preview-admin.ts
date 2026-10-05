/** Local-only visual preview. Never imported by AppModule or enabled by a production flag. */
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Global,
  HttpException,
  Logger,
  Module,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { AdminModule } from "../src/admin/admin.module";
import { AdminAuth, AdminGuard, type StaffRequest } from "../src/admin/admin.auth";
import { AdminExceptionFilter } from "../src/admin/admin.controller";
import { AdminSettings } from "../src/admin/admin.settings";
import { AdminStore } from "../src/admin/admin.store";
import { WardogsClient } from "../src/admin/wardogs.client";
import { GameServers } from "../src/admin/game-servers";
import { configuredWhitelist } from "../src/admin/whitelist-document";
import { settingFields, SESSION, ROTATION } from "../src/common/server-settings";
import { scalarValue } from "../src/admin/config-document";
import { parseRotation, auditAction } from "../src/admin/server-configuration";
import { mapLabel } from "../src/common/map-labels";
import type { ActionResult, AdminAction, Staff } from "../src/admin/admin.types";
import { ApplicationsModule } from "../src/applications/applications.module";
import { ApplicationsStore } from "../src/applications/applications.store";
import { ApplicantAuth } from "../src/applications/applicant.auth";
import type { ApplicationReview, WhitelistApplication } from "../src/applications/applications.types";
import { EnvService } from "../src/env/env.service";
import type { whitelistApplications } from "../src/database/schema";
import { TelemModule } from "../src/telemetry/telemetry.module";
import { TelemetryStore } from "../src/telemetry/telemetry.store";
import type { CombatStats } from "../src/telemetry/telemetry.types";
import { SupportersModule } from "../src/supporters/supporters.module";
import { SupportersStore, type FounderReview } from "../src/supporters/supporters.store";
import { SupporterMatchService } from "../src/supporters/supporter-match.service";
import { SupporterMatchStore } from "../src/supporters/supporter-match.store";
import { DiscordRolesDiscord } from "../src/discord-roles/discord-roles.discord";
import { DiscordRolesStore } from "../src/discord-roles/discord-roles.store";
import { PatreonSyncService, type PatreonSyncStatus } from "../src/supporters/patreon-sync.service";
import { MapVotesModule } from "../src/map-votes/map-votes.module";
import { MapVotesStore } from "../src/map-votes/map-votes.store";
import { MapVotesDiscord } from "../src/map-votes/map-votes.discord";
import { ballotWinner, type MapVoteRecord } from "../src/map-votes/map-votes.types";
import { automationSettings, closeReached } from "../src/common/voting-policy";
import { ServerEventsModule } from "../src/server-events/server-events.module";
import { ServerCommunityController } from "../src/server-community/server-community.controller";
import { ServerCommunityService } from "../src/server-community/server-community.service";
import type { CommunityMessagesStatus } from "../src/common/community-messages";
import { ServerEventsStore } from "../src/server-events/server-events.store";
import type { EventRecord, EventOperation, EventProgress, EventStop } from "../src/server-events/server-events.types";
import { ChannelType, PermissionFlagsBits, type Client, type MessageCreateOptions } from "discord.js";
import { StaffAlertsController } from "../src/staff-alerts/staff-alerts.controller";
import { StaffAlerts } from "../src/staff-alerts/staff-alerts.service";
import { StaffAlertsMonitor } from "../src/staff-alerts/staff-alerts.monitor";
import { settingsView, staffAlertsOptions } from "../src/staff-alerts/staff-alerts.config";
import type { StaffAlertsStatus } from "../src/common/staff-alerts";
import { automaticBlockedMessages } from "../src/supporters/supporter-match.rules";
import {
  founderBlockedMessages,
  type FounderPolicy,
  type ManualMemberInput,
  type PaymentView,
  type SupporterMutation,
  type SupporterView,
} from "../src/supporters/supporters.types";

const previewPort = Number(process.env.PREVIEW_PORT || 4317);
// PREVIEW_GAME_MODE=pre-round reproduces the 2 October waiting sample (1/100 players, scores 0);
// full-server shows 100/100 players (a 34/33/33 roster, so 50v50 readiness can pass) and a 100-point
// match in progress. PREVIEW_CLOCK=false hides the match clock on every server, as the live build did
// on 2 October.
const previewMode = process.env.PREVIEW_GAME_MODE ?? "live";
const previewClock = process.env.PREVIEW_CLOCK !== "false";
function createPreviewGame(name: string, reportsClock: boolean) {
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
    { code: "RED", name: "Valkyra", colorHex: "#D86060", score: 18420 },
    { code: "BLU", name: "Lonestar", colorHex: "#5B95D8", score: 14800 },
    { code: "GRN", name: "Manticore", colorHex: "#7BC462", score: 12600 },
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
      if (path === "/v1/capabilities")
        return { routes, build: "LOCAL PREVIEW · SAMPLE DATA", config: { writable: true } };
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
            writable: true,
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
// Primary exercises the rotation-marker fallback; Events supplies the optional status index and clock.
const primaryPreview = createPreviewGame("The UNCs | Primary preview", false);
const eventPreview = createPreviewGame("The UNCs | Event preview", true);
const players = primaryPreview.players;
const previewDefinitions = [
  {
    id: "primary",
    name: "UNCs Primary",
    rconUrl: "https://primary.example.test",
    password: "preview-only",
    feedToken: "preview-primary-feed-placeholder-credential",
  },
  {
    id: "event",
    name: "UNCs Events",
    rconUrl: "https://event.example.test",
    password: "preview-only",
    feedToken: "preview-event-feed-placeholder-credential",
  },
];
const settings = new AdminSettings({
  get: (key: string) => (key === "WARDOGS_SERVERS" ? previewDefinitions : previewEnvironment[key]),
} as EnvService);
const gameServers = new GameServers(settings);
gameServers.get = (id) => (gameServers.resolve(id) === "primary" ? primaryPreview.game : eventPreview.game);
type PreviewRecord = {
  id: string;
  actorId: string;
  actorName: string;
  requestHash: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
  state: string;
  message: string;
  createdAt: Date;
};
const records = new Map<string, PreviewRecord>();
const sampleId = randomUUID();
records.set(sampleId, {
  id: sampleId,
  actorId: "preview",
  actorName: "Demo staff",
  requestHash: "",
  action: "broadcast",
  target: "server",
  details: { reason: "Community welcome (sample)" },
  state: "accepted",
  message: "Sample action. Nothing was sent to the live game.",
  createdAt: new Date(),
});
const store = {
  async begin(staff: Staff, action: AdminAction, requestHash: string) {
    if (records.has(action.id)) return { created: false, record: records.get(action.id) };
    const record = {
      id: action.id,
      actorId: staff.id,
      actorName: staff.name,
      requestHash,
      action: action.action,
      target: "steamId" in action ? action.steamId : "server",
      details: auditAction(action),
      state: "started",
      message: "Started",
      createdAt: new Date(),
    };
    records.set(action.id, record);
    return { created: true, record };
  },
  async finish(id: string, result: ActionResult) {
    Object.assign(records.get(id)!, result);
  },
  async history(serverId: string) {
    return [...records.values()]
      .filter((record) => (record.details.serverId ?? "primary") === serverId)
      .reverse()
      .slice(0, 100);
  },
  async staffQueuedSince(serverId: string, since: Date) {
    return [...records.values()].some(
      (record) =>
        record.action === "map-next" &&
        (record.details.serverId ?? "primary") === serverId &&
        record.createdAt >= since &&
        !record.actorId.startsWith("system:") &&
        record.state !== "failed",
    );
  },
  async receipt(id: string, serverId: string) {
    const record = records.get(id);
    if (!record || (record.details.serverId ?? "primary") !== serverId) return null;
    return {
      id: record.id,
      actorName: record.actorName,
      action: record.action,
      target: record.target,
      details: record.details,
      state: record.state,
      message: record.message,
      createdAt: record.createdAt,
    };
  },
};
const auth = {
  async serverList() {
    return { legacy: false, servers: gameServers.list().map((server) => ({ ...server, role: "admin" })) };
  },
  async serverStaff(staff: Staff, id: string) {
    const server = gameServers.list().find((server) => server.id === gameServers.resolve(id))!;
    return { ...staff, serverId: id, serverVersion: server.version };
  },
  async role() {
    return "admin";
  },
  async authenticate(req: Request) {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (![
        "http://127.0.0.1:4317",
        "http://127.0.0.1:4318",
        "http://127.0.0.1:4319",
        `http://127.0.0.1:${previewPort}`,
      ].includes(req.headers.origin ?? "") ||
        req.headers["x-csrf-token"] !== "local-preview")
    )
      throw new Error("Preview origin rejected");
    return { id: "preview", name: "UNC Staff", role: "admin", csrf: "local-preview", demo: true };
  },
  login(res: Response) {
    res.redirect("/admin");
  },
  callback(_req: Request, res: Response) {
    res.redirect("/admin");
  },
  logout() {
    return { ok: true };
  },
};

// Both intake and review stay entirely in memory in this isolated demo.
const applications = new Map<string, WhitelistApplication>();
const applicationStore = {
  async create(input: typeof whitelistApplications.$inferInsert) {
    if (
      [...applications.values()].some(
        (entry) =>
          entry.serverId === input.serverId &&
          (entry.discordUserId === input.discordUserId || entry.steamId === input.steamId),
      )
    )
      return undefined;
    const entry = {
      id: randomUUID(),
      email: null,
      emailVerified: false,
      steamOwnershipVerified: false,
      contactConsentAt: null,
      status: "pending",
      submittedAt: new Date(),
      updatedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      reviewReason: null,
      actionId: null,
      reviewId: null,
      reviewKind: null,
      lastActionState: null,
      lastActionMessage: null,
      accessIntent: "grant",
      whitelistGrant: null,
      revokedAt: null,
      ...input,
    } as WhitelistApplication;
    applications.set(entry.id, entry);
    return entry;
  },
  async own(userId: string, serverId: string) {
    return [...applications.values()].find((entry) => entry.discordUserId === userId && entry.serverId === serverId);
  },
  async list(serverId: string) {
    return [...applications.values()].filter((entry) => entry.serverId === serverId).reverse();
  },
  async get(id: string, serverId: string) {
    const entry = applications.get(id);
    return entry?.serverId === serverId ? { ...entry } : undefined;
  },
  async finishRecheck(previous: WhitelistApplication, review: ApplicationReview, staff: Staff, result: ActionResult) {
    const entry = applications.get(previous.id);
    if (
      !entry ||
      entry.serverId !== staff.serverId ||
      entry.status !== previous.status ||
      entry.reviewId !== previous.reviewId
    )
      throw new ConflictException("Preview application changed during the check");
    const revoke = entry.accessIntent === "revoke";
    Object.assign(entry, {
      status: result.state === "applied" ? (revoke ? "revoked" : "approved") : "needs_review",
      ...(revoke && result.state === "applied" ? { revokedAt: new Date() } : {}),
      reviewedAt: new Date(),
      reviewedBy: staff.id,
      reviewReason: review.reason,
      reviewId: review.id,
      reviewKind: "recheck",
      lastActionState: result.state,
      lastActionMessage: result.message,
      updatedAt: new Date(),
    });
    return entry;
  },
  async claim(id: string, review: ApplicationReview, kind: "approve" | "decline", staff: Staff) {
    const entry = applications.get(id);
    if (entry?.serverId !== staff.serverId) return { claimed: false, application: undefined };
    if (!entry || entry.status !== "pending") return { claimed: false, application: entry };
    Object.assign(entry, {
      status: kind !== "decline" ? "processing" : "declined",
      reviewedAt: new Date(),
      reviewedBy: staff.id,
      reviewReason: review.reason,
      actionId: review.id,
      reviewId: review.id,
      reviewKind: kind,
      lastActionState: kind !== "decline" ? "started" : "applied",
      lastActionMessage: kind !== "decline" ? "Review started." : "Application declined. No whitelist change was sent.",
      updatedAt: new Date(),
    });
    return { claimed: true, application: entry };
  },
  async finishApproval(
    id: string,
    actionId: string,
    result: ActionResult,
    grant: "granted" | "existing" | null = null,
  ) {
    const entry = applications.get(id);
    if (!entry || entry.status !== "processing" || entry.reviewId !== actionId)
      throw new Error("Preview application changed");
    Object.assign(entry, {
      status: result.state === "applied" ? "approved" : "needs_review",
      ...(result.state === "applied" && grant ? { whitelistGrant: grant } : {}),
      lastActionState: result.state,
      lastActionMessage: result.message,
      updatedAt: new Date(),
    });
    return entry;
  },
  async claimRevoke(id: string, review: ApplicationReview, staff: Staff) {
    const entry = applications.get(id);
    if (!entry || entry.serverId !== staff.serverId) return { claimed: false, application: undefined };
    if (!(entry.status === "approved" || (entry.status === "needs_review" && entry.accessIntent === "revoke")))
      return { claimed: false, application: entry };
    Object.assign(entry, {
      status: "revoking",
      accessIntent: "revoke",
      reviewedAt: new Date(),
      reviewedBy: staff.id,
      reviewReason: review.reason,
      reviewId: review.id,
      reviewKind: "revoke",
      lastActionState: "started",
      lastActionMessage: "Revocation started.",
      updatedAt: new Date(),
    });
    return { claimed: true, application: entry };
  },
  async finishRevoke(id: string, actionId: string, result: ActionResult) {
    const entry = applications.get(id);
    if (!entry || entry.status !== "revoking" || entry.reviewId !== actionId)
      throw new Error("Preview application changed");
    const removed = result.state === "applied" || result.state === "pending";
    Object.assign(entry, {
      status: removed ? "revoked" : result.state === "failed" ? "approved" : "needs_review",
      ...(removed ? { revokedAt: new Date() } : {}),
      ...(result.state === "failed" ? { accessIntent: "grant" } : {}),
      lastActionState: result.state,
      lastActionMessage: result.message,
      updatedAt: new Date(),
    });
    return entry;
  },
  async recordExternalRevoke(removal: { serverId: string; steamId: string; actorId: string; state: string }) {
    const revoked = [...applications.values()].filter(
      (entry) =>
        entry.serverId === removal.serverId && entry.steamId === removal.steamId && entry.status === "approved",
    );
    for (const entry of revoked)
      Object.assign(entry, {
        status: "revoked",
        accessIntent: "revoke",
        revokedAt: new Date(),
        reviewedBy: removal.actorId,
        reviewKind: "revoke",
        lastActionState: removal.state,
        lastActionMessage: "Removed on the Whitelist page.",
        updatedAt: new Date(),
      });
    return revoked;
  },
};
const applicantAuth = {
  async authenticate(req: Request) {
    if (!(req.headers.cookie ?? "").split(";").some((part) => part.trim() === "uncs_preview_applicant=sample"))
      throw new UnauthorizedException("Sign in to the sample application.");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (req.headers.origin !== "http://127.0.0.1:4318" || req.headers["x-csrf-token"] !== "local-preview-applicant")
    )
      throw new ForbiddenException("Preview applicant origin rejected");
    return {
      userId: "555555555555555555",
      displayName: "Sample applicant",
      csrf: "local-preview-applicant",
      demo: true,
    };
  },
  login(_req: Request, res: Response) {
    res.cookie("uncs_preview_applicant", "sample", { httpOnly: true, sameSite: "lax", path: "/apply" });
    res.redirect("/whitelist");
  },
  callback(_req: Request, res: Response) {
    res.redirect("/whitelist");
  },
  async logout(req: Request, res: Response) {
    await this.authenticate(req);
    res.clearCookie("uncs_preview_applicant", { path: "/apply" });
    return { ok: true };
  },
};
const demoInstance = randomUUID();
const demoEvents = Array.from({ length: 48 }, (_, index) => {
  const killer = index % 11 === 0 ? null : players[index % 7 < 4 ? 0 : index % players.length];
  const victim = players[1 + (index % (players.length - 1))];
  const ageDays = index < 24 ? 0 : index < 38 ? 3 : 12;
  const suicide = !!killer && killer.steamId === victim.steamId;
  return {
    serverId: index % 3 === 0 ? "event" : "primary",
    eventId: randomUUID(),
    serverInstanceId: demoInstance,
    receivedAt: new Date(Date.now() - ageDays * 86_400_000 - index * 65_000 - 20_000),
    eventTime: 3400 - index * 35,
    matchId: demoInstance,
    mapName: "Kavkazi",
    killerSteamId: killer?.steamId ?? null,
    killerName: killer?.name ?? null,
    victimSteamId: victim.steamId,
    victimName: victim.name,
    cause: killer ? "Id.Item.AK74M" : null,
    distanceMeters: killer ? 18 + index * 2.75 : null,
    headshot: !!killer && !suicide && index % 4 === 0,
    suicide,
  };
});
const filteredDemoEvents = (since: Date, until: Date, playerId?: string, serverId = "primary") =>
  demoEvents.filter(
    (entry) =>
      entry.serverId === serverId &&
      entry.receivedAt >= since &&
      entry.receivedAt <= until &&
      (!playerId || entry.killerSteamId === playerId || entry.victimSteamId === playerId),
  );
const telemetryStore = {
  async ingest() {
    throw new Error("Live event intake is unavailable in the simulated preview.");
  },
  async tracking(serverId: string) {
    const entries = demoEvents.filter((event) => event.serverId === serverId);
    return {
      firstReceivedAt: new Date(Math.min(...entries.map((event) => event.receivedAt.getTime()))),
      lastReceivedAt: new Date(Math.max(...entries.map((event) => event.receivedAt.getTime()))),
    };
  },
  async snapshot(since: Date, until: Date, playerId?: string, serverId = "primary") {
    const events = filteredDemoEvents(since, until, playerId, serverId);
    const stats = new Map<string, CombatStats>();
    const player = (id: string, name: string | null) => {
      if (!stats.has(id))
        stats.set(id, { steamId: id, name: name ?? id, kills: 0, deaths: 0, headshotKills: 0, kd: null });
      return stats.get(id)!;
    };
    for (const event of events) {
      if (event.killerSteamId) {
        const killer = player(event.killerSteamId, event.killerName);
        if (!event.suicide) {
          killer.kills++;
          if (event.headshot) killer.headshotKills++;
        }
      }
      player(event.victimSteamId, event.victimName).deaths++;
    }
    const leaderboard = [...stats.values()]
      .filter((row) => !playerId || row.steamId === playerId)
      .map((row) => ({ ...row, kd: row.deaths ? Math.round((row.kills / row.deaths) * 100) / 100 : null }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.steamId.localeCompare(b.steamId));
    return {
      leaderboard,
      totals: {
        events: events.length,
        kills: leaderboard.reduce((total, row) => total + row.kills, 0),
        deaths: leaderboard.reduce((total, row) => total + row.deaths, 0),
        headshotKills: leaderboard.reduce((total, row) => total + row.headshotKills, 0),
        players: leaderboard.length,
      },
    };
  },
  async events(since: Date, until: Date, playerId?: string, serverId = "primary") {
    return filteredDemoEvents(since, until, playerId, serverId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, 100);
  },
};
// Fictional supporter evidence stays in memory. No Patreon credentials or calls.
const demoSupporters = new Map<string, SupporterView>();
/** No whitelist applications exist in the preview, so automatic matching never has anything to copy. */
function previewMatch(record: Pick<SupporterView, "discordId" | "discordSource" | "steamId">, founder: boolean) {
  const automaticBlockedReason = founder
    ? null
    : !record.discordId
      ? ("no_discord" as const)
      : record.discordSource !== "patreon"
        ? ("discord_not_from_patreon" as const)
        : ("no_patreon_payment" as const);
  return {
    match: {
      steam: record.discordId
        ? { reason: "no_application" as const, steamId: null, applicationId: null, serverId: null }
        : null,
      sourceApplication: null,
      sourceApplicationRevoked: false,
      patreonDiscordElsewhere: false,
      discordReportedForOtherPatron: false,
      linkedSteamShared: false,
    },
    automaticPayment: null,
    automaticBlockedReason,
    automaticBlockedMessage: automaticBlockedReason ? automaticBlockedMessages[automaticBlockedReason] : null,
  };
}
const demoSupporterActions = new Map<string, string>();
const demoPaymentReferences = new Set<string>();
for (const [index, displayName] of ["Demo · Steady Supporter", "Demo · Founding Crew", "Demo · New Backer"].entries()) {
  const id = randomUUID();
  const paidAt = `2026-09-30T${10 + index}:00:00-04:00`;
  const payment: PaymentView = {
    id: randomUUID(),
    paidAt,
    amountCents: index === 2 ? null : 500,
    currency: index === 2 ? null : "USD",
    source: index === 2 ? "signed_status" : "manual_receipt",
    reference: `DEMO-RECEIPT-${index + 1}`,
    verificationState: index === 2 ? "unverified" : "verified",
    firstSuccessfulPaymentVerified: index !== 2,
    minimumConfirmed: false,
    recordedBy: index === 2 ? null : "999999999999999991",
  };
  demoPaymentReferences.add(payment.reference.toLowerCase());
  demoSupporters.set(id, {
    id,
    provider: "patreon",
    patreonMemberId: `preview-member-${index + 1}`,
    confirmKey: `preview-member-${index + 1}`,
    displayName,
    patronStatus: index === 1 ? "former_patron" : "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: paidAt,
    observedAt: new Date().toISOString(),
    reviewState: index === 1 ? "verified" : "pending",
    discordId: index === 2 ? null : `88888888888888888${index + 1}`,
    discordSource: index === 2 ? null : "staff",
    patreonDiscordId: null,
    steamId: index === 2 ? null : `7656119800000000${index + 1}`,
    steamSource: index === 2 ? null : "staff",
    steamApplicationId: null,
    identityState: index === 2 ? "unlinked" : "staff_linked",
    version: 1,
    latestPayment: payment,
    payments: [payment],
    founderEligiblePayment: null,
    founder:
      index === 1 ? { awardedAt: paidAt, paymentId: payment.id, source: payment.source, automatic: false } : null,
    founderBlockedReason: null,
    founderFirstPaymentToCheck: false,
    founderBlockedMessage: null,
    needsDiscordLink: false,
    ...previewMatch(
      {
        discordId: index === 2 ? null : `88888888888888888${index + 1}`,
        discordSource: index === 2 ? null : "staff",
        steamId: index === 2 ? null : `7656119800000000${index + 1}`,
      },
      index === 1,
    ),
  });
}
/** Founder payments marked checked in the preview, as `record:payment:reason`. */
const previewCheckedReviews = new Set<string>();
const supporterStore = {
  async uncheckedFounderReviews<T extends Pick<FounderReview, "supporterId" | "unverifiedPaymentId" | "reviewReason">>(
    reviews: T[],
  ) {
    return reviews.filter(
      (review) =>
        !previewCheckedReviews.has(`${review.supporterId}:${review.unverifiedPaymentId}:${review.reviewReason}`),
    );
  },
  async ingest() {
    throw new Error("Patreon webhook intake is unavailable in the simulated preview.");
  },
  async register(input: ManualMemberInput, staff: Staff, campaignId: string, policy: FounderPolicy) {
    const fingerprint = JSON.stringify({ kind: "manual-member", campaignId, input, staff: staff.id });
    const previous = demoSupporterActions.get(input.id);
    const existing = [...demoSupporters.values()].find((entry) => entry.patreonMemberId === input.patreonMemberId);
    if (previous) {
      if (previous !== fingerprint || !existing) throw new ConflictException("Preview review ID was already used.");
      return { ok: true, replayed: true, supporter: structuredClone(existing) };
    }
    if (existing) throw new ConflictException("This preview membership is already recorded. Search its membership ID.");
    const record: SupporterView = {
      id: randomUUID(),
      provider: "patreon",
      patreonMemberId: input.patreonMemberId,
      confirmKey: input.patreonMemberId,
      displayName: input.displayName,
      patronStatus: null,
      lastChargeStatus: null,
      lastChargeAt: null,
      observedAt: new Date().toISOString(),
      reviewState: "unverified",
      discordId: null,
      discordSource: null,
      patreonDiscordId: null,
      steamId: null,
      steamSource: null,
      steamApplicationId: null,
      identityState: "unlinked",
      version: 1,
      latestPayment: null,
      payments: [],
      founderEligiblePayment: null,
      founder: null,
      founderBlockedReason: "no_payment",
      founderFirstPaymentToCheck: false,
      founderBlockedMessage: founderBlockedMessages.no_payment,
      needsDiscordLink: false,
      ...previewMatch({ discordId: null, discordSource: null, steamId: null }, false),
    };
    demoSupporters.set(record.id, record);
    demoSupporterActions.set(input.id, fingerprint);
    const [supporter] = await this.list(campaignId, policy, record.id);
    return { ok: true, replayed: false, supporter };
  },
  async recordPaypal() {
    throw new ConflictException("Recording PayPal supporters is unavailable in the simulated preview.");
  },
  async list(_campaignId: string | null, _policy: FounderPolicy, memberId?: string, search = "") {
    const needle = search.toLocaleLowerCase();
    return structuredClone(
      [...demoSupporters.values()]
        .filter((entry) => !memberId || entry.id === memberId)
        .filter(
          (entry) =>
            !needle ||
            [entry.displayName, entry.patreonMemberId, entry.discordId, entry.steamId].some((value) =>
              value?.toLocaleLowerCase().includes(needle),
            ),
        )
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id))
        .slice(0, 100)
        .map((entry) => {
          const payment = entry.latestPayment;
          const eligible =
            _policy.configured &&
            payment?.source === "manual_receipt" &&
            payment.verificationState === "verified" &&
            payment.firstSuccessfulPaymentVerified &&
            payment.currency === _policy.currency &&
            payment.amountCents !== null &&
            payment.amountCents >= _policy.amountCents &&
            Date.parse(payment.paidAt) >= Date.parse(_policy.startsAt!) &&
            Date.parse(payment.paidAt) < Date.parse(_policy.endsAt!);
          return { ...entry, founderEligiblePayment: eligible ? payment : null };
        }),
    );
  },
  async mutate(
    memberId: string,
    input: SupporterMutation,
    staff: Staff,
    campaignId: string | null,
    policy: FounderPolicy,
  ) {
    const record = demoSupporters.get(memberId);
    if (!record) throw new ConflictException("Preview supporter not found.");
    const fingerprint = JSON.stringify({ memberId, input, staff: staff.id });
    const previous = demoSupporterActions.get(input.id);
    if (previous) {
      if (previous !== fingerprint) throw new ConflictException("Preview review ID was already used.");
      return { ok: true, replayed: true, supporter: structuredClone(record) };
    }
    if (record.version !== input.version || record.confirmKey !== input.confirm)
      throw new ConflictException("Preview record changed. Refresh before reviewing.");
    if (input.kind === "founder") {
      const [view] = await this.list(campaignId, policy, memberId);
      if (
        !view.founderEligiblePayment ||
        view.founderEligiblePayment.id !== input.paymentId ||
        !record.discordId ||
        !record.steamId ||
        record.founder
      )
        throw new ConflictException(
          "This preview record needs a matched identity and qualifying checked first payment.",
        );
      record.founder = {
        awardedAt: new Date().toISOString(),
        paymentId: input.paymentId,
        source: view.founderEligiblePayment.source,
        automatic: false,
      };
      Object.assign(record, previewMatch(record, true));
    }
    if (input.kind === "link") {
      if (
        [...demoSupporters.values()].some(
          (other) => other.id !== memberId && (other.discordId === input.discordId || other.steamId === input.steamId),
        )
      )
        throw new ConflictException("This preview account is already linked.");
      if (input.discordId !== undefined && input.discordId !== record.discordId)
        Object.assign(record, { discordId: input.discordId, discordSource: "staff" });
      if (input.steamId !== undefined && input.steamId !== record.steamId)
        Object.assign(record, { steamId: input.steamId, steamSource: "staff", steamApplicationId: null });
      record.identityState =
        record.discordId && record.steamId
          ? record.discordSource === "patreon"
            ? "patreon_linked"
            : "staff_linked"
          : record.discordId || record.steamId
            ? "partial"
            : "unlinked";
      Object.assign(record, previewMatch(record, Boolean(record.founder)));
    }
    if (input.kind === "payment") {
      const reference = input.reference.toLowerCase();
      if (demoPaymentReferences.has(reference))
        throw new ConflictException("This preview payment reference is already recorded.");
      demoPaymentReferences.add(reference);
      record.latestPayment = {
        id: randomUUID(),
        paidAt: input.paidAt.toISOString(),
        amountCents: input.amountCents,
        currency: input.currency,
        reference,
        source: "manual_receipt",
        verificationState: "verified",
        firstSuccessfulPaymentVerified: input.firstSuccessfulPaymentVerified,
        minimumConfirmed: false,
        recordedBy: staff.id,
      };
      record.payments = [record.latestPayment, ...record.payments];
    }
    if (input.kind === "review") {
      record.reviewState = "verified";
      // As the store does: a checked founder payment leaves the payments to check. The preview's is unverified.
      if (input.paymentId) previewCheckedReviews.add(`${memberId}:${input.paymentId}:unverified`);
    }
    record.version++;
    demoSupporterActions.set(input.id, fingerprint);
    return { ok: true, replayed: false, supporter: structuredClone(record) };
  },
};
// A simulated Patreon import: no token and no Patreon calls. "Sync now" runs for two seconds.
// It reports one Discord conflict and one founder promise to recheck, so both review lists show on a phone.
const [, previewFounder, previewBacker] = [...demoSupporters.values()];
const previewUnverifiedPaymentId = randomUUID();
let previewSyncRun: Promise<PatreonSyncStatus> | null = null;
let previewSyncedAt = Date.now() - 12 * 60_000;
const previewSyncStatus = (): PatreonSyncStatus => ({
  configured: true,
  running: previewSyncRun !== null,
  lastAttemptAt: new Date(previewSyncedAt - 4_000).toISOString(),
  lastSuccessAt: new Date(previewSyncedAt).toISOString(),
  lastError: null,
  tokenRejected: false,
  members: demoSupporters.size,
  newMembers: 0,
  updated: 1,
  payments: 2,
  discordLinks: 1,
  conflicts: 1,
  truncated: 0,
  revokedPayments: 1,
  paidMembers: 2,
  discordReported: 1,
  tierConfirmed: 0,
  tierConfirmedNew: 0,
  tierUnconfirmed: 0,
  tierPrices: "not_requested",
  memberListComplete: true,
  intervalMinutes: 30,
  nextAttemptAt: new Date(previewSyncedAt + 30 * 60_000).toISOString(),
  conflictDetails: [
    // The demo supporters are Patreon records, so the member ID equals the confirm key.
    { supporterId: previewBacker.id, patreonMemberId: previewBacker.confirmKey, reason: "discord-in-use" },
  ],
  founderReviews: previewFounder.founder
    ? [
        {
          supporterId: previewFounder.id,
          patreonMemberId: previewFounder.confirmKey,
          paymentId: previewFounder.founder.paymentId,
          paymentSource: "manual_receipt",
          reference: "DEMO-RECEIPT-2",
          unverifiedPaymentId: previewUnverifiedPaymentId,
          unverifiedReference: "DEMO-PLEDGE-EVENT-2",
          reviewReason: "unverified" as const,
        },
      ]
    : [],
});
const patreonSync = {
  configured: () => true,
  status: previewSyncStatus,
  async staffSync() {
    if (previewSyncRun) return { joined: true, sync: await previewSyncRun };
    previewSyncRun = new Promise<PatreonSyncStatus>((done) =>
      setTimeout(() => {
        previewSyncedAt = Date.now();
        previewSyncRun = null;
        done(previewSyncStatus());
      }, 2_000),
    );
    return { joined: false, sync: await previewSyncRun };
  },
  onApplicationBootstrap() {},
  onModuleDestroy() {},
};
const previewEnvironment: Record<string, unknown> = {
  MAP_VOTES_ENABLED: process.env.PREVIEW_MAP_VOTES_ENABLED !== "false",
  // Voted 50v50 stays held for the owner's review unless a rehearsal asks for it.
  MAP_VOTES_FIFTY_ENABLED: process.env.PREVIEW_MAP_VOTES_FIFTY_ENABLED === "true",
  SERVER_EVENTS_ENABLED: true,
  WARDOGS_RCON_URL: "https://game.example.test",
  ADMIN_GUILD_ID: "111111111111111111",
  MAP_VOTES_CHANNEL_ID: "222222222222222222",
  WHITELIST_APPLICATIONS_ENABLED: true,
  WHITELIST_APPLICATION_EMAIL_REQUIRED: true,
  WARDOGS_FEED_ENABLED: true,
  WARDOGS_FEED_TOKEN: "local-preview-only-feed-placeholder-credential",
  PATREON_ENABLED: true,
  PATREON_CAMPAIGN_ID: "999999999",
  PATREON_WEBHOOK_SECRET: "local-preview-only-patreon-placeholder",
  PATREON_FOUNDER_START_AT: "2026-09-30T00:00:00-04:00",
  PATREON_FOUNDER_END_AT: "2026-10-15T00:00:00-04:00",
  // Staff alerts post to a simulated private channel; nothing reaches Discord.
  STAFF_ALERTS_CHANNEL_ID: "444444444444444444",
  STAFF_ALERTS_ENABLED: true,
  STAFF_ALERTS_TIME_ZONE: "America/New_York",
  STAFF_ALERTS_HEALTH_ENABLED: true,
  STAFF_ALERTS_SEEDING_ENABLED: true,
  STAFF_ALERTS_SEEDING_PRIME_HOURS: "17:00-23:00",
  STAFF_ALERTS_PERFORMANCE_ENABLED: "observe",
  STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD: ["76561198066952872"],
  STAFF_ALERTS_WATCHLIST_ENABLED: true,
  STAFF_ALERTS_WATCHLIST: [{ steamId: "76561198123456781", reason: "Aimbot (preview sample)", communities: 4 }],
};
const previewEnv = { get: (key: string) => previewEnvironment[key] } as EnvService;
/** A private channel double that passes every staff-channel check; posts only print to the console. */
const previewStaffChannel = {
  id: "444444444444444444",
  type: ChannelType.GuildText,
  guildId: "111111111111111111",
  guild: { members: { me: { id: "bot" } }, roles: { everyone: { id: "everyone" }, cache: new Map() } },
  permissionsFor: (target: { id: string }) => ({
    has: (wanted: bigint | bigint[]) =>
      target.id !== "everyone" ||
      !(Array.isArray(wanted) ? wanted : [wanted]).includes(PermissionFlagsBits.ViewChannel),
  }),
  send: async (options: MessageCreateOptions) => {
    const embed = options.embeds?.[0];
    console.info(`Preview staff alert: ${embed && "title" in embed ? embed.title : options.content}`);
    return { id: "555555555555555555" };
  },
  messages: { edit: async () => ({}) },
};
const previewStaffAlerts = new StaffAlerts(
  { isReady: () => true, channels: { fetch: async () => previewStaffChannel } } as unknown as Client,
  previewEnv,
);
const NO_ACTION = "Gramps took no action.";
/** Sample alerts for rehearsing the Staff alerts tab: each category, delivery state and a review. */
async function seedPreviewStaffAlerts() {
  const hour = 3_600_000;
  const at = (offset: number) => new Date(Date.now() - offset).toISOString();
  const server = { serverId: "primary", serverName: "UNCs Primary" };
  await previewStaffAlerts.raise({
    ...server,
    kind: "game-restart",
    severity: "info",
    key: "preview:restart",
    title: "Likely restart",
    lines: [
      "Map Bakurani to Ozeti, players 6 to 2, connection lost 3 min (unscheduled).",
      "Around 04:00 ET. Gramps cannot see uptime or a boot ID; this is inferred from RCON reads.",
      NO_ACTION,
    ],
    facts: { at: at(10 * hour), playersBefore: 6, scheduled: "no" },
    deliver: true,
  });
  await previewStaffAlerts.raise({
    ...server,
    kind: "seeding-after-restart",
    severity: "warning",
    key: "preview:seeding",
    title: "Still empty 30 min after the 04:00 ET restart",
    lines: [
      "0 players on; below 1 since 04:37 ET.",
      "Gramps reads the player count over RCON. It cannot see whether the server is listed in the browser. Check the in-game browser and consider a seed call.",
      NO_ACTION,
    ],
    facts: { players: 0, lowSince: at(9 * hour), restartAt: at(10 * hour) },
    deliver: true,
  });
  await previewStaffAlerts.raise({
    ...server,
    kind: "seeding-recovered",
    severity: "info",
    key: "preview:seeding-ok",
    title: "Players are back",
    lines: ["12 players on after 10 h 23 min below 1.", NO_ACTION],
    deliver: true,
  });
  await previewStaffAlerts.raise({
    ...server,
    kind: "performance-window",
    severity: "warning",
    key: "preview:perf-online",
    title: "Review: unusual kill rate",
    lines: [
      "MossyBoots had 31 kills in 5 min (6.2/min).",
      "Round on Bakurani: 44 kills, 3 deaths (K/D 14.7).",
      `From game counters only. Not proof of cheating. ${NO_ACTION}`,
    ],
    player: { steamId: "76561198123456789", name: "MossyBoots" },
    facts: { rules: "window", windowKills: 31, windowMinutes: 5, killsPerMinute: 6.2, roundKills: 44, kd: 14.7 },
    feed: {
      kills: 40,
      windowKills: 29,
      headshotShare: 0.35,
      topCauses: ["Rifle", "Grenade"],
      maxDistanceMeters: 212,
      since: at(hour / 2),
    },
    deliver: false,
  });
  const offline = await previewStaffAlerts.raise({
    ...server,
    kind: "performance-match",
    severity: "warning",
    key: "preview:perf-offline",
    title: "Review: unusual round K/D",
    lines: [
      "OfflineAce has 44 kills and 2 deaths this round on Ozeti (K/D 22).",
      `From game counters only. Not proof of cheating. ${NO_ACTION}`,
    ],
    player: { steamId: "76561198000000077", name: "OfflineAce" },
    facts: { rules: "match", roundKills: 44, roundDeaths: 2, kd: 22 },
    deliver: false,
    suppressed: "player cooldown",
  });
  await previewStaffAlerts.raise({
    ...server,
    kind: "watchlist-join",
    severity: "high",
    key: "preview:watch",
    title: "Watch list: player joined",
    lines: [
      "TeaAndTanks joined.",
      "Banned in 4 communities (as recorded 2026-10-02). Reason: Aimbot (preview sample).",
      `Monitoring only. ${NO_ACTION} A ban works only while the player is online.`,
    ],
    player: { steamId: "76561198123456781", name: "TeaAndTanks" },
    facts: { source: "Staff watch list", communities: 4, recordedAt: "2026-10-02" },
    links: ["https://example.com/preview-clip"],
    network: {
      source: "wardogs-network",
      sourceName: "Staff watch list",
      communities: 4,
      reasons: ["Aimbot (preview sample)"],
      evidenceUrls: ["https://example.com/preview-clip"],
      recordedAt: "2026-10-02",
      addedBy: "Preview owner",
      knownGood: false,
      presentAtStart: false,
    },
    deliver: true,
  });
  await previewStaffAlerts.send(
    "primary",
    "preview:map-vote-review",
    "The automatic map vote on UNCs Primary needs staff review: The queue result is unconfirmed. Automatic voting on this server is paused until staff close it.",
  );
  if (offline) await previewStaffAlerts.review("primary", offline.id, "legit", { name: "Preview moderator" });
  previewStaffAlerts.snooze("event", "seeding", 240, "Preview moderator");
}
const previewStaffMonitor = {
  status: async (id = "primary"): Promise<StaffAlertsStatus> => {
    const options = staffAlertsOptions(previewEnv);
    const game = id === "primary" ? primaryPreview : eventPreview;
    return {
      serverId: id,
      enabled: options.enabled,
      features: {
        health: options.health.enabled,
        seeding: options.seeding.enabled,
        performance: options.performance.mode,
        watchlist: options.watchlist.enabled,
      },
      channel: await previewStaffAlerts.channelStatus(),
      settings: settingsView(options, previewStaffAlerts.sessionNever().size),
      worker: {
        state: "running",
        lastReadAt: new Date().toISOString(),
        reachable: true,
        failingSince: null,
        failureKind: null,
        players: game.players.length,
        round: { id: "clock:preview", map: "Bakurani", phase: "live" },
        build: "CL-507060",
        lastRestartAt: new Date(Date.now() - 10 * 3_600_000).toISOString(),
        seeding: { lowSince: null, alerted: [] },
        counters: "available",
        trackedPlayers: game.players.length,
        unlinkedPlayers: 1,
        sources: [{ name: "Staff watch list", error: null, at: null }],
      },
      snoozes: previewStaffAlerts.activeSnoozes(id),
      alerts: previewStaffAlerts.list(id),
      peaks: [
        {
          roundKey: "clock:preview#0",
          map: "Bakurani",
          startedAt: new Date(Date.now() - 600_000).toISOString(),
          window: { steamId: "76561198123456789", name: "MossyBoots", kills: 31, minutes: 5 },
          kd: { steamId: "76561198123456780", name: "[UNC] OldManRiver", kills: 16, deaths: 9, kd: 1.8 },
        },
      ],
    };
  },
};
@Global()
@Module({
  providers: [
    {
      provide: EnvService,
      useValue: {
        get: (key: string) => previewEnvironment[key],
      },
    },
  ],
  exports: [EnvService],
})
class PreviewApplicationEnvironment {}

const demoVotes = new Map<string, MapVoteRecord>();
const demoServerEvents = new Map<string, EventRecord>();
const demoEventOperations = new Map<
  string,
  {
    id: string;
    eventId: string;
    actorName: string;
    operation: EventOperation;
    state: string;
    message: string;
    createdAt: Date;
  }
>();
// In-memory rehearsal only. The production store's transactions are covered by isolated PostgreSQL tests.
const eventStore = {
  async get(id: string) {
    return structuredClone(demoServerEvents.get(id) ?? null);
  },
  async current(serverId: string) {
    return structuredClone(
      [...demoServerEvents.values()].find((event) => event.serverId === serverId && event.state !== "complete") ?? null,
    );
  },
  async history(serverId: string) {
    return structuredClone(
      [...demoServerEvents.values()]
        .filter((event) => event.serverId === serverId)
        .reverse()
        .slice(0, 20),
    );
  },
  async operations(id: string) {
    return structuredClone(
      [...demoEventOperations.values()]
        .filter((op) => op.eventId === id)
        .reverse()
        .slice(0, 100),
    );
  },
  async create(input: EventRecord) {
    if (await this.current(input.serverId)) throw new ConflictException("A preview event is already active.");
    const event: EventRecord = {
      ...input,
      operation: null,
      state: "preparing",
      version: 1,
      stop: null,
      restoreRevision: null,
      lastActionId: null,
      message: "Preparing simulated event. No live server is connected.",
    };
    demoServerEvents.set(event.id, event);
    return { created: true, event: structuredClone(event) };
  },
  async observe(id: string, version: number, update: Partial<EventRecord>) {
    const event = demoServerEvents.get(id)!;
    if (event.version !== version || event.operation || event.stop) return false;
    Object.assign(event, update, { version: version + 1, updatedAt: new Date() });
    return true;
  },
  async claim(id: string, version: number, op: EventOperation, staff: Staff, progress: EventProgress, manual = false) {
    const event = demoServerEvents.get(id)!;
    if (
      event.version !== version ||
      event.state === "complete" ||
      demoEventOperations.has(op.id) ||
      (event.operation && !manual) ||
      (event.state === "needs_review" && op.kind !== "restore_lock") ||
      (event.stop && op.kind !== "restore_lock" && op.kind !== "ended")
    )
      return null;
    demoEventOperations.set(op.id, {
      id: op.id,
      eventId: id,
      actorName: staff.name,
      operation: op,
      state: "started",
      message: "Simulated action recorded",
      createdAt: new Date(),
    });
    Object.assign(event, {
      operation: op,
      progress,
      version: version + 1,
      updatedAt: new Date(),
      state: op.kind === "restore_lock" || event.stop ? "stopping" : event.state,
    });
    return structuredClone(event);
  },
  async settle(id: string, opId: string, result: { state: string; message: string }, update: Partial<EventRecord>) {
    Object.assign(demoEventOperations.get(opId)!, result);
    const event = demoServerEvents.get(id)!;
    if (event.operation?.id === opId)
      Object.assign(event, update, {
        state: event.stop && !["complete", "needs_review"].includes(update.state!) ? "stopping" : update.state,
        operation: null,
        lastActionId: opId,
        version: event.version + 1,
        updatedAt: new Date(),
      });
    return structuredClone(event);
  },
  async stop(id: string, stop: EventStop) {
    const event = demoServerEvents.get(id)!;
    if (!event.stop && event.state !== "complete")
      Object.assign(event, {
        stop,
        state: event.state === "needs_review" ? "needs_review" : "stopping",
        version: event.version + 1,
        updatedAt: new Date(),
        message: "Preview stop recorded. Restoration will be checked.",
      });
    return structuredClone(event);
  },
  async completeUnchanged(id: string, version: number) {
    const event = demoServerEvents.get(id)!;
    if (event.version === version && !event.operation && !event.originalLock && event.stop)
      Object.assign(event, {
        state: "complete",
        version: version + 1,
        message: "Preview event stopped. No settings restoration needed.",
      });
    return structuredClone(event);
  },
  async recover() {
    /* Preview effects run in this one in-memory process only. */
  },
  async halt(id: string, reason: string, opId?: string) {
    const event = demoServerEvents.get(id);
    if (!event || ["complete", "needs_review"].includes(event.state)) return null;
    if (opId ? event.operation?.id !== opId : event.operation) return null;
    if (opId) Object.assign(demoEventOperations.get(opId) ?? {}, { state: "unknown", message: "Interrupted." });
    Object.assign(event, {
      stop: event.stop ?? {
        id: randomUUID(),
        actorId: "system:event-halt",
        actorName: "Gramps 50v50 safety stop",
        reason,
        at: new Date().toISOString(),
      },
      state: "stopping",
      operation: null,
      message: `${reason} The team lock is being restored.`,
      version: event.version + 1,
      updatedAt: new Date(),
    });
    return structuredClone(event);
  },
  async completeRestored(id: string, version: number, message: string) {
    const event = demoServerEvents.get(id)!;
    if (event.version === version && !event.operation && event.stop && event.state === "stopping")
      Object.assign(event, { state: "complete", message, version: version + 1, updatedAt: new Date() });
    return structuredClone(event);
  },
};
const demoVotePolicies = new Map<
  string,
  {
    serverId: string;
    version: number;
    policy: import("../src/common/voting-policy").StoredVotingPolicy;
    actorId: string;
    actorName: string;
    connectionHash: string;
  }
>();
const voteStore = {
  async policy(serverId: string) {
    return structuredClone(demoVotePolicies.get(serverId) ?? null);
  },
  async policies() {
    return structuredClone([...demoVotePolicies.values()]);
  },
  async savePolicy(
    serverId: string,
    version: number,
    next:
      | import("../src/common/voting-policy").StoredVotingPolicy
      | ((
          previous: import("../src/common/voting-policy").StoredVotingPolicy | null,
        ) => import("../src/common/voting-policy").StoredVotingPolicy),
    staff: Staff,
    connectionHash: string,
  ) {
    const previous = demoVotePolicies.get(serverId);
    if ((previous?.version ?? 0) !== version)
      throw new ConflictException("Voting controls changed. Reload saved controls.");
    const policy = typeof next === "function" ? next(structuredClone(previous?.policy ?? null)) : next;
    const saved = { serverId, version: version + 1, policy, actorId: staff.id, actorName: staff.name, connectionHash };
    demoVotePolicies.set(serverId, structuredClone(saved));
    const closed: MapVoteRecord[] = [];
    if (!policy.enabled)
      for (const vote of demoVotes.values())
        if (vote.serverId === serverId && vote.automation && vote.state === "open") {
          vote.state = "cancelled";
          vote.message = "Automatic voting switched off.";
          closed.push(structuredClone(vote));
        }
    return { saved, closed };
  },
  async automaticOpen() {
    return structuredClone([...demoVotes.values()].filter((vote) => vote.state === "open" && vote.automation));
  },
  async observeScore(id: string, score: number, step: number | null = null) {
    const vote = demoVotes.get(id);
    if (!vote?.automation || vote.state !== "open" || score < vote.automation.highestScore) return false;
    if (score > vote.automation.highestScore && vote.automation.settings) {
      vote.automation.maxStep = Math.max(vote.automation.maxStep ?? 0, step ?? 0);
      vote.automation.lastScoreAt = new Date().toISOString();
    }
    vote.automation.highestScore = score;
    return true;
  },
  async patchAutomation(
    id: string,
    patch: Partial<import("../src/common/voting-policy").VoteAutomation>,
    states: MapVoteRecord["state"][] = ["open", "closing"],
  ) {
    const vote = demoVotes.get(id);
    if (!vote?.automation || !states.includes(vote.state)) return null;
    Object.assign(vote.automation, structuredClone(patch));
    return structuredClone(vote);
  },
  async resolveReview(
    id: string,
    to: "queued" | "cancelled",
    message: string,
    patch: Partial<import("../src/common/voting-policy").VoteAutomation>,
    messageId?: string,
  ) {
    const vote = demoVotes.get(id);
    if (!vote?.automation || vote.state !== "needs_review") return null;
    Object.assign(vote, { state: to, message, updatedAt: new Date() });
    Object.assign(vote.automation, structuredClone(patch));
    if (messageId && !vote.messageId) vote.messageId = messageId;
    return structuredClone(vote);
  },
  async needsReview() {
    return structuredClone([...demoVotes.values()].filter((vote) => vote.state === "needs_review" && vote.automation));
  },
  async claimReminder(id: string, stage: import("../src/common/voting-policy").VoteReminder, receiptId: string) {
    const vote = demoVotes.get(id);
    if (!vote?.automation || vote.state !== "open" || vote.automation.reminders[stage]) return null;
    vote.automation.reminders[stage] = {
      id: receiptId,
      state: "started",
      message: "Preview only",
      at: new Date().toISOString(),
    };
    return structuredClone(vote);
  },
  async finishReminder(
    id: string,
    stage: import("../src/common/voting-policy").VoteReminder,
    state: string,
    message: string,
  ) {
    const reminder = demoVotes.get(id)?.automation?.reminders[stage];
    if (reminder) Object.assign(reminder, { state, message });
  },
  async checkSetup(serverId: string) {
    return {
      unfinished: [...demoVotes.values()].some(
        (vote) => vote.serverId === serverId && ["publishing", "open", "closing", "needs_review"].includes(vote.state),
      ),
    };
  },
  async liveCounts(ids: string[]) {
    return ids.flatMap((voteId) =>
      (demoVotes.get(voteId)?.counts ?? []).map((total, choice) => ({ voteId, choice, total })),
    );
  },
  async get(id: string) {
    return structuredClone(demoVotes.get(id) ?? null);
  },
  async history(serverId: string) {
    return structuredClone(
      [...demoVotes.values()]
        .filter((vote) => vote.serverId === serverId)
        .reverse()
        .slice(0, 20),
    );
  },
  async create(input: MapVoteRecord) {
    if (
      [...demoVotes.values()].some(
        (vote) =>
          vote.serverId === input.serverId && ["publishing", "open", "closing", "needs_review"].includes(vote.state),
      )
    )
      throw new ConflictException("A preview ballot is already active.");
    const record: MapVoteRecord = {
      ...input,
      state: "publishing",
      messageId: null,
      winner: null,
      cancellation: null,
      message: "Creating simulated ballot.",
    };
    demoVotes.set(record.id, record);
    return { created: true, record: structuredClone(record) };
  },
  async published(id: string) {
    const vote = demoVotes.get(id)!;
    vote.state = "open";
    vote.message = "Simulated ballot opened. Nothing was posted to Discord.";
    return structuredClone(vote);
  },
  async recover() {
    return [];
  },
  async due(now: Date) {
    return structuredClone([...demoVotes.values()].filter((vote) => vote.state === "open" && vote.closesAt <= now));
  },
  async claimClose(id: string, scoreReached = false) {
    const vote = demoVotes.get(id);
    if (!vote || vote.state !== "open") return null;
    if (!scoreReached && vote.closesAt.getTime() > Date.now()) return null;
    if (scoreReached && (!vote.automation || !closeReached(vote.automation, vote.automation.highestScore))) return null;
    vote.state = "closing";
    vote.winner = ballotWinner(
      vote.counts,
      vote.automation ? automationSettings(vote.automation).tieRule : "keep_rotation",
      vote.choices.findIndex((choice) => choice.event === "50v50"),
    );
    return structuredClone(vote);
  },
  async finish(
    id: string,
    state: MapVoteRecord["state"],
    message: string,
    patch?: Partial<import("../src/common/voting-policy").VoteAutomation>,
  ) {
    const vote = demoVotes.get(id)!;
    Object.assign(vote, { state, message });
    if (patch && vote.automation) Object.assign(vote.automation, structuredClone(patch));
    return structuredClone(vote);
  },
  async cancel(id: string, requestId: string, staff: Staff, reason: string) {
    const vote = demoVotes.get(id);
    if (!vote || !["open", "needs_review"].includes(vote.state))
      throw new ConflictException("Preview ballot cannot be closed.");
    vote.cancellation = {
      id: requestId,
      actorId: staff.id,
      actorName: staff.name,
      reason,
      previousState: vote.state,
      previousMessage: vote.message,
      at: new Date().toISOString(),
    };
    vote.state = "cancelled";
    vote.message = "Preview ballot closed. No game changes were reversed.";
    return structuredClone(vote);
  },
};

// ----- Discord roles: a simulated GET /admin/api/discord-roles and reconcile from draft #117 -----
// Nothing here reaches Discord. By default the feature is off (DISCORD_ROLES_ENABLED=false) with the UNC and Founder
// roles ready and the optional Supporter role not set up, so the page reads "Ready to switch on". Set
// PREVIEW_DISCORD_ROLES_ENABLED=true to rehearse a real run against the same sample members.
const previewRolesEnabled = process.env.PREVIEW_DISCORD_ROLES_ENABLED === "true";
type PreviewRoleKind = "member" | "founder" | "supporter";
const previewRoleIds: Record<PreviewRoleKind, string> = {
  member: "600000000000000001",
  founder: "600000000000000002",
  supporter: "600000000000000003",
};
const previewRoleMembers = {
  newUnc: "310000000000000001",
  regular: "310000000000000002",
  rejoined: "310000000000000003",
  founder: "310000000000000004",
  retry: "310000000000000005",
  revoked: "310000000000000006",
  alreadyTagged: "310000000000000007",
  away: "310000000000000008",
  handRemoved: "310000000000000009",
  handGiven: "310000000000000010",
  refused: "310000000000000012",
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const previewRoleCheck = (kind: PreviewRoleKind, name: string, position: number) => ({
  id: previewRoleIds[kind],
  name,
  exists: true,
  position,
  managed: false,
  privileged: false,
  staffRole: false,
  assignable: true,
  problem: null,
});
type PreviewPlanEntry = { discordUserId: string; roleKind: PreviewRoleKind | null; op: string; why: string };
// Changes Gramps would make until a simulated real run applies them: adds and one removal for review.
const previewRoleChanges: PreviewPlanEntry[] = [
  { discordUserId: previewRoleMembers.newUnc, roleKind: "member", op: "add", why: "desired" },
  { discordUserId: previewRoleMembers.regular, roleKind: "member", op: "add", why: "desired" },
  { discordUserId: previewRoleMembers.rejoined, roleKind: "member", op: "add", why: "desired" },
  { discordUserId: previewRoleMembers.founder, roleKind: "founder", op: "add", why: "desired" },
  { discordUserId: previewRoleMembers.retry, roleKind: "member", op: "add", why: "retry-unknown-add" },
  { discordUserId: previewRoleMembers.revoked, roleKind: "member", op: "remove", why: "application-revoked" },
];
// Entries that only note a role or leave it alone.
const previewRoleNotes: PreviewPlanEntry[] = [
  { discordUserId: previewRoleMembers.alreadyTagged, roleKind: "member", op: "note", why: "already-present" },
  { discordUserId: previewRoleMembers.away, roleKind: null, op: "none", why: "not-in-server" },
  { discordUserId: previewRoleMembers.handRemoved, roleKind: "member", op: "none", why: "removed-in-discord" },
  { discordUserId: previewRoleMembers.handGiven, roleKind: "member", op: "none", why: "not-ours" },
];
let previewRolesApplied = false;
let previewRolesRunning = false;
// Like draft #117, real runs and previews are spaced separately: 30 seconds between runs, 5 between previews.
let previewRolesLastRequestAt = 0;
let previewRolesLastPreviewAt = 0;
const previewRoleResults = new Map<string, { fingerprint: string; summary: Record<string, unknown> }>();
const previewLedgerRow = (
  discordUserId: string,
  roleKind: PreviewRoleKind,
  operation: string,
  state: "applied" | "failed" | "unknown",
  message: string,
  createdAt: string,
  trigger = "schedule",
  requestedBy: string | null = null,
) => ({
  id: randomUUID(),
  actorId: "system:discord-roles",
  actorName: "Gramps Discord roles",
  requestedBy,
  trigger,
  guildId: "111111111111111111",
  discordUserId,
  roleKind,
  roleId: previewRoleIds[roleKind],
  operation,
  basisType: roleKind === "member" ? "application" : roleKind,
  basisId: randomUUID(),
  changed: state === "applied" && operation !== "note",
  state,
  message,
  createdAt,
  completedAt: state === "unknown" ? null : createdAt,
});
const previewRoleLedger = [
  previewLedgerRow(
    previewRoleMembers.alreadyTagged,
    "member",
    "note",
    "applied",
    "The role was already present. Gramps did not add it and will not remove it.",
    minutesAgo(95),
  ),
  previewLedgerRow(
    previewRoleMembers.handRemoved,
    "member",
    "note",
    "applied",
    "The role Gramps added was removed in Discord. Gramps will not add it back during this membership, and will not remove it if staff give it back.",
    minutesAgo(180),
  ),
  previewLedgerRow(
    previewRoleMembers.retry,
    "member",
    "add",
    "unknown",
    "Discord did not confirm the change. Gramps will check this member again later.",
    minutesAgo(240),
  ),
  previewLedgerRow("310000000000000011", "founder", "add", "applied", "Role added.", minutesAgo(60 * 26), "event"),
  previewLedgerRow(
    previewRoleMembers.refused,
    "member",
    "add",
    "failed",
    "Discord refused: the bot cannot manage this role. Check Manage Roles and the role order.",
    minutesAgo(60 * 27),
  ),
  previewLedgerRow("310000000000000013", "member", "remove", "applied", "Role removed.", minutesAgo(60 * 50), "event"),
];
const previewRolePass = (
  trigger: string,
  requestedBy: string | null,
  dryRun: boolean,
  startedAt: string,
  counts: Record<string, number> = {},
) => ({
  trigger,
  requestedBy,
  dryRun,
  startedAt,
  finishedAt: new Date(Date.parse(startedAt) + 9_000).toISOString(),
  users: 10,
  added: 0,
  removed: 0,
  noted: 0,
  confirmed: 0,
  failed: 0,
  blocked: 0,
  deferred: 0,
  ...counts,
  error: null,
  attention: [],
});
// While the feature is off no check runs, so there is no pass since startup. Switched on, the sample shows the
// startup check and a later event check.
let previewRolesLastPass: Record<string, unknown> | null = previewRolesEnabled
  ? previewRolePass("event", null, false, minutesAgo(12), { users: 1, added: 1 })
  : null;
let previewRolesLastFullPass: Record<string, unknown> | null = previewRolesEnabled
  ? previewRolePass("startup", null, false, minutesAgo(180), { added: 2, noted: 1, failed: 1 })
  : null;
const previewRolesStatus = () => ({
  enabled: previewRolesEnabled,
  configured: { guild: true, memberRole: true, founderRole: true, supporterRole: false },
  discordReady: true,
  bot: { manageRoles: true, highestRolePosition: 14 },
  roles: {
    member: previewRoleCheck("member", "UNC", 9),
    founder: previewRoleCheck("founder", "Founder", 10),
    supporter: {
      id: null,
      name: null,
      exists: false,
      position: null,
      managed: false,
      privileged: false,
      staffRole: false,
      assignable: false,
      problem:
        "Set DISCORD_SUPPORTER_ROLE_ID to the Supporter role ID (Server Settings, Roles, right-click the role, Copy Role ID).",
      candidates: [{ id: previewRoleIds.supporter, name: "Supporter" }],
    },
  },
  ready: true,
  running: previewRolesRunning,
  lastPass: previewRolesLastPass,
  lastFullPass: previewRolesLastFullPass,
  queued: 0,
  fullPassQueued: false,
  nextRetryAt: previewRolesEnabled && !previewRolesApplied ? new Date(Date.now() + 25 * 60_000).toISOString() : null,
  summary: { memberEligible: 42, founders: 6, foundersWithoutDiscord: 2, supporterEligible: null },
  // Every kind of item, so each can be reviewed. Founders come from supporter records, the rest from earlier checks.
  attention: [
    {
      kind: "founder_without_discord",
      supporterId: randomUUID(),
      displayName: "Grandpa Joe",
      provider: "paypal",
      at: minutesAgo(60 * 30),
    },
    {
      kind: "founder_without_discord",
      supporterId: randomUUID(),
      displayName: null,
      provider: "patreon",
      at: minutesAgo(60 * 20),
    },
    { kind: "not_in_server", discordUserId: previewRoleMembers.away, at: minutesAgo(180) },
    {
      kind: "removed_in_discord",
      discordUserId: previewRoleMembers.handRemoved,
      roleKind: "member",
      basisId: randomUUID(),
      at: minutesAgo(180),
    },
    {
      kind: "failed",
      discordUserId: previewRoleMembers.refused,
      roleKind: "member",
      basisId: randomUUID(),
      at: minutesAgo(60 * 27),
    },
  ],
  recent: previewRoleLedger.slice(0, 25),
  note: "Gramps adds the UNC role for approved UNC member applications and the Founder role for founders with a linked Discord account, and removes only roles it added itself. Local preview: sample data only.",
});
const previewReconcileSchema = z
  .object({
    id: z.uuid(),
    reason: z.string().trim().min(3).max(200),
    discordUserId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Simulated roles API with draft #117's switch, run and preview spacing, running and repeated-ID rules. */
@Controller("admin/api/discord-roles")
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminGuard)
class PreviewDiscordRolesController {
  // Like draft #117, the guard admits every staff member and the roles API itself requires an administrator.
  private requireAdmin(req: StaffRequest) {
    if (req.staff.role !== "admin") throw new ForbiddenException("Only administrators can manage Discord roles.");
  }
  @Get()
  status(@Req() req: StaffRequest) {
    this.requireAdmin(req);
    return previewRolesStatus();
  }
  @Post("reconcile")
  async reconcile(@Req() req: StaffRequest, @Body() body: unknown) {
    this.requireAdmin(req);
    const parsed = previewReconcileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Send an action ID, a reason and an optional Discord user ID.");
    const input = parsed.data;
    const fingerprint = JSON.stringify(input);
    const previous = previewRoleResults.get(input.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ConflictException("This action ID was already used for another role check.");
      return { ok: true, replayed: true, summary: previous.summary };
    }
    if (!input.dryRun && !previewRolesEnabled)
      throw new ServiceUnavailableException("Discord roles are switched off (DISCORD_ROLES_ENABLED=false).");
    if (previewRolesRunning)
      throw new ConflictException("A role check is already running. Try again when it finishes.");
    if (input.dryRun) {
      if (Date.now() - previewRolesLastPreviewAt < 5_000)
        throw new HttpException("Wait 5 seconds between previews.", 429);
      previewRolesLastPreviewAt = Date.now();
    } else {
      if (Date.now() - previewRolesLastRequestAt < 30_000)
        throw new HttpException("Wait 30 seconds between role checks.", 429);
      previewRolesLastRequestAt = Date.now();
    }
    const startedAt = new Date().toISOString();
    const only = (entries: PreviewPlanEntry[]) =>
      input.discordUserId ? entries.filter((entry) => entry.discordUserId === input.discordUserId) : entries;
    const changes = previewRolesApplied ? [] : only(previewRoleChanges);
    let summary: Record<string, unknown>;
    if (input.dryRun) {
      const plan = [...changes, ...only(previewRoleNotes)];
      summary = {
        ...previewRolePass("admin", req.staff.id, true, startedAt, { users: plan.length }),
        reason: input.reason,
        plan,
      };
    } else {
      // A simulated real run: a short wait, then the planned changes are recorded as applied. Discord is never called.
      previewRolesRunning = true;
      await new Promise((done) => setTimeout(done, 1_500));
      previewRolesRunning = false;
      const at = new Date().toISOString();
      for (const change of changes)
        previewRoleLedger.unshift(
          previewLedgerRow(
            change.discordUserId,
            change.roleKind!,
            change.op,
            "applied",
            change.op === "add" ? "Role added." : "Role removed.",
            at,
            "admin",
            req.staff.id,
          ),
        );
      previewRolesApplied = true;
      summary = {
        ...previewRolePass("admin", req.staff.id, false, startedAt, {
          added: changes.filter((change) => change.op === "add").length,
          removed: changes.filter((change) => change.op === "remove").length,
        }),
        reason: input.reason,
      };
      previewRolesLastPass = summary;
      if (!input.discordUserId) previewRolesLastFullPass = summary;
    }
    previewRoleResults.set(input.id, { fingerprint, summary });
    return { ok: true, replayed: false, summary };
  }
}

/**
 * Serves the dashboard shell when /admin/discord-roles is reloaded in this preview. Production needs the same path
 * in AdminPageController's list.
 */
@Controller("admin")
class PreviewDiscordRolesPage {
  private readonly logger = new Logger(PreviewDiscordRolesPage.name);
  @Get("discord-roles")
  page(@Res() res: Response) {
    res.sendFile(join(process.cwd(), "dist", "src", "admin", "public", "index.html"), (error?: Error) => {
      if (!error || res.headersSent) return;
      this.logger.error("The preview dashboard page could not be sent.");
      res.status(503).json({ message: "The dashboard is unavailable." });
    });
  }
}

async function main() {
  // ServeStaticModule selects its loader during dependency creation, so the test
  // application must provide its adapter before compiling the isolated preview.
  const adapter = new ExpressAdapter();
  const adapterHost = new HttpAdapterHost();
  adapterHost.httpAdapter = adapter;
  await seedPreviewStaffAlerts();
  const module = await Test.createTestingModule({
    controllers: [
      ServerCommunityController,
      StaffAlertsController,
      PreviewDiscordRolesController,
      PreviewDiscordRolesPage,
    ],
    providers: [
      { provide: StaffAlerts, useValue: previewStaffAlerts },
      { provide: StaffAlertsMonitor, useValue: previewStaffMonitor },
      {
        provide: ServerCommunityService,
        useValue: {
          status: (id: string): CommunityMessagesStatus => ({
            enabled: id === "primary",
            workerStarted: id === "primary",
            lastObservedAt: id === "primary" ? new Date().toISOString() : null,
            lastMessageAcknowledgedAt: null,
            lastStatusCardUpdatedAt: null,
            welcome: {
              enabled: id === "primary",
              messages: [
                "Welcome to The UNCs! Website: theuncsgaming.com",
                "Get whitelisted: theuncsgaming.com/whitelist. Sign in with Discord and apply on the website.",
              ],
              variants: [
                [
                  "Welcome to The UNCs! Website: theuncsgaming.com",
                  "Get whitelisted: theuncsgaming.com/whitelist. Sign in with Discord and apply on the website.",
                ],
                [
                  "Pull up a chair, the coffee's fresh. Welcome to The UNCs.",
                  "The whitelist is free: theuncsgaming.com/whitelist.",
                ],
                ["Welcome in! Be kind to the new guys, we were all new once."],
              ],
              whitelistedVariants: [
                ["Welcome back! Good to see a regular."],
                ["The usual table is ready. Welcome back to The UNCs."],
              ],
              whitelist: {
                source: "running-whitelist",
                cacheSeconds: 300,
                lastLoadedAt: id === "primary" ? new Date(Date.now() - 3 * 60_000).toISOString() : null,
                lastFailedAt: null,
              },
              delaySeconds: 10,
              spacingSeconds: 20,
            },
            round: {
              enabled: false,
              message: "GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.",
              messages: [
                "GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.",
                "Round's done. Stretch those knees and grab a refill.",
                "GG! Same time next round?",
              ],
            },
            discordStatus: { enabled: false, configured: false, problem: null },
          }),
        },
      },
    ],
    imports: [
      PreviewApplicationEnvironment,
      AdminModule,
      ApplicationsModule,
      TelemModule,
      SupportersModule,
      MapVotesModule,
      ServerEventsModule,
    ],
  })
    .overrideProvider(HttpAdapterHost)
    .useValue(adapterHost)
    .overrideProvider(AdminSettings)
    .useValue(settings)
    .overrideProvider(AdminStore)
    .useValue(store)
    .overrideProvider(AdminAuth)
    .useValue(auth)
    .overrideProvider(GameServers)
    .useValue(gameServers)
    .overrideProvider(ApplicationsStore)
    .useValue(applicationStore)
    .overrideProvider(ApplicantAuth)
    .useValue(applicantAuth)
    .overrideProvider(TelemetryStore)
    .useValue(telemetryStore)
    .overrideProvider(SupportersStore)
    .useValue(supporterStore)
    // No database: automatic supporter matching stays off and reports nothing.
    .overrideProvider(SupporterMatchStore)
    .useValue({})
    .overrideProvider(SupporterMatchService)
    .useValue({
      status: () => ({
        steamFill: false,
        founderAuto: false,
        holdHours: 72,
        configured: false,
        running: false,
        lastRunAt: null,
        lastTrigger: null,
        lastError: null,
        checked: 0,
        steamFilled: 0,
        foundersRecorded: 0,
        blocked: {},
        capped: false,
      }),
      sweep: async () => undefined,
      member: async () => null,
      applicationChanged: async () => undefined,
    })
    .overrideProvider(PatreonSyncService)
    .useValue(patreonSync)
    .overrideProvider(MapVotesStore)
    .useValue(voteStore)
    .overrideProvider(ServerEventsStore)
    .useValue(eventStore)
    // No Discord client or database: the roles page reports Discord as not connected.
    .overrideProvider(DiscordRolesDiscord)
    .useValue({ ready: () => false })
    .overrideProvider(DiscordRolesStore)
    .useValue({
      summary: async () => ({ memberEligible: 0, founders: 1, foundersWithoutDiscord: 0 }),
      foundersWithoutDiscord: async () => [],
      recent: async () => [],
    })
    .overrideProvider(MapVotesDiscord)
    .useValue({
      check: async () => ({ name: "simulated-voting" }),
      publish: async () => "333333333333333333",
      findBallotMessage: async () => null,
      update: async () => undefined,
      remind: async () => undefined,
    })
    // Map-vote and 50v50 automation alerts land in the same simulated staff channel and Staff alerts status.
    .overrideProvider(StaffAlerts)
    .useValue(previewStaffAlerts)
    .compile();
  const app = module.createNestApplication(adapter, { rawBody: true });
  await app.listen(previewPort, "127.0.0.1");
  console.info(
    `Gramps local preview: http://127.0.0.1:${previewPort}/admin (simulated game, no credentials, no database)`,
  );
}
void main();
