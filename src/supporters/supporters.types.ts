import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isPublicIndividualSteamId } from "../common/steam-id";

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
export const linkSchema = z
  .object({
    ...base,
    discordId: z.string().regex(/^\d{17,20}$/),
    steamId: z.string().refine(isPublicIndividualSteamId, "Enter a valid player SteamID64."),
  })
  .strict();
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
export type FounderPolicy = {
  amountCents: number;
  currency: "USD";
  startsAt: string | null;
  endsAt: string | null;
  configured: boolean;
};
export const policyDays = 15;
export type PaymentView = {
  id: string;
  paidAt: string;
  amountCents: number | null;
  currency: string | null;
  source: "signed_status" | "manual_receipt" | "patreon_api";
  reference: string;
  verificationState: "verified" | "unverified";
  firstSuccessfulPaymentVerified: boolean;
};
export type SupporterView = {
  id: string;
  patreonMemberId: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: string | null;
  observedAt: string;
  reviewState: "pending" | "verified" | "unverified";
  discordId: string | null;
  steamId: string | null;
  identityState: "unlinked" | "staff_linked";
  version: number;
  latestPayment: PaymentView | null;
  founderEligiblePayment: PaymentView | null;
  founder: { awardedAt: string; paymentId: string } | null;
};
