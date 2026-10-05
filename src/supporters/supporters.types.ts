import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";
import type {
  SupporterDiscordSource,
  SupporterPaymentSource,
  SupporterProvider,
  SupporterSteamSource,
} from "../database/supporters.schema";
import { PATREON_REVERSED_CHARGE_STATUSES } from "./patreon.client";
import type { AutomaticFounderBlockedReason, NextStep, SteamMatch } from "./supporter-match.rules";

export const MAX_PATREON_BYTES = 65_536;
const line = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) =>
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    );
export const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const optionalText = line(120)
  .nullish()
  .transform((value) => value ?? null);
// Patreon permits empty names when a member hides their identity.
const displayName = z.preprocess((value) => (typeof value === "string" && !value.trim() ? null : value), optionalText);
const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
export const supportedTriggers = z.enum([
  "members:create",
  "members:update",
  "members:delete",
  "members:pledge:create",
  "members:pledge:update",
  "members:pledge:delete",
]);
const payloadSchema = z.object({
  data: z.object({
    id: providerId,
    type: z.literal("member"),
    attributes: z.object({
      // Like the API import, an unusable name is dropped rather than rejecting the member's whole update.
      full_name: displayName.catch(null),
      patron_status: optionalText,
      last_charge_status: optionalText,
      last_charge_date: timestamp.nullish().transform((value) => value ?? null),
    }),
    relationships: z.object({
      campaign: z.object({ data: z.object({ id: z.string().regex(/^\d{1,30}$/), type: z.literal("campaign") }) }),
    }),
  }),
});
export type PatreonObservation = {
  hash: string;
  trigger: string;
  campaignId: string;
  patreonMemberId: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: Date | null;
  receivedAt: Date;
};
/** Whether the original body carries Patreon's HMAC-MD5 signature for this secret, compared in constant time. */
export function signedByPatreon(raw: unknown, signature: unknown, secret: string) {
  if (!Buffer.isBuffer(raw) || typeof signature !== "string" || !/^[a-fA-F0-9]{32}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), createHmac("md5", secret).update(raw).digest());
}

export function parsePatreon(
  raw: unknown,
  signature: unknown,
  trigger: unknown,
  secret: string,
  campaignId: string,
): PatreonObservation {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_PATREON_BYTES)
    throw new BadRequestException("A bounded original webhook body is required.");
  if (!signedByPatreon(raw, signature, secret)) throw new UnauthorizedException("Invalid Patreon signature.");
  const event = supportedTriggers.safeParse(trigger);
  if (!event.success) throw new BadRequestException("Unsupported Patreon webhook trigger.");
  let input: unknown;
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BadRequestException("Invalid Patreon payload.");
  }
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException("Invalid Patreon member payload.");
  const value = parsed.data.data;
  if (value.relationships.campaign.data.id !== campaignId)
    throw new UnauthorizedException("Unexpected Patreon campaign.");
  const receivedAt = new Date();
  if (value.attributes.last_charge_date && value.attributes.last_charge_date.getTime() > receivedAt.getTime() + 300_000)
    throw new BadRequestException("Invalid Patreon charge date.");
  return {
    hash: createHash("sha256").update(raw).digest("hex"),
    trigger: event.data,
    campaignId,
    patreonMemberId: value.id,
    displayName: value.attributes.full_name,
    patronStatus: value.attributes.patron_status,
    lastChargeStatus: value.attributes.last_charge_status,
    lastChargeAt: value.attributes.last_charge_date,
    receivedAt,
  };
}
const base = { id: z.uuid(), version: z.number().int().positive(), confirm: providerId, reason: line(200).min(3) };
const discordUserId = z.string().regex(/^\d{17,20}$/);
const playerSteamId = z.string().refine(isPublicIndividualSteamId, "Enter a valid player SteamID64.");
export const manualMemberSchema = z
  .object({
    id: z.uuid(),
    patreonMemberId: providerId,
    displayName,
    campaignMembershipVerified: z.literal(true),
    reason: line(200).min(3),
  })
  .strict();
