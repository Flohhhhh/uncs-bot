import type {
  FounderPolicy,
  NextStep,
  PatreonSyncStatus,
  PaymentEvidence,
  Supporter,
  SupporterDecision,
  SupporterReviewInput,
} from "./types";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";

/** The record's name, or which kind of supporter it is when it has none. */
export const recordName = (record: Supporter) =>
  record.displayName || (record.provider === "paypal" ? "PayPal supporter" : "Patreon member");

const paymentSources: Record<string, string> = {
  patreon_api: "from Patreon",
  manual_receipt: "added by staff",
  paypal: "PayPal",
  signed_status: "status only",
};
/** "5.00 USD · from Patreon · first payment", or "No payment yet". */
export function paymentLine(payment: PaymentEvidence | null) {
  if (!payment) return "No payment yet";
  const amount =
    typeof payment.amountCents === "number"
      ? `${(payment.amountCents / 100).toFixed(2)} ${payment.currency ?? ""}`.trim()
      : null;
  // A signed status is never a payment. Any other payment Patreon stopped reporting as paid says so first.
  const source =
    payment.source === "signed_status"
      ? paymentSources.signed_status
      : payment.verificationState !== "verified"
        ? "no longer paid"
        : (paymentSources[payment.source] ?? payment.source);
  return [amount, source, payment.firstSuccessfulPaymentVerified ? "first payment" : null]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The server decides founder eligibility; the dashboard only follows its verdict. */
export function founderReady(record: Supporter) {
  return !record.founder && record.founderBlockedReason === null && Boolean(record.founderEligiblePayment);
}

/** Where the Discord account came from. */
export const discordSource = (record: Supporter) =>
  record.discordSource === "patreon"
    ? "From Patreon"
    : record.discordSource === "staff"
      ? "Added by staff"
      : "Added earlier";
/** Where the SteamID came from. */
export const steamSource = (record: Supporter) =>
  record.steamSource === "application"
    ? "From their application"
    : record.steamSource === "staff"
      ? "Added by staff"
      : "Added earlier";

/**
 * The supporter's provider and payment state for the table's small line. A Patreon charge that was not paid is the
 * one worth a warning.
 */
export function providerLine(record: Supporter): { text: string; warn: boolean } {
  if (record.provider === "paypal") return { text: "PayPal", warn: false };
  const charge = record.lastChargeStatus;
  if (charge && charge !== "Paid") return { text: `Patreon · last charge ${charge}`, warn: true };
  const statuses: Record<string, string> = {
    active_patron: "Patreon",
    declined_patron: "Patreon · payment issue",
    former_patron: "Patreon · former",
  };
  const status = record.patronStatus;
  return { text: status ? (statuses[status] ?? `Patreon · ${status}`) : "Patreon · not paying", warn: false };
}

type SyncLists = Pick<PatreonSyncStatus, "founderReviews" | "conflictDetails">;
/** What the last import found about a founder's payment, as one sentence. */
export const founderReviewSentences: Record<string, string> = {
  unverified: "Patreon no longer shows their founder payment as paid.",
  not_first_payment: "Their founder payment is no longer their first payment.",
};
/** What the last import found about a Discord account, as one sentence. */
export const conflictSentences: Record<string, string> = {
  "discord-in-use": "Their Discord account is already on another supporter.",
  "discord-differs": "Patreon shows a different Discord account.",
};
const conflictFor = (record: Supporter, sync: SyncLists | null | undefined) =>
  sync?.conflictDetails.find((conflict) => conflict.supporterId === record.id);

/** Gramps, or the supporter, does these next. Nothing for staff to do. */
const WAITING_CODES = new Set([
  "connect_discord_in_patreon",
  "steam_ready_automatic",
  "founder_ready_automatic",
  "founder_automatic_waiting",
]);
/** A missing whitelist application matters only once the whitelist promise is used, so it is shown in the record only. */
const LATER_CODES = new Set([
  "no_whitelist_application",
  "application_pending",
  "application_in_progress",
  "no_approved_application",
]);

export type RowState = {
  /** `needs` while staff have something to do, `waiting` while Gramps or the supporter does, otherwise `set`. */
  state: "needs" | "waiting" | "set";
  /** Founder payments to check, a Discord conflict, then the server's steps for staff. */
  needs: string[];
  waiting: string[];
  /** Whitelist application steps, shown in the record only. */
  later: string[];
  /** Why this record cannot be a founder. */
  notes: string[];
};

/**
 * Sorts a record's next steps by who acts on them. Payment steps and notes say why the record is not a founder and
 * grant nothing, so they are notes. A step this page does not know lands in `needs`, so nothing new is hidden.
 */
export function rowState(record: Supporter, sync?: SyncLists | null): RowState {
  const waiting: string[] = [];
  const later: string[] = [];
  const notes: string[] = [];
  const tasks: NextStep[] = [];
  const noAccount = !record.discordId && !record.steamId;
  for (const step of record.nextSteps) {
    if (step.area === "payment" || step.area === "info" || step.code === "founder_window_not_configured")
      notes.push(step.message);
    else if (WAITING_CODES.has(step.code) || (step.code === "founder_no_identity" && noAccount))
      waiting.push(step.message);
    else if (LATER_CODES.has(step.code)) later.push(step.message);
    else tasks.push(step);
  }
  const reviews = (sync?.founderReviews ?? [])
    .filter((review) => review.supporterId === record.id)
    .map((review) => founderReviewSentences[review.reviewReason] ?? "Check their founder payment in Patreon.");
  const needs = [...new Set(reviews)];
  const conflict = conflictFor(record, sync);
  // A Discord step already says what is wrong with the account.
  if (conflict && !tasks.some((step) => step.area === "discord"))
    needs.push(conflictSentences[conflict.reason] ?? "Check their Discord account.");
  needs.push(...tasks.map((step) => step.message));
  return { state: needs.length ? "needs" : waiting.length ? "waiting" : "set", needs, waiting, later, notes };
}
export const stateRank: Record<RowState["state"], number> = { needs: 0, waiting: 1, set: 2 };

/** Discord steps that mean the linked or reported account needs a person to check it. */
const DISCORD_CHECK_CODES = new Set([
  "discord_on_another_record",
  "discord_not_reported",
  "discord_differs",
  "discord_reported_for_other_patron",
]);
export type DiscordCell = { text: string; warn: boolean; detail?: string; rank: number };
/** The table's Discord column. The first match wins, and `rank` sorts problems first. */
export function discordCell(record: Supporter, sync?: SyncLists | null): DiscordCell {
  if (record.nextSteps.some((step) => DISCORD_CHECK_CODES.has(step.code)) || conflictFor(record, sync))
    return { text: "Check", warn: true, rank: 0 };
  if (record.discordId) return { text: "Linked", warn: false, detail: discordSource(record), rank: 4 };
  if (
    record.provider === "paypal" ||
    record.needsDiscordLink ||
    record.nextSteps.some((step) => step.code === "link_discord_no_import")
  )
    return { text: "Missing", warn: true, rank: 1 };
  if (record.patreonDiscordId) return { text: "Linking soon", warn: false, rank: 3 };
  return { text: "Not connected", warn: false, rank: 2 };
}

/**
 * The SteamID an approved application offers staff to check and link when the record has none: only one the SteamID
 * rule accepts, or one approved without a recorded grant. A SteamID that is shared, was rejected before, is held by
 * another record, is invalid, or is under review is never offered. It is never filled in.
 */
const OFFERED_REASONS = new Set<string | null>([null, "application_not_confirmed"]);
export function applicationSteamId(record: Supporter) {
  const steam = record.match.steam;
  return !record.steamId && steam?.steamId && OFFERED_REASONS.has(steam.reason) ? steam.steamId : null;
}

export function reviewInput(
  record: Supporter,
  decision: SupporterDecision,
  id: string,
  values: FormData,
): SupporterReviewInput {
  const reason = String(values.get("reason") ?? "").trim();
  if (
    reason.length < 3 ||
    reason.length > 200 ||
    [...reason].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("Enter a single-line review reason between 3 and 200 characters.");
  const base = { id, version: record.version, confirm: record.confirmKey, reason };
  if (decision === "link") {
    const discordId = String(values.get("discordId") ?? "").trim();
    const steamId = String(values.get("steamId") ?? "").trim();
    if (!discordId && !steamId) throw new Error("Enter a Discord user ID or a SteamID64.");
    if (discordId && !/^\d{17,20}$/.test(discordId))
      throw new Error("Enter the Discord user ID (17 to 20 digits), not a display name.");
    if (steamId && !isPublicIndividualSteamId(steamId)) throw new Error("Enter the player’s 17-digit SteamID64.");
    // Only a value that changes is sent, so an unchanged identity keeps where it came from.
    const discordChanged = Boolean(discordId) && discordId !== record.discordId;
    const steamChanged = Boolean(steamId) && steamId !== record.steamId;
    const confirmed = values.get("steamConfirmed") === "on";
    // A SteamID from the current Discord account's application must not follow a new Discord account unconfirmed.
    if (discordChanged && !steamChanged && record.steamSource === "application" && !confirmed)
      throw new Error(
        "This SteamID was copied from the old Discord account’s application. Confirm it belongs to the new account, or enter the right SteamID64.",
      );
    if (discordChanged && steamChanged && steamId === record.match.steam?.steamId && !confirmed)
      throw new Error(
        "The current Discord account applied for the whitelist with this SteamID. Confirm it belongs to the new Discord account too, or enter the right SteamID64.",
      );
    // The server can know of an application this page does not show, so a confirmation goes with any SteamID that
    // stays with, or arrives with, a new Discord account.
    const steamConfirmed = discordChanged && confirmed && Boolean(steamChanged ? steamId : record.steamId);
    if (!discordChanged && !steamChanged)
      throw new Error("Change the Discord user ID or the SteamID64 before saving. Unchanged values are kept.");
    return {
      ...base,
      ...(discordChanged ? { discordId } : {}),
      ...(steamChanged ? { steamId } : {}),
      ...(steamConfirmed ? { steamConfirmed: true as const } : {}),
    };
  }
  if (decision === "payment") {
    const paidAt = new Date(String(values.get("paidAt") ?? ""));
    const amountText = String(values.get("amount") ?? "").trim();
    const amountCents = Math.round(Number(amountText) * 100);
    const reference = String(values.get("reference") ?? "").trim();
    if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now() + 300_000)
      throw new Error("Enter a completed payment date that is not in the future.");
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(amountText) ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 1 ||
      amountCents > 100_000_000
    )
      throw new Error("Enter a USD amount from 0.01 to 1000000.00 with at most two decimal places.");
    if (reference.length < 3 || reference.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/.test(reference))
      throw new Error("Enter the completed Patreon payment reference, using 3 to 120 characters.");
    if (values.get("completedPaymentVerified") !== "on")
      throw new Error("Confirm that you checked the completed payment in Patreon.");
    return {
      ...base,
      paidAt: paidAt.toISOString(),
      amountCents,
      currency: "USD",
      reference,
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: values.get("firstSuccessfulPaymentVerified") === "on",
    };
  }
  if (decision === "founder") {
    if (!founderReady(record) || !record.founderEligiblePayment)
      throw new Error(record.founderBlockedMessage ?? "This supporter cannot be made a founder yet.");
    return { ...base, paymentId: record.founderEligiblePayment.id };
  }
  return base;
}

