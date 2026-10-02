import { Injectable } from "@nestjs/common";
import { z } from "zod";

/**
 * Authenticated, read-only pull of the configured campaign's members from Patreon API v2.
 * Docs: https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id-members (endpoint, includes,
 * page size), #member, #pledge-event and #user-v2 (attributes), #pagination ("More Data, Pagination":
 * cursor-based `page[count]`/`page[cursor]`, next cursor in `meta.pagination.cursors.next`),
 * #rate-limits (100 requests per minute per access token) and #errors.
 */
export const PATREON_API_ORIGIN = "https://www.patreon.com";
/** Fewer members per page keeps each member's included pledge history from being cut short. */
export const PATREON_PAGE_COUNT = 50;
export const PATREON_MAX_PAGES = 100;
export const PATREON_MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const PATREON_REQUEST_TIMEOUT_MS = 20_000;
/** Paces multi-page reads under Patreon's 100 requests per minute per access token. */
export const PATREON_PAGE_DELAY_MS = 700;
/**
 * Patreon cuts included pledge history to roughly the latest ~100 events when many members are
 * requested. A history at or above this length is treated as possibly incomplete.
 */
export const PATREON_HISTORY_CAP = 100;
export const PATREON_USER_AGENT = "UNCs-Gramps-Bot/1.0 (private supporter ledger sync; +https://theuncsgaming.com)";
const FUTURE_TOLERANCE_MS = 300_000;

export type PatreonPledgeEvent = {
  id: string;
  date: Date;
  amountCents: number | null;
  currency: string | null;
  paymentStatus: string | null;
  type: string | null;
};
export type PatreonMemberSnapshot = {
  patreonMemberId: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: Date | null;
  /** Discord account the patron connected on Patreon, when the campaign's Discord benefit exposes it. */
  discordId: string | null;
  events: PatreonPledgeEvent[];
  /** False when the returned pledge history may be truncated; the first payment is then not derived. */
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
  attributes: z
    .object({
      // Only the Discord ID is read; other connected accounts are discarded unparsed.
      social_connections: z
        .object({
          discord: z
            .object({
              user_id: z
                .string()
                .regex(/^\d{17,20}$/)
                .nullish()
                .catch(null),
            })
            .nullish()
            .catch(null),
        })
        .nullish()
        .catch(null),
    })
    .nullish(),
});
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
  }),
});

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
/** Statuses that show a charge was taken at some point, whether or not it still stands. */
const chargedBefore: ReadonlySet<string> = new Set([...PATREON_REVERSED_CHARGE_STATUSES, "Refund Declined"]);
/**
 * The member's first successful payment: the earliest `Paid` event of a complete history, only when
 * no earlier event could have been a charge that was later reversed and no other `Paid` event shares
 * its timestamp. Anything uncertain leaves the first-payment flag for staff review.
 */
export function firstPaidEventId(events: PatreonPledgeEvent[], complete: boolean) {
  if (!complete) return null;
  const sorted = [...events].sort((a, b) => a.date.getTime() - b.date.getTime());
  const index = sorted.findIndex((event) => event.paymentStatus === "Paid");
  if (index < 0) return null;
  const first = sorted[index];
  if (
    sorted.some(
      (event, other) =>
        other !== index && event.paymentStatus === "Paid" && event.date.getTime() === first.date.getTime(),
    )
  )
    return null;
  if (sorted.slice(0, index).some((event) => event.paymentStatus && chargedBefore.has(event.paymentStatus)))
    return null;
  return first.id;
}

@Injectable()
export class PatreonClient {
  /** Reads every page (bounded). Throws PatreonApiError before returning anything on any failure. */
  async members(campaignId: string, token: string, now = new Date()) {
    const members: PatreonMemberSnapshot[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < PATREON_MAX_PAGES; page++) {
      const result = await this.page(campaignId, token, cursor, now);
      for (const member of result.members) {
        if (seen.has(member.patreonMemberId)) continue;
        seen.add(member.patreonMemberId);
        members.push(member);
      }
      if (!result.next) return { members, complete: true };
      if (cursors.has(result.next)) throw new PatreonApiError("schema", UNEXPECTED);
      cursors.add(result.next);
      cursor = result.next;
      await new Promise((resolve) => setTimeout(resolve, PATREON_PAGE_DELAY_MS));
    }
    return { members, complete: false };
  }

  private async page(campaignId: string, token: string, cursor: string | null, now: Date) {
    const url = new URL(`/api/oauth2/v2/campaigns/${encodeURIComponent(campaignId)}/members`, PATREON_API_ORIGIN);
    url.searchParams.set("include", "user,pledge_history");
    url.searchParams.set("fields[member]", "full_name,patron_status,last_charge_status,last_charge_date");
    url.searchParams.set("fields[user]", "social_connections");
    url.searchParams.set("fields[pledge-event]", "amount_cents,currency_code,date,payment_status,type");
    url.searchParams.set("page[count]", String(PATREON_PAGE_COUNT));
    if (cursor) url.searchParams.set("page[cursor]", cursor);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": PATREON_USER_AGENT, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(PATREON_REQUEST_TIMEOUT_MS),
      });
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
    if (!response.ok) throw new PatreonApiError("unavailable", UNAVAILABLE);
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
    const users = new Map<string, string | null>();
    const events = new Map<string, PatreonPledgeEvent>();
    for (const item of parsed.data.included ?? []) {
      if (item.type === "user") {
        const user = userSchema.safeParse(item);
        if (!user.success) throw new PatreonApiError("schema", UNEXPECTED);
        users.set(user.data.id, user.data.attributes?.social_connections?.discord?.user_id ?? null);
      } else if (item.type === "pledge-event" || item.type === "pledge_event") {
        const event = eventSchema.safeParse(item);
        if (!event.success) throw new PatreonApiError("schema", UNEXPECTED);
        const { attributes } = event.data;
        events.set(event.data.id, {
          id: event.data.id,
          date: attributes.date,
          amountCents: attributes.amount_cents ?? null,
          currency: attributes.currency_code ?? null,
          paymentStatus: attributes.payment_status,
          type: attributes.type,
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
      const earliest = [...history].sort(
        (a, b) =>
          a.date.getTime() - b.date.getTime() || Number(b.type === "pledge_start") - Number(a.type === "pledge_start"),
      )[0];
      const userId = member.relationships?.user?.data?.type === "user" ? member.relationships.user.data.id : null;
      const lastChargeAt = member.attributes.last_charge_date;
      return {
        patreonMemberId: member.id,
        displayName: member.attributes.full_name,
        patronStatus: member.attributes.patron_status,
        lastChargeStatus: member.attributes.last_charge_status,
        lastChargeAt: lastChargeAt && lastChargeAt.getTime() <= limit ? lastChargeAt : null,
        discordId: userId ? (users.get(userId) ?? null) : null,
        events: history,
        historyComplete:
          references !== undefined &&
          references !== null &&
          history.length === references.length &&
          references.length < PATREON_HISTORY_CAP &&
          (history.length === 0 || earliest.type === "pledge_start"),
      };
    });
    return { members, next: parsed.data.meta?.pagination?.cursors?.next ?? null };
  }
}
