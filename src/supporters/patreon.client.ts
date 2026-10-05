import { Injectable } from "@nestjs/common";
import { z } from "zod";

/**
 * Authenticated, read-only pull of the configured campaign's members from Patreon API v2.
 * Docs: https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id-members (endpoint, includes,
 * page size), #member, #pledge-event and #user-v2 (attributes), #pagination ("More Data, Pagination":
 * cursor-based `page[count]`/`page[cursor]`, next cursor in `meta.pagination.cursors.next`),
 * #rate-limits (100 requests per minute per access token) and #errors. Tier prices come from
 * #get-api-oauth2-v2-campaigns-campaign_id (`include=tiers`) and #tier (`amount_cents`, documented as US cents);
 * a pledge event names its tier in `tier_id`.
 */
export const PATREON_API_ORIGIN = "https://www.patreon.com";
/** Fewer members per page keeps each member's included pledge history from being cut short. */
export const PATREON_PAGE_COUNT = 50;
export const PATREON_MAX_PAGES = 100;
export const PATREON_MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const PATREON_MAX_TIERS_BYTES = 1024 * 1024;
export const PATREON_REQUEST_TIMEOUT_MS = 20_000;
/** Paces multi-page reads under Patreon's 100 requests per minute per access token. */
export const PATREON_PAGE_DELAY_MS = 700;
/**
 * Patreon cuts included pledge history to roughly the latest ~100 events when many members are
 * requested. A history at or above this length is treated as possibly incomplete.
 */
export const PATREON_HISTORY_CAP = 100;
export const PATREON_USER_AGENT = "UNCs-Gramps-Bot/1.0 (private supporter ledger sync; +https://theuncsgaming.com)";
/** Patreon documents a tier's `amount_cents` in US cents, whatever currency the patron pays in. */
export const PATREON_TIER_CURRENCY = "USD";
/** The pledge-event fields the import has always asked for, and the same list with each event's tier. */
const PLEDGE_EVENT_FIELDS = "amount_cents,currency_code,date,payment_status,type";
const PLEDGE_EVENT_FIELDS_WITH_TIER = `${PLEDGE_EVENT_FIELDS},tier_id`;
const FUTURE_TOLERANCE_MS = 300_000;

export type PatreonPledgeEvent = {
  id: string;
  date: Date;
  amountCents: number | null;
  currency: string | null;
  paymentStatus: string | null;
  type: string | null;
  /**
   * The tier this event paid for, and that tier's price in US cents. Each is set only when Patreon reported it.
   * Neither is part of the snapshot hash, so learning them never sends a record back to review.
   */
  tierId?: string;
  tierAmountCents?: number;
};
/**
 * Whether one sync learned the campaign's tier prices: `read`; `not_requested` (no paid event in another currency
 * named a tier, so there was nothing to price); `unavailable` (the tier request failed or could not be read); or
 * `refused` (the member request that asks for each event's tier did not work, so the sync ran without it).
 */
export type PatreonTierPrices = "read" | "not_requested" | "unavailable" | "refused";
export type PatreonMembersResult = {
  members: PatreonMemberSnapshot[];
  complete: boolean;
  tierPrices: PatreonTierPrices;
  /** Patreon rate-limited the tier request and asked for this wait before the next request. */
  retryAfterMs?: number;
};
export type PatreonMemberSnapshot = {
  patreonMemberId: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: Date | null;
  /** Discord account the patron connected on Patreon, when the campaign's Discord benefit exposes it. */
  discordId: string | null;
  /**
   * Whether Patreon's answer about Discord was read: true when the patron's connections parsed and either name a
   * valid Discord account or have none. False when the user or their connections were missing or malformed, so a
   * null `discordId` then means "unknown", not "disconnected".
   */
  discordKnown: boolean;
  events: PatreonPledgeEvent[];
  /** False when the returned pledge history may be incomplete; the first payment is then not derived. */
  historyComplete: boolean;
};
export type PatreonErrorKind = "token" | "campaign" | "rate" | "unavailable" | "schema";

/** Messages are fixed text. They never include the token, response bodies or headers. */
export class PatreonApiError extends Error {
  constructor(
    readonly kind: PatreonErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PatreonApiError";
  }
}
export const PATREON_TOKEN_REJECTED =
  "Patreon rejected the Creator's Access Token. Renew it on the Patreon client page (patreon.com/portal/registration/register-clients), update PATREON_CREATOR_ACCESS_TOKEN in Railway, and confirm PATREON_CAMPAIGN_ID belongs to that creator.";
