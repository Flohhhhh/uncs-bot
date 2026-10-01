/** Local-only visual preview. Never imported by AppModule or enabled by a production flag. */
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { ConflictException, ForbiddenException, Global, Module, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { AdminModule } from "../src/admin/admin.module";
import { AdminAuth } from "../src/admin/admin.auth";
import { AdminSettings } from "../src/admin/admin.settings";
import { AdminStore } from "../src/admin/admin.store";
import { WardogsClient } from "../src/admin/wardogs.client";
import { configuredWhitelist } from "../src/admin/whitelist-document";
import { settingFields, SESSION, ROTATION } from "../src/common/server-settings";
import { scalarValue } from "../src/admin/config-document";
import { parseRotation, auditAction } from "../src/admin/server-configuration";
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
import { SupportersStore } from "../src/supporters/supporters.store";
import { MapVotesModule } from "../src/map-votes/map-votes.module";
import { MapVotesStore } from "../src/map-votes/map-votes.store";
import { MapVotesDiscord } from "../src/map-votes/map-votes.discord";
import type { MapVoteRecord } from "../src/map-votes/map-votes.types";
import type {
  FounderPolicy,
  ManualMemberInput,
  PaymentView,
  SupporterMutation,
  SupporterView,
} from "../src/supporters/supporters.types";

const previewPort = Number(process.env.PREVIEW_PORT || 4317);
const previewRoundStart = Date.now() - 600_000;

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
  serverName: "The UNCs | Local event preview",
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
          ...["Lonestar", "Kavkazi", "Europe"].map(
            (map) => `+RotationEntries=(Map="${map}",Experiences="",Lighting="DayClear")`,
          ),
        );
      return `[${section}]\n${values.join("\n")}\n`;
    })
    .join("\n") + "[WDServerFeed]\nUrl=http://127.0.0.1:32190\n";
let revision = 1,
  currentMap = "Lonestar",
  lighting = "DayClear";
