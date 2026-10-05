import type { FounderPolicy, PaymentEvidence, Supporter, SupporterDecision, SupporterReviewInput } from "./types";
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

/**
 * Steps that tie the record to another one that may be the same person: it holds a SteamID they applied with, or it
 * paid earlier. The staff founder rule compares this record alone, so Make founder stays hidden while one shows.
 */
const OTHER_RECORD_CODES = new Set([
  "steam_on_another_record",
  "founder_steam_on_another_record",
  "founder_earlier_payment_other_record",
]);
/** Whether the record offers Make founder: the server's verdict, unless another record may be the same person. */
export function founderOffered(record: Supporter) {
  return founderReady(record) && !record.nextSteps.some((step) => OTHER_RECORD_CODES.has(step.code));
}

/** Where the Discord account came from. The patron links one themselves by signing in with Link Patreon. */
export const discordSource = (record: Supporter) =>
  record.discordSource === "patreon"
    ? "From Patreon"
    : record.discordSource === "patron_signin"
      ? "Linked by patron"
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

/**
 * Gramps, Patreon or the supporter does these next. Nothing for staff to do. A below-minimum step that is not a note
 * is a Patreon payment in another currency, which every sync checks against its tier's price again.
 */
const WAITING_CODES = new Set([
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
/** A missing whitelist application matters only once the whitelist promise is used, so it is shown in the record only. */
const LATER_CODES = new Set([
  "no_whitelist_application",
  "application_pending",
  "application_in_progress",
  "no_approved_application",
]);
/**
 * A founder needs no SteamID, so these SteamID steps and alerts matter only for the whitelist promise later, on every
 * record. A SteamID another record holds is a real conflict, so it stays a task.
 */
const STEAM_LATER_CODES = new Set([
  "application_not_confirmed",
  "several_steam_ids",
  "invalid_steam_id",
  "steam_shared",
  "steam_rejected_before",
  "steam_available",
  "source_application_revoked",
  "steam_differs_from_application",
  "linked_steam_shared",
]);

export type RowState = {
  /** `needs` while staff have something to do, `waiting` while Gramps, Patreon or the supporter does, else `set`. */
  state: "needs" | "waiting" | "set";
  /** The server's steps only staff can take. */
  needs: string[];
  waiting: string[];
  /** Steps that matter only for the whitelist promise later, shown in the record only. */
  later: string[];
  /** Why this record cannot be a founder. */
  notes: string[];
};

/**
 * Sorts a record's next steps by who acts on them; the first match wins. Payment steps and notes say why the record
 * is not a founder and grant nothing, so they are notes. A step this page does not know lands in `needs`, so nothing
 * new is hidden. Each line shows once, though two steps can wait for the same thing.
 */
export function rowState(record: Supporter): RowState {
  const needs = new Set<string>();
  const waiting = new Set<string>();
  const later = new Set<string>();
  const notes = new Set<string>();
  const noAccount = !record.discordId && !record.steamId;
  const patreon = record.provider === "patreon";
  for (const step of record.nextSteps) {
    if (step.area === "payment" || step.area === "info" || step.code === "founder_window_not_configured")
      notes.add(step.message);
    else if (
      WAITING_CODES.has(step.code) ||
      (step.code === "founder_no_identity" && noAccount) ||
      (step.code === "founder_needs_discord" && patreon)
    )
      waiting.add(step.message);
    else if (LATER_CODES.has(step.code) || STEAM_LATER_CODES.has(step.code)) later.add(step.message);
    else needs.add(step.message);
  }
  return {
    state: needs.size ? "needs" : waiting.size ? "waiting" : "set",
    needs: [...needs],
    waiting: [...waiting],
    later: [...later],
    notes: [...notes],
  };
}
export const stateRank: Record<RowState["state"], number> = { needs: 0, waiting: 1, set: 2 };

/**
 * Discord steps that mean the linked or reported account needs a person to check it, including a patron's own
 * Link Patreon sign-in that Gramps refused because it would replace a link.
 */
const DISCORD_CHECK_CODES = new Set([
  "discord_on_another_record",
  "discord_differs",
  "discord_reported_for_other_patron",
  "patron_link_conflict",
]);
export type DiscordCell = { text: string; warn: boolean; detail?: string; rank: number };
/**
 * The table's Discord column. The first match wins, and `rank` sorts problems first. Only a PayPal record misses an
 * account staff must add: a Patreon one arrives from Patreon.
 */
export function discordCell(record: Supporter): DiscordCell {
  if (record.nextSteps.some((step) => DISCORD_CHECK_CODES.has(step.code)))
    return { text: "Check", warn: true, rank: 0 };
  if (record.discordId) return { text: "Linked", warn: false, detail: discordSource(record), rank: 4 };
  if (record.provider === "paypal") return { text: "Missing", warn: true, rank: 1 };
  if (record.patreonDiscordId) return { text: "Linking soon", warn: false, rank: 3 };
  return { text: "Not connected", warn: false, rank: 2 };
}

/**
 * Whether the record offers Add payment: a Patreon record while the Patreon import is not set up, with a payment step
 * or no paid payment on record. While the import runs it brings in every payment itself. A PayPal record records its
 * payments in the PayPal form.
 */
export function paymentOffered(record: Supporter, importConfigured: boolean) {
  if (record.provider !== "patreon" || importConfigured) return false;
  if (record.nextSteps.some((step) => step.area === "payment")) return true;
  const payment = record.latestPayment;
  return (
    !payment ||
    payment.verificationState !== "verified" ||
    payment.source === "signed_status" ||
    typeof payment.amountCents !== "number"
  );
}

/**
 * The SteamID an approved application offers staff to check and link when the record has none: one the SteamID rule
 * accepts, one approved without a recorded grant, or one another record holds, which the record's step asks staff to
 * link here when they are the same person. A SteamID that is shared, was rejected before, is invalid, or is under
 * review is never offered. It is never filled in.
 */
const OFFERED_REASONS = new Set<string | null>([null, "application_not_confirmed", "steam_on_another_record"]);
export function applicationSteamId(record: Supporter) {
  const steam = record.match.steam;
  return !record.steamId && steam?.steamId && OFFERED_REASONS.has(steam.reason) ? steam.steamId : null;
}

/** The request body for a staff action. */
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
  if (!founderReady(record) || !record.founderEligiblePayment)
    throw new Error(record.founderBlockedMessage ?? "This supporter cannot be made a founder yet.");
  return { ...base, paymentId: record.founderEligiblePayment.id };
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