const CAMPAIGN_NOT_FOUND =
  "Patreon did not find PATREON_CAMPAIGN_ID for this token. Check the campaign ID. Existing supporter records were kept.";
const UNAVAILABLE = "Patreon could not be reached. Existing supporter records were kept; the next sync will retry.";
const UNEXPECTED = "Patreon returned an unexpected member list. Nothing was imported; the next sync will retry.";
const TOO_LARGE = "Patreon returned a larger response than expected. Nothing was imported; the next sync will retry.";

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine((value) =>
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    )
    .nullish()
    .transform((value) => (value ? value : null));
const timestamp = z.iso
  .datetime({ offset: true })
  .nullish()
  .transform((value) => (value ? new Date(value) : null));
const memberId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
// Pledge event IDs look like "subscription:123"; they become private payment references.
const eventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/);
const reference = z.object({ id: z.string().min(1).max(160), type: z.string().min(1).max(40) });
const pageSchema = z.object({
  data: z
    .array(
      z.object({
        id: memberId,
        type: z.literal("member"),
        attributes: z.object({
          // Hidden or empty names stay allowed; an unusable name is dropped rather than blocking the import.
          full_name: text(120).catch(null),
          patron_status: text(120),
          last_charge_status: text(120),
          last_charge_date: timestamp,
        }),
        relationships: z
          .object({
            user: z.object({ data: reference.nullable() }).nullish(),
            pledge_history: z.object({ data: z.array(reference).max(10_000) }).nullish(),
          })
          .nullish(),
      }),
    )
    .max(1000),
  included: z
    .array(z.object({ id: z.string().min(1).max(160), type: z.string().min(1).max(40) }).loose())
    .max(200_000)
    .nullish(),
  meta: z
    .object({
      pagination: z.object({ cursors: z.object({ next: z.string().min(1).max(1024).nullish() }).nullish() }).nullish(),
    })
    .nullish(),
});
const userSchema = z.object({
  id: z.string().min(1).max(160),
  type: z.literal("user"),
  // Only the Discord ID is read (see discordConnection); other connected accounts are discarded unparsed.
  attributes: z.object({ social_connections: z.unknown() }).nullish(),
});
const discordConnectionSchema = z.object({
  user_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullish(),
});
type DiscordConnection = { discordId: string | null; known: boolean };
const UNKNOWN_DISCORD: DiscordConnection = { discordId: null, known: false };
/**
 * The Discord account in a patron's social connections. Connections that are null, or that name no Discord
 * account, mean the patron has none connected. Anything malformed is unknown: it is never linked, and it never
 * clears the Discord ID Patreon reported before.
 */
