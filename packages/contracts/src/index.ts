import { z } from "zod";

export const discordId = z.string().regex(/^\d{17,20}$/);
export const interactionContext = z
  .object({
    interactionId: discordId,
    userId: discordId,
    guildId: discordId,
    channelId: discordId.nullable(),
    serverId: z.string().min(1).max(100).optional(),
  })
  .strict();
export type InteractionContext = z.infer<typeof interactionContext>;
export const welcomeSettings = z.object({ enabled: z.boolean(), message: z.string().max(12000) }).strict();
export const memberRequest = z.object({ guildId: discordId, userId: discordId }).strict();
export const memberView = z
  .object({
    id: discordId,
    joinedAt: z.iso.datetime().nullable(),
    roles: z.array(discordId),
    pending: z.boolean(),
    bot: z.boolean(),
  })
  .strict()
  .nullable();
export const roleChange = memberRequest
  .extend({ roleId: discordId, reason: z.string().min(1).max(512), operationId: z.string().min(1).max(200) })
  .strict();
export const roleCheckRequest = z
  .object({
    guildId: discordId,
    roleIds: z
      .object({ member: discordId.optional(), founder: discordId.optional(), supporter: discordId.optional() })
      .strict(),
    staffRoleIds: z.array(discordId),
    seederRoleId: discordId.nullable().optional(),
  })
  .strict();
const roleView = z
  .object({
    id: discordId.nullable(),
    name: z.string().nullable(),
    exists: z.boolean(),
    position: z.number().nullable(),
    managed: z.boolean(),
    privileged: z.boolean(),
    staffRole: z.boolean(),
    assignable: z.boolean(),
    problem: z.string().nullable(),
    candidates: z.array(z.object({ id: discordId, name: z.string() }).strict()).optional(),
  })
  .strict();
export const rolesCheck = z
  .object({
    manageRoles: z.boolean(),
    highestRolePosition: z.number(),
    roles: z.object({ member: roleView, founder: roleView, supporter: roleView }).strict(),
  })
  .strict();