const routes = [
  "GET /v1/status",
  "GET /v1/players",
  "GET /v1/bans",
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
  "GET /v1/rotation",
];
const settings = { get: () => ({}) } as AdminSettings;
class PreviewGame extends WardogsClient {
  override async request(method: string, path: string, body?: any, expectedRevision?: string) {
    if (path === "/v1/capabilities")
      return { routes, build: "LOCAL PREVIEW · SAMPLE DATA", config: { writable: true } };
    if (path === "/v1/status")
      return {
        serverName: scalarValue(text, SESSION, "ServerName") || "Local preview",
        map: currentMap,
        matchSeconds: (Date.now() - previewRoundStart) / 1000,
        lighting,
        experiences: ["King of the Hill"],
        scoreTick: { current: 24, min: 18, max: 30 },
        rotation: { nowIndex: 0, nextIndex: 1 },
        players: { current: players.length, max: 100 },
        factionScores: factions.map(({ name, colorHex, score }) => ({ name, colorHex, score })),
      };
    if (path === "/v1/players") return { players };
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
      return { maps: ["Lonestar", "Kavkazi", "Europe", "NorthAmerica"].map((id) => ({ id, displayName: id })) };
    if (path === "/v1/catalog/lightings")
      return { lightings: ["DayClear", "DayEarlyFog", "DayLateClear"].map((id) => ({ id })) };
    if (path === "/v1/catalog/experiences")
      return { experiences: ["KOTH_InfantryOnly", "KOTH_Hardcore"].map((id) => ({ id })) };
    if (path === "/v1/rotation")
      return {
        enabled: true,
        mode: "ordered",
        entries: parseRotation(text).map((entry, index) => ({
          ...entry,
          index,
          lighting: "DayClear",
          status: index === 0 ? "now" : index === 1 ? "next" : null,
        })),
      };
    if (path === "/v1/match/map") currentMap = body.map;
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
  async history() {
    return [...records.values()].reverse().slice(0, 100);
  },
  async receipt(id: string) {
    const record = records.get(id);
    if (!record) return null;
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
        (entry) => entry.discordUserId === input.discordUserId || entry.steamId === input.steamId,
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
      ...input,
    } as WhitelistApplication;
    applications.set(entry.id, entry);
    return entry;
  },
  async own(userId: string) {
    return [...applications.values()].find((entry) => entry.discordUserId === userId);
  },
  async list() {
    return [...applications.values()].reverse();
  },
  async claim(id: string, review: ApplicationReview, kind: "approve" | "decline" | "recheck", staff: Staff) {
    const entry = applications.get(id);
    if (!entry || entry.status !== (kind === "recheck" ? "needs_review" : "pending"))
      return { claimed: false, application: entry };
    Object.assign(entry, {
      status: kind !== "decline" ? "processing" : "declined",
      reviewedAt: new Date(),
      reviewedBy: staff.id,
      reviewReason: review.reason,
      actionId: kind === "recheck" ? entry.actionId : review.id,
      reviewId: review.id,
      reviewKind: kind,
      lastActionState: kind !== "decline" ? "started" : "applied",
      lastActionMessage: kind !== "decline" ? "Review started." : "Application declined. No whitelist change was sent.",
      updatedAt: new Date(),
    });
    return { claimed: true, application: entry };
  },
  async finishApproval(id: string, actionId: string, result: ActionResult) {
    const entry = applications.get(id);
    if (!entry || entry.status !== "processing" || entry.reviewId !== actionId)
      throw new Error("Preview application changed");
    Object.assign(entry, {
      status: result.state === "applied" ? "approved" : "needs_review",
      lastActionState: result.state,
      lastActionMessage: result.message,
      updatedAt: new Date(),
    });
    return entry;
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
const filteredDemoEvents = (since: Date, until: Date, playerId?: string) =>
  demoEvents.filter(
    (entry) =>
      entry.receivedAt >= since &&
      entry.receivedAt <= until &&
      (!playerId || entry.killerSteamId === playerId || entry.victimSteamId === playerId),
  );
const telemetryStore = {
  async ingest() {
    throw new Error("Live event intake is unavailable in the simulated preview.");
  },
  async tracking() {
    return {
      firstReceivedAt: new Date(Math.min(...demoEvents.map((event) => event.receivedAt.getTime()))),
      lastReceivedAt: new Date(Math.max(...demoEvents.map((event) => event.receivedAt.getTime()))),
    };
  },
  async snapshot(since: Date, until: Date, playerId?: string) {
    const events = filteredDemoEvents(since, until, playerId);
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
  async events(since: Date, until: Date, playerId?: string) {
    return filteredDemoEvents(since, until, playerId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, 100);
  },
};
// Fictional supporter evidence stays in memory. No Patreon credentials or calls.
const demoSupporters = new Map<string, SupporterView>();
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
  };
  demoPaymentReferences.add(payment.reference.toLowerCase());
  demoSupporters.set(id, {
    id,
    patreonMemberId: `preview-member-${index + 1}`,
    displayName,
    patronStatus: index === 1 ? "former_patron" : "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: paidAt,
    observedAt: new Date().toISOString(),
    reviewState: index === 1 ? "verified" : "pending",
    discordId: index === 2 ? null : `88888888888888888${index + 1}`,
    steamId: index === 2 ? null : `7656119800000000${index + 1}`,
    identityState: index === 2 ? "unlinked" : "staff_linked",
    version: 1,
    latestPayment: payment,
    founderEligiblePayment: null,
    founder: index === 1 ? { awardedAt: paidAt, paymentId: payment.id } : null,
  });
}
const supporterStore = {
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
      patreonMemberId: input.patreonMemberId,
      displayName: input.displayName,
      patronStatus: null,
      lastChargeStatus: null,
      lastChargeAt: null,
      observedAt: new Date().toISOString(),
      reviewState: "unverified",
      discordId: null,
      steamId: null,
      identityState: "unlinked",
      version: 1,
      latestPayment: null,
      founderEligiblePayment: null,
      founder: null,
    };
    demoSupporters.set(record.id, record);
    demoSupporterActions.set(input.id, fingerprint);
    const [supporter] = await this.list(campaignId, policy, record.id);
    return { ok: true, replayed: false, supporter };
  },
  async list(_campaignId: string, _policy: FounderPolicy, memberId?: string, search = "") {
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
  async mutate(memberId: string, input: SupporterMutation, staff: Staff, campaignId: string, policy: FounderPolicy) {
    const record = demoSupporters.get(memberId);
    if (!record) throw new ConflictException("Preview supporter not found.");
    const fingerprint = JSON.stringify({ memberId, input, staff: staff.id });
    const previous = demoSupporterActions.get(input.id);
    if (previous) {
      if (previous !== fingerprint) throw new ConflictException("Preview review ID was already used.");
      return { ok: true, replayed: true, supporter: structuredClone(record) };
    }
    if (record.version !== input.version || record.patreonMemberId !== input.confirm)
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
      record.founder = { awardedAt: new Date().toISOString(), paymentId: input.paymentId };
    }
    if (input.kind === "link") {
      if (
        [...demoSupporters.values()].some(
          (other) => other.id !== memberId && (other.discordId === input.discordId || other.steamId === input.steamId),
        )
      )
        throw new ConflictException("This preview account is already linked.");
      record.discordId = input.discordId;
      record.steamId = input.steamId;
      record.identityState = "staff_linked";
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
      };
    }
    if (input.kind === "review") record.reviewState = "verified";
    record.version++;
    demoSupporterActions.set(input.id, fingerprint);
    return { ok: true, replayed: false, supporter: structuredClone(record) };
  },
};
const previewEnvironment: Record<string, unknown> = {
  MAP_VOTES_ENABLED: true,
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
const voteStore = {
  async get(id: string) {
    return structuredClone(demoVotes.get(id) ?? null);
  },
  async history() {
    return structuredClone([...demoVotes.values()].reverse().slice(0, 20));
  },
  async create(input: MapVoteRecord) {
    if ([...demoVotes.values()].some((vote) => ["publishing", "open", "closing", "needs_review"].includes(vote.state)))
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
  async claimClose(id: string) {
    const vote = demoVotes.get(id);
    if (!vote || vote.state !== "open") return null;
    vote.state = "closing";
    return structuredClone(vote);
  },
  async finish(id: string, state: MapVoteRecord["state"], message: string) {
    const vote = demoVotes.get(id)!;
    Object.assign(vote, { state, message });
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

async function main() {
  // ServeStaticModule selects its loader during dependency creation, so the test
  // application must provide its adapter before compiling the isolated preview.
  const adapter = new ExpressAdapter();
  const adapterHost = new HttpAdapterHost();
  adapterHost.httpAdapter = adapter;
  const module = await Test.createTestingModule({
    imports: [
      PreviewApplicationEnvironment,
      AdminModule,
      ApplicationsModule,
      TelemModule,
      SupportersModule,
      MapVotesModule,
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
    .overrideProvider(WardogsClient)
    .useValue(new PreviewGame(settings))
    .overrideProvider(ApplicationsStore)
    .useValue(applicationStore)
    .overrideProvider(ApplicantAuth)
    .useValue(applicantAuth)
    .overrideProvider(TelemetryStore)
    .useValue(telemetryStore)
    .overrideProvider(SupportersStore)
    .useValue(supporterStore)
    .overrideProvider(MapVotesStore)
    .useValue(voteStore)
    .overrideProvider(MapVotesDiscord)
    .useValue({
      check: async () => undefined,
      publish: async () => "333333333333333333",
      update: async () => undefined,
    })
    .compile();
  const app = module.createNestApplication(adapter, { rawBody: true });
  await app.listen(previewPort, "127.0.0.1");
  console.info(
    `Gramps local preview: http://127.0.0.1:${previewPort}/admin (simulated game, no credentials, no database)`,
  );
}
void main();