export type ManualMemberInput = z.infer<typeof manualMemberSchema>;
export const reviewSchema = z.object(base).strict();
// Either identity may be linked alone. A field that is left out keeps its current value. `steamConfirmed` restates
// the current SteamID as staff-checked, which a Discord change needs when the SteamID came from an application.
export const linkSchema = z
  .object({
    ...base,
    discordId: discordUserId.optional(),
    steamId: playerSteamId.optional(),
    steamConfirmed: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => value.discordId !== undefined || value.steamId !== undefined, "Enter a Discord ID or SteamID64.");
export const paymentSchema = z
  .object({
    ...base,
    paidAt: timestamp,
    amountCents: z.number().int().min(1).max(100_000_000),
    currency: z.literal("USD"),
    reference: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/),
    completedPaymentVerified: z.literal(true),
    firstSuccessfulPaymentVerified: z.boolean().default(false),
  })
  .strict();
export const founderSchema = z.object({ ...base, paymentId: z.uuid() }).strict();
export type SupporterMutation =
  | (z.infer<typeof linkSchema> & { kind: "link" })
  | (z.infer<typeof paymentSchema> & { kind: "payment" })
  | (z.infer<typeof founderSchema> & { kind: "founder" })
  | (z.infer<typeof reviewSchema> & { kind: "review" });
/** A staff-checked PayPal payment. No payer email or PayPal account details are accepted or stored. */
export const paypalSchema = z
  .object({
    id: z.uuid(),
    memberId: z.uuid().optional(),
    version: z.number().int().positive().optional(),
    displayName: line(120),
    discordId: discordUserId.optional(),
    steamId: playerSteamId.optional(),
    paidAt: timestamp,
    amountCents: z.number().int().min(1).max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    transactionId: z
      .string()
      .regex(/^[A-Za-z0-9]{10,30}$/)
      .transform((value) => value.toUpperCase()),
    completedPaymentVerified: z.literal(true),
    firstSuccessfulPaymentVerified: z.boolean(),
    minimumConfirmed: z.boolean().default(false),
    awardFounder: z.boolean().default(false),
    reason: line(200).min(3),
  })
  .strict()
  .refine(
    (value) => (value.memberId === undefined) === (value.version === undefined),
    "Send the record version with the PayPal supporter ID.",
  );
export type PaypalInput = z.infer<typeof paypalSchema>;
export const providerFilter = z.enum(["patreon", "paypal"]).optional();
export type FounderPolicy = {
  amountCents: number;
  currency: "USD";
  startsAt: string | null;
  endsAt: string | null;
  configured: boolean;
  /** The environment pair that supplied the window; null while it is not configured. */
  source: "SUPPORTER_FOUNDER" | "PATREON_FOUNDER" | null;
  /** Hours an imported first payment must stand before automatic matching records a founder promise (default 72). */
  automaticHoldHours?: number;
};
export const policyDays = 15;
/** The founder minimum. The Supporter Discord role uses the same minimum. */
export const FOUNDER_MINIMUM = { amountCents: 500, currency: "USD" } as const;

/** Verified payment sources that can qualify a founder. Another provider's source slots in here. */
export const FOUNDER_PAYMENT_SOURCES = [
  "manual_receipt",
  "patreon_api",
  "paypal",
] as const satisfies readonly SupporterPaymentSource[];
export type FounderBlockedReason =
  | "window_not_configured"
  | "source_not_qualifying"
  | "not_verified"
  | "not_first_payment"
  | "earlier_payment"
  | "outside_window"
  | "below_minimum"
  | "no_identity"
  | "already_founder";
export const founderBlockedMessages: Record<FounderBlockedReason | "no_payment", string> = {
  window_not_configured: "The founder window is not configured.",
  source_not_qualifying:
    "Only a checked Patreon receipt, a Patreon API payment or a PayPal payment can qualify. A signed status alone cannot.",
  not_verified: "This payment has not been verified, or Patreon no longer reports its charge as paid.",
  not_first_payment: "Staff have not confirmed this was the supporter's first successful payment.",
  earlier_payment:
    "An earlier payment is recorded. Review the first successful payment before recording a founder promise.",
  outside_window: "This payment was not made inside the founder window.",
  below_minimum: "The payment is below US$5, or a non-USD payment has not been confirmed to be worth at least US$5.",
  no_identity: "Link a Discord account or a valid SteamID64 first. A SteamID that is entered must be valid.",
  already_founder: "This person already has a founder record. Each person can be a founder once.",
  no_payment: "No payment is recorded for this supporter.",
};
export type FounderPaymentFacts = {
  source: string;
  verificationState: string;
  firstSuccessfulPaymentVerified: boolean;
  paidAt: Date | string;
  amountCents: number | null;
  currency: string | null;
  minimumConfirmed?: boolean | null;
};
/** At least one staff-linked identity, and a SteamID that is present must be a valid player ID. */
export function founderIdentity(member: { discordId: string | null; steamId: string | null }) {
  const steamValid = isPublicIndividualSteamId(member.steamId);
  return (Boolean(member.discordId) || steamValid) && (!member.steamId || steamValid);
}
/**
 * The founder rule's minimum: at least US$5, or a payment in another currency marked `minimumConfirmed`. Staff set
 * that mark on a PayPal payment, and the Patreon import sets it when the payment's tier costs US$5 or more. Amount
 * and currency are recorded but never create tiers.
 */