export const channelRequest = z.object({ guildId: discordId, channelId: discordId }).strict();
export const channelView = z.object({ name: z.string() }).strict();
export const acknowledged = z.object({ ok: z.literal(true) }).strict();
export const readiness = z.object({ status: z.enum(["ready", "passive"]), gateway: z.boolean().optional() }).strict();
/** Transport JSON only: application-specific contracts extend this at each feature boundary. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]),
);
export const internalError = z
  .object({
    message: z.string(),
    outcome: z.enum(["rejected", "unknown"]).optional(),
    reason: z.string().optional(),
    settled: z.boolean().optional(),
  })
  .strict();
export const mapSelection = z
  .object({
    map: z.string().min(1).max(200),
    experiences: z.array(z.string().max(200)).max(10),
    lighting: z.string().max(200).optional(),
    zoneAlternator: z.string().max(200).optional(),
    event: z.literal("50v50").optional(),
  })
  .strict();
export const ballot = z
  .object({
    id: z.uuid(),
    serverId: z.string(),
    serverName: z.string(),
    connectionHash: z.string(),
    guildId: discordId,
    channelId: discordId,
    messageId: discordId.nullable(),
    actorId: z.string(),
    actorName: z.string(),
    reason: z.string(),
    requestHash: z.string(),
    choices: z.array(mapSelection).min(2).max(5),
    revision: z.string(),
    currentMap: z.string(),
    currentIndex: z.number().int(),
    roundStartedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    closesAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: z.enum(["publishing", "open", "closing", "queued", "no_votes", "tied", "cancelled", "needs_review"]),
    winner: z.number().int().nullable(),
    counts: z.array(z.number().int().nonnegative()),
    message: z.string(),
    cancellation: json.nullable(),
    automation: json.nullable().optional(),
  })
  .strict();
export const ballotRequest = z.object({ vote: ballot, operationId: z.string().min(1).max(200) }).strict();
export const reminderRequest = ballotRequest.extend({ stage: z.enum(["midpoint", "final"]) }).strict();
export const messageId = discordId;
export const weeklyPostedRequest = channelRequest
  .extend({ slot: z.number().int(), weekKey: z.string().max(100), serverId: z.string().max(100) })
  .strict();
export const weeklySendRequest = channelRequest
  .extend({
    payload: z
      .object({
        content: z.string().max(2000),
        flags: z.literal(4),
        allowedMentions: z
          .object({
            parse: z.array(z.never()),
            users: z.array(z.never()),
            roles: z.array(z.never()),
            repliedUser: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    nonce: z.string().min(1).max(25),
    operationId: z.string().min(1).max(200),
  })
  .strict();
export const weeklySendResult = z.union([
  z.object({ outcome: z.literal("posted"), messageId: discordId }).strict(),
  z.object({ outcome: z.enum(["failed", "unknown"]) }).strict(),
]);
export const staffPolicy = z
  .object({
    ownerIds: z.array(discordId),
    adminRoleIds: z.array(discordId),
    moderatorRoleIds: z.array(discordId),
    viewerRoleIds: z.array(discordId),
  })
  .strict();
export const gameSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    joinId: z.string().nullable().optional(),
    players: z.object({ current: z.number().int().nonnegative(), max: z.number().int().positive() }).nullable(),
  })
  .strict()
  .nullable();
export const seedingContext = z.object({ policy: staffPolicy, server: gameSummary }).strict();
export const voteCastRequest = z
  .object({ context: interactionContext, id: z.uuid(), choice: z.string().regex(/^[0-4]$/), messageId: discordId })
  .strict();
export const voteCastResult = z.object({ selection: mapSelection, closeAtScore: z.number().nullable() }).strict();
export const welcomeWrite = z
  .object({
    context: interactionContext,
    enabled: z.boolean().optional(),
    message: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .refine((value) => (value.enabled !== undefined) !== (value.message !== undefined));
export const patronReply = z.object({ content: z.string().max(4000), url: z.url().optional() }).strict();
export const panelRequest = channelRequest.extend({ operationId: z.string().min(1).max(200) }).strict();
export const alertDisplay = z
  .object({
    id: z.string().max(100),
    serverName: z.string().max(100),
    severity: z.enum(["info", "warning", "high"]),
    title: z.string().max(100),
    lines: z.array(z.string().max(1000)).max(30),
    player: z.object({ steamId: z.string(), name: z.string() }).strict().nullable(),
    fields: z.array(z.tuple([z.string(), z.string()])).max(4),
    links: z.array(z.url()).max(3),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type AlertDisplay = z.infer<typeof alertDisplay>;
export const alertChannelState = z.enum([
  "ok",
  "missing",
  "wrong-guild",
  "not-text",
  "public",
  "missing-permissions",
  "community-channel",
  "discord-offline",
]);
export const alertPingState = z.enum(["off", "ok", "invalid", "not-mentionable"]);
export const alertChannel = z
  .object({ state: alertChannelState, channelId: discordId.nullable(), ping: alertPingState })
  .strict();
export const alertSendRequest = z
  .object({ record: alertDisplay, ping: z.boolean(), operationId: z.string().min(1).max(200) })
  .strict();
export const alertEditRequest = z
  .object({
    record: alertDisplay,
    messageId: discordId,
    note: z.string().max(300),
    operationId: z.string().min(1).max(200),
  })
  .strict();
export const communitySnapshot = z.object({
  observedAt: z.iso.datetime(),
  status: z.object({
    serverName: z.string(),
    map: z.string(),
    players: z.object({ current: z.number(), max: z.number() }),
    factionScores: z.array(z.object({ name: z.string(), score: z.number() })),
    matchSeconds: z.number().nullable().optional(),
  }),
});
export const communityEditRequest = channelRequest
  .extend({
    messageId: discordId,
    snapshot: communitySnapshot.nullable(),
    online: z.boolean(),
    operationId: z.string().min(1).max(200),
  })
  .strict();
const weeklyPerson = z.object({ steamId: z.string().max(30), name: z.string().max(500) });
const count = z.number().int().nonnegative();
export const weeklyRenderRequest = z
  .object({
    serverId: z.string().min(1).max(100),
    serverName: z.string().max(200),
    showServerName: z.boolean(),
    slot: z.number().int(),
    window: z
      .object({
        weekKey: z.string(),
        start: z.iso.datetime(),
        end: z.iso.datetime(),
        since: z.iso.datetime(),
        until: z.iso.datetime(),
      })
      .strict(),
    trackingStartedAt: z.iso.datetime().nullable(),
    rows: z
      .array(
        weeklyPerson.extend({ kills: count, deaths: count, headshotKills: count, kd: z.number().nullable() }).strict(),
      )
      .max(1000),
    highlights: z
      .object({
        bestKd: weeklyPerson.extend({ kills: count, deaths: count }).strict().nullable(),
        mostHeadshots: weeklyPerson.extend({ headshotKills: count }).strict().nullable(),
        longestKill: weeklyPerson
          .extend({ distanceCentimeters: z.number(), cause: z.string().nullable(), mapName: z.string().nullable() })
          .strict()
          .nullable(),
        kills: count,
        killsWithCause: count,
        topCause: z.object({ cause: z.string(), kills: count }).strict().nullable(),
        maps: z.array(z.object({ mapName: z.string(), kills: count }).strict()).max(50),
      })
      .strict(),
  })
  .strict();
export const weeklyMessage = weeklySendRequest.shape.payload;