/** Founder dates are set and shown in New York time. */
export const newYork = "America/New_York";
/** Hour, minute and zone abbreviation of an instant in New York. */
function newYorkParts(time: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: newYork,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    timeZoneName: "short",
  }).formatToParts(time);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return { midnight: Number(part("hour")) === 0 && Number(part("minute")) === 0, zone: part("timeZoneName") };
}
/** "Founder window Sep 30–Oct 14 (EDT)". The end is exclusive, so a midnight end shows the day before. */
export function founderWindowLabel(policy: FounderPolicy) {
  const start = Date.parse(policy.startsAt ?? "");
  const end = Date.parse(policy.endsAt ?? "");
  if (!policy.configured || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return "Founder window · dates not set";
  const day = (time: number) =>
    new Date(time).toLocaleDateString(undefined, { timeZone: newYork, month: "short", day: "numeric" });
  const moment = (time: number) =>
    new Date(time).toLocaleString(undefined, {
      timeZone: newYork,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const from = newYorkParts(start);
  const to = newYorkParts(end);
  const zone = from.zone === to.zone ? from.zone : "New York time";
  return `Founder window ${from.midnight ? day(start) : moment(start)}${to.midnight ? `–${day(end - 1)}` : ` until ${moment(end)}`} (${zone})`;
}