export function meetsFounderMinimum(
  payment: Pick<FounderPaymentFacts, "amountCents" | "currency" | "minimumConfirmed">,
  minimum: { amountCents: number; currency: string } = FOUNDER_MINIMUM,
) {
  return (
    payment.amountCents !== null &&
    (payment.currency === minimum.currency
      ? payment.amountCents >= minimum.amountCents
      : payment.currency !== null && payment.minimumConfirmed === true)
  );
}
/**
 * The first reason this payment cannot make its member a founder, or null when it qualifies. One rule for every
 * provider: a verified first successful payment from a qualifying source, inside the end-exclusive window, worth at
 * least US$5. `earlierPayment` ignores the imported copy of a staff receipt's own charge, and
 * `importedCopyUnverified` means Patreon no longer reports that copy as paid.
 */
export function founderBlocker(
  payment: FounderPaymentFacts,
  policy: FounderPolicy,
  context: { earlierPayment: boolean; importedCopyUnverified?: boolean; hasIdentity: boolean; otherFounder: boolean },
): FounderBlockedReason | null {
  const starts = policy.startsAt ? Date.parse(policy.startsAt) : NaN,
    ends = policy.endsAt ? Date.parse(policy.endsAt) : NaN;
  if (!policy.configured || !Number.isFinite(starts) || !Number.isFinite(ends)) return "window_not_configured";
  if (!(FOUNDER_PAYMENT_SOURCES as readonly string[]).includes(payment.source)) return "source_not_qualifying";
  if (payment.verificationState !== "verified" || context.importedCopyUnverified) return "not_verified";
  if (!payment.firstSuccessfulPaymentVerified) return "not_first_payment";
  if (context.earlierPayment) return "earlier_payment";
  const paidAt = new Date(payment.paidAt).getTime();
  if (!Number.isFinite(paidAt) || paidAt < starts || paidAt >= ends) return "outside_window";
  if (!meetsFounderMinimum(payment, policy)) return "below_minimum";
  if (!context.hasIdentity) return "no_identity";
  if (context.otherFounder) return "already_founder";
  return null;
}
/** A declined Patreon patron keeps the Supporter role this long after the declined charge while Patreon retries. */
export const SUPPORTER_DECLINE_GRACE_MS = 7 * 86_400_000;
/** A staff-recorded PayPal payment keeps the Supporter role this long after it was paid (covers one-time gifts). */
export const PAYPAL_SUPPORT_MS = 31 * 86_400_000;
/** The facts of one supporter record that the Supporter Discord role reads. */
export type SupportFacts = {
  provider: SupporterProvider;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: Date | string | null;
  /** Verified payments with a known amount from founder-qualifying sources, newest first (a bounded number). */
  payments: Pick<FounderPaymentFacts, "source" | "paidAt" | "amountCents" | "currency" | "minimumConfirmed">[];
};
/**
 * Whether a supporter record supports The UNCs right now, for the Supporter Discord role. It is a Discord role
 * only: it grants no whitelist or game access.
 *
 * - Patreon: an active patron, or a declined patron until 7 days after the declined charge (Patreon retries the
 *   card), whose latest charge was not refunded, fraudulent or otherwise reversed, with at least one completed
 *   payment on record. Patreon charges the tier price itself, so any tier and any currency counts, whether or not
 *   the charge is confirmed against the founder minimum.
 * - PayPal: a staff-recorded payment that meets the founder minimum, until 31 days after it was paid.
 *
 * Every window ends exclusively at the stated time.
 */
