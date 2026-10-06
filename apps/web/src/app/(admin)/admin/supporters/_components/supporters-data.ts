import { z } from "zod";

import { readAdminApi } from "~/components/overview/overview-data";

export const supportersApiPath = "/admin/api/supporters";

const supporterSchema = z.object({
  id: z.string(),
  provider: z.enum(["patreon", "paypal"]),
  patreonMemberId: z.string().nullable(),
  displayName: z.string().nullable(),
  patronStatus: z.string().nullable(),
  lastChargeStatus: z.string().nullable(),
  observedAt: z.string(),
  reviewState: z.enum(["pending", "verified", "unverified"]),
  discordId: z.string().nullable(),
  steamId: z.string().nullable(),
  latestPayment: z
    .object({
      paidAt: z.string(),
      amountCents: z.number().nullable(),
      currency: z.string().nullable(),
      verificationState: z.enum(["verified", "unverified"]),
    })
    .nullable(),
  founder: z
    .object({
      awardedAt: z.string(),
      automatic: z.boolean().optional(),
    })
    .nullable(),
  nextSteps: z.array(
    z.object({
      code: z.string(),
      area: z.enum(["discord", "steam", "payment", "founder", "info"]),
      message: z.string(),
    }),
  ),
});

export const supportersResponseSchema = z.object({
  configured: z.boolean(),
  founderPolicy: z.object({ amountCents: z.number(), currency: z.literal("USD"), configured: z.boolean() }),
  supporters: z.array(supporterSchema),
  sync: z.object({ configured: z.boolean(), running: z.boolean() }),
});

export type SupporterRecord = z.infer<typeof supporterSchema>;
export type SupportersResponse = z.infer<typeof supportersResponseSchema>;

export function readSupporters() {
  return readAdminApi(supportersApiPath, supportersResponseSchema);
}

export function supporterSearchText(supporter: SupporterRecord) {
  return [
    supporter.displayName,
    supporter.provider,
    supporter.patreonMemberId,
    supporter.discordId,
    supporter.steamId,
    supporter.patronStatus,
    supporter.lastChargeStatus,
    supporter.reviewState,
    ...supporter.nextSteps.map((step) => step.message),
    supporter.latestPayment?.amountCents === null || supporter.latestPayment?.amountCents === undefined
      ? null
      : String(supporter.latestPayment.amountCents / 100),
    supporter.latestPayment?.currency,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

const waitingStepCodes = new Set([
  "connect_discord_in_patreon",
  "link_discord_no_import",
  "steam_ready_automatic",
  "founder_ready_automatic",
  "founder_automatic_waiting",
  "founder_ready_automatic_off",
  "founder_below_minimum",
  "founder_not_first_payment",
  "founder_source_not_qualifying",
  "founder_waiting_patreon",
  "founder_waiting_discord",
]);
const laterStepCodes = new Set([
  "no_whitelist_application",
  "application_pending",
  "application_in_progress",
  "no_approved_application",
  "application_not_confirmed",
  "several_steam_ids",
  "invalid_steam_id",
  "steam_shared",
  "steam_rejected_before",
  "steam_available",
  "source_application_revoked",
  "steam_differs_from_application",
  "linked_steam_shared",
  "founder_window_not_configured",
]);

export function supporterWorkState(supporter: SupporterRecord) {
  let waiting = false;
  const noAccount = !supporter.discordId && !supporter.steamId;

  for (const step of supporter.nextSteps) {
    if (step.area === "payment" || step.area === "info" || laterStepCodes.has(step.code)) continue;
    if (
      waitingStepCodes.has(step.code) ||
      (step.code === "founder_no_identity" && noAccount) ||
      (step.code === "founder_needs_discord" && supporter.provider === "patreon")
    ) {
      waiting = true;
      continue;
    }
    return "needs" as const;
  }

  return waiting ? ("waiting" as const) : ("set" as const);
}

export function supporterNextStep(supporter: SupporterRecord) {
  const state = supporterWorkState(supporter);
  const detail = supporter.nextSteps.find((step) => {
    if (step.area === "payment" || step.area === "info" || laterStepCodes.has(step.code)) return false;
    return state === "needs"
      ? !waitingStepCodes.has(step.code) &&
          !(step.code === "founder_no_identity" && !supporter.discordId && !supporter.steamId) &&
          !(step.code === "founder_needs_discord" && supporter.provider === "patreon")
      : waitingStepCodes.has(step.code) ||
          (step.code === "founder_no_identity" && !supporter.discordId && !supporter.steamId) ||
          (step.code === "founder_needs_discord" && supporter.provider === "patreon");
  })?.message;

  return { state, detail: detail ?? (state === "set" ? "No action needed" : undefined) };
}

export function formatSupporterDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "—";
}

export function formatSupporterPayment(supporter: SupporterRecord) {
  const payment = supporter.latestPayment;
  if (!payment) return "No payment recorded";
  const amount =
    payment.amountCents === null
      ? "Amount unavailable"
      : `${(payment.amountCents / 100).toFixed(2)} ${payment.currency ?? ""}`.trim();
  return `${amount} · ${formatSupporterDate(payment.paidAt)}`;
}

export class SupporterSyncError extends Error {}

const paypalResponseSchema = z.object({
  ok: z.literal(true),
  replayed: z.boolean(),
  supporter: z.object({ id: z.string() }).nullable(),
  payment: z.object({ reference: z.string() }).nullable(),
  founder: z.object({ awarded: z.boolean() }).nullable(),
});

export type PaypalSupporterInput = {
  id: string;
  displayName: string;
  discordId?: string;
  steamId?: string;
  paidAt: string;
  amountCents: number;
  currency: string;
  transactionId: string;
  completedPaymentVerified: true;
  firstSuccessfulPaymentVerified: boolean;
  minimumConfirmed: boolean;
  awardFounder: boolean;
  reason: string;
};

export class PaypalSupporterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly blockedReason: string | null = null,
  ) {
    super(message);
  }
}

export async function recordPaypalSupporter(csrf: string, input: PaypalSupporterInput) {
  let response: Response;
  try {
    response = await fetch(`${supportersApiPath}/paypal`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new PaypalSupporterError(
      "The save could not be confirmed. Save again to check; the same payment will not be recorded twice.",
      null,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? body.message
        : "The PayPal payment could not be recorded.";
    const blockedReason =
      typeof body === "object" && body !== null && "blockedReason" in body && typeof body.blockedReason === "string"
        ? body.blockedReason
        : null;
    throw new PaypalSupporterError(message, response.status, blockedReason);
  }

  const parsed = paypalResponseSchema.safeParse(body);
  if (
    !parsed.success ||
    !parsed.data.supporter?.id ||
    parsed.data.payment?.reference !== input.transactionId.toUpperCase() ||
    !parsed.data.founder
  ) {
    throw new PaypalSupporterError(
      "The save could not be confirmed. Save again to check; the same payment will not be recorded twice.",
      null,
    );
  }
  return { replayed: parsed.data.replayed, founderAwarded: parsed.data.founder.awarded };
}

export async function syncPatreon(csrf: string) {
  let response: Response;
  try {
    response = await fetch(`${supportersApiPath}/sync`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new SupporterSyncError(
      "The sync request ended before it could be confirmed. The status will update shortly.",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? body.message
        : "Patreon could not be synced.";
    throw new SupporterSyncError(message);
  }

  const parsed = z.object({ ok: z.literal(true) }).safeParse(body);
  if (!parsed.success)
    throw new SupporterSyncError("The sync response could not be verified. Check the status shortly.");
}