export function discordConnection(connections: unknown): DiscordConnection {
  if (connections === null) return { discordId: null, known: true };
  if (typeof connections !== "object" || Array.isArray(connections)) return UNKNOWN_DISCORD;
  const discord = (connections as Record<string, unknown>).discord;
  if (discord === undefined || discord === null) return { discordId: null, known: true };
  const parsed = discordConnectionSchema.safeParse(discord);
  return parsed.success ? { discordId: parsed.data.user_id ?? null, known: true } : UNKNOWN_DISCORD;
}
const eventSchema = z.object({
  id: eventId,
  type: z.enum(["pledge-event", "pledge_event"]),
  attributes: z.object({
    amount_cents: z.number().int().min(0).max(100_000_000).nullish(),
    currency_code: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish(),
    date: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    payment_status: text(60),
    type: text(60),
    // Read leniently (see tierIdOf): a missing or odd tier never rejects the page.
    tier_id: z.unknown(),
  }),
});
/** A tier ID as Patreon gives it on a pledge event or a tier. Anything else is no tier. */
export function tierIdOf(value: unknown) {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
const tiersSchema = z.object({
  data: z.object({ id: z.union([z.string(), z.number()]), type: z.literal("campaign") }),
  included: z.array(z.unknown()).max(1000).nullish(),
});
const tierSchema = z.object({
  id: z.unknown(),
  type: z.literal("tier"),
  attributes: z.object({ amount_cents: z.number().int().min(0).max(100_000_000) }),
});
/** A paid event in another currency that names its tier: the only kind a tier price can help. */
const needsTierPrice = (event: PatreonPledgeEvent) =>
  patreonChargePaid(event.paymentStatus) &&
  event.tierId !== undefined &&
  event.currency !== null &&
  event.currency !== PATREON_TIER_CURRENCY;
/**
 * Patreon answered the member request that also asks for each event's tier with an error status other than a refused
 * token, a missing campaign or a rate limit. Never leaves the client.
 */
class TierFieldRefused extends Error {}
/**
 * Whether a failed read that asked for tiers is tried once more without them. A refused request, a failure on
 * Patreon's side and a response the import cannot use could each come from the added field, so none of them may
 * stop an import that works without it. A refused token, a missing campaign, a rate limit and a network failure
 * could not, and are reported as they always were.
 */
const retryWithoutTiers = (error: unknown) =>
  error instanceof TierFieldRefused || (error instanceof PatreonApiError && error.kind === "schema");

async function readBounded(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new PatreonApiError("schema", TOO_LARGE);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PatreonApiError("schema", TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Retry-After seconds or HTTP date, else Patreon's documented `retry_after_seconds`; clamped to 1s..1h. */
export async function retryAfterMs(response: Response, now = Date.now()) {
  const header = response.headers.get("retry-after")?.trim();
  let seconds = header && /^\d{1,7}$/.test(header) ? Number(header) : NaN;
  if (header && !Number.isFinite(seconds) && Number.isFinite(Date.parse(header)))
    seconds = (Date.parse(header) - now) / 1000;
  if (!Number.isFinite(seconds)) {
    try {
      const body = JSON.parse(await readBounded(response, 65_536)) as {
        errors?: Array<{ retry_after_seconds?: unknown }>;
      };
      const value = body.errors?.[0]?.retry_after_seconds;
      if (typeof value === "number" && Number.isFinite(value)) seconds = value;
    } catch {
      // The default below applies.
    }
  } else await response.body?.cancel().catch(() => undefined);
  return Math.min(Math.max(Number.isFinite(seconds) ? seconds : 60, 1), 3600) * 1000;
}

/**
 * Patreon charge statuses for a charge that was taken and later reversed, is being refunded, or otherwise went
 * wrong (refunds, fraud and Patreon's "Other"). A declined charge was never taken, and a declined refund leaves
 * the charge standing, so neither is one of them.
 */
export const PATREON_REVERSED_CHARGE_STATUSES: ReadonlySet<string> = new Set([
  "Refunded",
  "Partially Refunded",
  "Refunded by Patreon",
  "Refund Pending",
  "Fraud",
  "Other",
]);
/** A charge that was taken and still stands: Paid, or a refund Patreon declined. */
const PAID_CHARGE_STATUSES: ReadonlySet<string> = new Set(["Paid", "Refund Declined"]);
/** Whether a pledge event is a paid charge that still stands. */
export const patreonChargePaid = (status: string | null) => status !== null && PAID_CHARGE_STATUSES.has(status);
/**
 * Whether a pledge event is a charge that was taken: paid, or taken and later reversed. Pending, declined and free
 * trial events, and any status Patreon adds later, are not charges.
 */
export const patreonChargeTaken = (status: string | null) =>
  patreonChargePaid(status) || (status !== null && PATREON_REVERSED_CHARGE_STATUSES.has(status));
/**
 * The member's first successful payment, from a complete history. Events are taken by date, a pledge start before
 * anything else at the same time, then by event ID. The first charge that was taken decides: when it still stands it
 * is the first payment, and when it was reversed no later payment is the first. Null when there is none, and also
 * when the answer is not known yet: the history may be incomplete, or a charge is still pending before the first one
 * that was taken.
 */
export function firstPaidEventId(events: PatreonPledgeEvent[], complete: boolean) {
  if (!complete) return null;
  const sorted = [...events].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      Number(b.type === "pledge_start") - Number(a.type === "pledge_start") ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const event of sorted) {
    if (event.paymentStatus === "Pending") return null;
    if (patreonChargeTaken(event.paymentStatus)) return patreonChargePaid(event.paymentStatus) ? event.id : null;
  }
  return null;
}

@Injectable()
export class PatreonClient {
  /**
   * Reads every member page (bounded), then the campaign's tier prices when a payment needs one. Throws
   * PatreonApiError before returning anything when the member list cannot be read. Tier data never fails the read:
   * without it, events simply carry no tier price.
   */
  async members(campaignId: string, token: string, now = new Date()): Promise<PatreonMembersResult> {
    let list: { members: PatreonMemberSnapshot[]; complete: boolean };
    try {
      list = await this.memberPages(campaignId, token, now, true);
    } catch (error) {
      if (!retryWithoutTiers(error)) throw error;
      // This sync sends the request the import has always sent. If that fails too, its error is the one reported.
      await this.pause();
      return { ...(await this.memberPages(campaignId, token, now, false)), tierPrices: "refused" };
    }
    if (!list.members.some((member) => member.events.some(needsTierPrice)))
      return { ...list, tierPrices: "not_requested" };
    await this.pause();
    const tiers = await this.tierPrices(campaignId, token, now);
    if (!tiers.prices) return { ...list, tierPrices: "unavailable", retryAfterMs: tiers.retryAfterMs };
    for (const member of list.members)
      for (const event of member.events) {
        const price = event.tierId === undefined ? undefined : tiers.prices.get(event.tierId);
        if (price !== undefined) event.tierAmountCents = price;
      }
    return { ...list, tierPrices: "read" };
  }

  /** Paces requests under Patreon's limit of 100 a minute per access token. */
  private pause() {
    return new Promise<void>((resolve) => setTimeout(resolve, PATREON_PAGE_DELAY_MS));
  }

  private request(url: URL, token: string) {
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": PATREON_USER_AGENT, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(PATREON_REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * The campaign's tier prices in US cents, by tier ID. Never throws: a failed request, or a response that is not
   * this campaign's tier list, gives no prices, and a tier that cannot be read is left out.
   */
  private async tierPrices(
    campaignId: string,
    token: string,
    now: Date,
  ): Promise<{ prices: Map<string, number> | null; retryAfterMs?: number }> {
    try {
      const url = new URL(`/api/oauth2/v2/campaigns/${encodeURIComponent(campaignId)}`, PATREON_API_ORIGIN);
      url.searchParams.set("include", "tiers");
      url.searchParams.set("fields[tier]", "amount_cents");
      const response = await this.request(url, token);
      if (response.status === 429) return { prices: null, retryAfterMs: await retryAfterMs(response, now.getTime()) };
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { prices: null };
      }
      const parsed = tiersSchema.safeParse(JSON.parse(await readBounded(response, PATREON_MAX_TIERS_BYTES)));
      if (!parsed.success || String(parsed.data.data.id) !== campaignId) return { prices: null };
      const prices = new Map<string, number>();
      for (const item of parsed.data.included ?? []) {
        const tier = tierSchema.safeParse(item);
        const id = tier.success ? tierIdOf(tier.data.id) : null;
        if (tier.success && id) prices.set(id, tier.data.attributes.amount_cents);
      }
      return { prices };
    } catch {
      return { prices: null };
    }
  }

  private async memberPages(campaignId: string, token: string, now: Date, tierField: boolean) {
    const members: PatreonMemberSnapshot[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < PATREON_MAX_PAGES; page++) {
      const result = await this.page(campaignId, token, cursor, now, tierField);
      for (const member of result.members) {
        if (seen.has(member.patreonMemberId)) continue;
        seen.add(member.patreonMemberId);
        members.push(member);
      }
      if (!result.next) return { members, complete: true };
      if (cursors.has(result.next)) throw new PatreonApiError("schema", UNEXPECTED);
      cursors.add(result.next);
      cursor = result.next;
      await this.pause();
    }
    return { members, complete: false };
  }

  private async page(campaignId: string, token: string, cursor: string | null, now: Date, tierField: boolean) {
    const url = new URL(`/api/oauth2/v2/campaigns/${encodeURIComponent(campaignId)}/members`, PATREON_API_ORIGIN);
    url.searchParams.set("include", "user,pledge_history");
    url.searchParams.set("fields[member]", "full_name,patron_status,last_charge_status,last_charge_date");
    url.searchParams.set("fields[user]", "social_connections");
    url.searchParams.set("fields[pledge-event]", tierField ? PLEDGE_EVENT_FIELDS_WITH_TIER : PLEDGE_EVENT_FIELDS);
    url.searchParams.set("page[count]", String(PATREON_PAGE_COUNT));
    if (cursor) url.searchParams.set("page[cursor]", cursor);
    let response: Response;
    try {
      response = await this.request(url, token);
    } catch {
      throw new PatreonApiError("unavailable", UNAVAILABLE);
    }
    if (response.status === 429) {
      const wait = await retryAfterMs(response, now.getTime());
      throw new PatreonApiError(
        "rate",
        `Patreon asked the sync to slow down. The next attempt waits ${Math.ceil(wait / 1000)} seconds.`,
        wait,
      );
    }
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new PatreonApiError("token", PATREON_TOKEN_REJECTED);
    if (response.status === 404) throw new PatreonApiError("campaign", CAMPAIGN_NOT_FOUND);
    if (!response.ok) throw tierField ? new TierFieldRefused() : new PatreonApiError("unavailable", UNAVAILABLE);
    let body: unknown;
    try {
      body = JSON.parse(await readBounded(response, PATREON_MAX_PAGE_BYTES));
    } catch (error) {
      if (error instanceof PatreonApiError) throw error;
      throw new PatreonApiError(
        error instanceof SyntaxError ? "schema" : "unavailable",
        error instanceof SyntaxError ? UNEXPECTED : UNAVAILABLE,
      );
    }
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) throw new PatreonApiError("schema", UNEXPECTED);
    const users = new Map<string, DiscordConnection>();
    const events = new Map<string, PatreonPledgeEvent>();
    for (const item of parsed.data.included ?? []) {
      if (item.type === "user") {
        const user = userSchema.safeParse(item);
        if (!user.success) throw new PatreonApiError("schema", UNEXPECTED);
        // Connections Patreon left out of the response are unknown, not empty.
        const attributes = user.data.attributes;
        users.set(
          user.data.id,
          attributes && "social_connections" in attributes
            ? discordConnection(attributes.social_connections)
            : UNKNOWN_DISCORD,
        );
      } else if (item.type === "pledge-event" || item.type === "pledge_event") {
        const event = eventSchema.safeParse(item);
        if (!event.success) throw new PatreonApiError("schema", UNEXPECTED);
        const { attributes } = event.data;
        // A request that did not ask for the tier reads none, so it imports exactly what it always has.
        const tierId = tierField ? tierIdOf(attributes.tier_id) : null;
        events.set(event.data.id, {
          id: event.data.id,
          date: attributes.date,
          amountCents: attributes.amount_cents ?? null,
          currency: attributes.currency_code ?? null,
          paymentStatus: attributes.payment_status,
          type: attributes.type,
          ...(tierId ? { tierId } : {}),
        });
      }
    }
    const limit = now.getTime() + FUTURE_TOLERANCE_MS;
    const members = parsed.data.data.map((member): PatreonMemberSnapshot => {
      const references = member.relationships?.pledge_history?.data;
      const found = (references ?? [])
        .filter((item) => item.type === "pledge-event" || item.type === "pledge_event")
        .map((item) => events.get(item.id));
      const history = found.filter((event): event is PatreonPledgeEvent => !!event && event.date.getTime() <= limit);
      const userId = member.relationships?.user?.data?.type === "user" ? member.relationships.user.data.id : null;
      const discord = (userId ? users.get(userId) : undefined) ?? UNKNOWN_DISCORD;
      const lastChargeAt = member.attributes.last_charge_date;
      return {
        patreonMemberId: member.id,
        displayName: member.attributes.full_name,
        patronStatus: member.attributes.patron_status,
        lastChargeStatus: member.attributes.last_charge_status,
        lastChargeAt: lastChargeAt && lastChargeAt.getTime() <= limit ? lastChargeAt : null,
        discordId: discord.discordId,
        discordKnown: discord.known,
        events: history,
        // Every event the member's history names came back, none of them is in the future, and the history is
        // shorter than the length at which Patreon cuts it. Patreon cuts only long histories, so a history that
        // starts with a renewal rather than the pledge start is still complete.
        historyComplete:
          references !== undefined &&
          references !== null &&
          history.length === references.length &&
          references.length < PATREON_HISTORY_CAP,
      };
    });
    return { members, next: parsed.data.meta?.pagination?.cursors?.next ?? null };
  }
}