export function supportActive(record: SupportFacts, now: Date | number) {
  const at = typeof now === "number" ? now : now.getTime();
  const time = (value: Date | string | null) => (value === null ? NaN : new Date(value).getTime());
  if (record.provider === "paypal")
    return record.payments.some(
      (payment) =>
        payment.source === "paypal" && meetsFounderMinimum(payment) && at < time(payment.paidAt) + PAYPAL_SUPPORT_MS,
    );
  if (!record.payments.length) return false;
  if (record.lastChargeStatus && PATREON_REVERSED_CHARGE_STATUSES.has(record.lastChargeStatus)) return false;
  if (record.patronStatus === "active_patron") return true;
  return record.patronStatus === "declined_patron" && at < time(record.lastChargeAt) + SUPPORTER_DECLINE_GRACE_MS;
}
export type PaymentView = {
  id: string;
  paidAt: string;
  amountCents: number | null;
  currency: string | null;
  source: SupporterPaymentSource;
  reference: string;
  verificationState: "verified" | "unverified";
  firstSuccessfulPaymentVerified: boolean;
  minimumConfirmed: boolean;
  recordedBy: string | null;
};
/**
 * How the two identities are linked: none, one of them, or both. `patreon_linked` means the Discord account came from
 * the patron's own Patreon connection; the SteamID is still a self-declared or staff-entered claim either way.
 */
export type SupporterIdentityState = "unlinked" | "partial" | "patreon_linked" | "staff_linked";
export type SupporterView = {
  id: string;
  provider: SupporterProvider;
  /** Null only for PayPal supporters. Mutations send `confirmKey` instead. */
  patreonMemberId: string | null;
  /** The value every mutation sends as `confirm`: the Patreon member ID, or the record ID for PayPal. */
  confirmKey: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: string | null;
  observedAt: string;
  reviewState: "pending" | "verified" | "unverified";
  discordId: string | null;
  /** Who made the Discord link; null when unlinked, or for an older link that is not classified yet. */
  discordSource: SupporterDiscordSource | null;
  /** The Discord account Patreon last reported for this membership, linked or not. Patreon rows only. */
  patreonDiscordId: string | null;
  steamId: string | null;
  /** Who made the SteamID link; null when unlinked, or for an older link that is not classified yet. */
  steamSource: SupporterSteamSource | null;
  /** The approved whitelist application the SteamID was copied from, when automatic matching copied it. */
  steamApplicationId: string | null;
  identityState: SupporterIdentityState;
  version: number;
  latestPayment: PaymentView | null;
  /** Newest first, at most 20. */
  payments: PaymentView[];
  founderEligiblePayment: PaymentView | null;
  /** `automatic` is true when automatic supporter matching recorded the promise. */
  founder: { awardedAt: string; paymentId: string; source: SupporterPaymentSource | null; automatic: boolean } | null;
  /** Why no founder promise can be recorded yet; null for a founder or a member ready to award. */
  founderBlockedReason: FounderBlockedReason | "no_payment" | null;
  /** The staff-facing text for `founderBlockedReason`. */
  founderBlockedMessage: string | null;
  /** A founder without a linked Discord account cannot receive the Founder role. */
  needsDiscordLink: boolean;
  /** What automatic matching found for this record. */
  match: {
    /** The SteamID this Discord account's approved application offers, and why it may not be copied; null without a Discord account. */
    steam: SteamMatch | null;
    /** The application the SteamID was copied from, when automatic matching copied it and it is still on record. */
    sourceApplication: { id: string; serverId: string; status: string } | null;
    /** The SteamID was copied from an application, and no approved application for it remains. */
    sourceApplicationRevoked: boolean;
    patreonDiscordElsewhere: boolean;
    discordReportedForOtherPatron: boolean;
    /** Another Discord account has applied with the linked SteamID (an application not declined or revoked). */
    linkedSteamShared: boolean;
  };
  /** The payment automatic matching would record a founder promise on: the earliest verified first Patreon API payment. */
  automaticPayment: PaymentView | null;
  /** Why automatic matching would not record a founder promise; null for a founder or one it would record. */
  automaticBlockedReason: AutomaticFounderBlockedReason | null;
  automaticBlockedMessage: string | null;
};
/** A supporter record as the dashboard receives it, with the steps still needed. */
export type SupporterListItem = SupporterView & { nextSteps: NextStep[] };
