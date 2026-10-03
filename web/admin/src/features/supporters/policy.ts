import type { NextStep, PaymentEvidence, Supporter, SupporterDecision, SupporterReviewInput } from "./types";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";

export function paymentDescription(payment: PaymentEvidence | null) {
  if (!payment) return "No payment evidence recorded";
  const amount =
    typeof payment.amountCents === "number"
      ? `${(payment.amountCents / 100).toFixed(2)} ${payment.currency || "currency not recorded"}`
      : "Amount not established";
  const history = payment.firstSuccessfulPaymentVerified
    ? "first payment history checked"
    : "first payment history not confirmed";
  const evidence =
    payment.source === "manual_receipt"
      ? `receipt checked by staff · ${history}`
      : payment.source === "patreon_api"
        ? `${payment.verificationState === "verified" ? "checked by the Patreon import" : "Patreon import no longer reports this charge as paid"} · ${history}`
        : payment.source === "paypal"
          ? `PayPal payment checked by staff · ${history}`
          : "provider status only";
  return `${amount} · ${evidence}`;
}

/** The server decides founder eligibility; the dashboard only follows its verdict. */
export function founderReady(record: Supporter) {
  return !record.founder && record.founderBlockedReason === null && Boolean(record.founderEligiblePayment);
}

/** How the Discord account was linked, in staff-facing words. */
export function discordDescription(record: Supporter) {
  const reported = record.patreonDiscordId;
  if (!record.discordId)
    return !reported
      ? "Record the account after confirming the member’s identity."
      : record.match.patreonDiscordElsewhere
        ? `Patreon reports Discord account ${reported}, which another supporter record links.`
        : `Patreon reports Discord account ${reported}. It is not linked yet.`;
  // The server raises this step only while the import keeps Patreon's answer current.
  const notReported = record.nextSteps.some((step) => step.code === "discord_not_reported");
  const patreon =
    record.provider !== "patreon"
      ? ""
      : !reported
        ? notReported
          ? " Patreon does not currently report this account."
          : ""
        : reported === record.discordId
          ? " Patreon reports the same account."
          : ` Patreon now reports a different account: ${reported}.`;
  if (record.discordSource === "patreon") return `From Patreon (the patron connected it).${patreon}`;
  if (record.discordSource === "staff") return `Entered by staff; not verified through Discord sign-in.${patreon}`;
  return `Linked before match sources were recorded.${patreon}`;
}

/** How the SteamID was linked, in staff-facing words. Steam ownership is never verified here. */
export function steamDescription(record: Supporter) {
  if (!record.steamId) return "Not linked yet.";
  if (record.steamSource === "application") {
    const server = record.match.sourceApplication?.serverId;
    return `Copied from the approved whitelist application${server ? ` on server ${server}` : ""}. Steam ownership is not verified.`;
  }
  if (record.steamSource === "staff") return "Entered by staff; Steam ownership is not verified by this page.";
  return "Linked before match sources were recorded; Steam ownership is not verified.";
}

export const identityLabels: Record<Supporter["identityState"], string> = {
  patreon_linked: "Discord from Patreon",
  staff_linked: "Staff-linked",
  partial: "Partly matched",
  unlinked: "Not linked",
};
const sourceLabel = (value: string | null, source: string | null) =>
  !value ? "not linked" : source === "patreon" ? "Patreon" : source === "application" ? "application" : "staff";
/** One line for the table: where each identity came from. */
export function matchSummary(record: Supporter) {
  return `Discord: ${sourceLabel(record.discordId, record.discordSource)} · SteamID: ${sourceLabel(record.steamId, record.steamSource)}`;
}

/**
 * The SteamID an approved application offers staff to check and link when the record has none: only one the SteamID
 * rule accepts, or one approved without a recorded grant. A SteamID that is shared, was rejected before, is held by
 * another record, is invalid, or is under review is never offered.
 */
const OFFERED_REASONS = new Set<string | null>([null, "application_not_confirmed"]);
export function applicationSteamId(record: Supporter) {
  const steam = record.match.steam;
  return !record.steamId && steam?.steamId && OFFERED_REASONS.has(steam.reason) ? steam.steamId : null;
}

const READY_FOR_STAFF = new Set([
  "founder_ready_staff",
  "founder_ready_automatic_off",
  "founder_automatic_waiting",
  "application_not_confirmed",
  "steam_available",
]);
export const readyForStaff = (record: Supporter) => record.nextSteps.some((step) => READY_FOR_STAFF.has(step.code));
/** Founder promises automation would record: now, or with automatic recording switched on. */
export const automaticPreview = (record: Supporter) =>
  record.nextSteps.some(
    (step) => step.code === "founder_ready_automatic" || step.code === "founder_ready_automatic_off",
  );
/** Records with a Discord or SteamID step left: something staff can still match or check. */
export const accountsToMatch = (record: Supporter) =>
  record.nextSteps.some((step) => step.area === "discord" || step.area === "steam");
/** Steps staff can act on; `info` notes only say why no founder promise is possible. */
export const actionableSteps = (record: Supporter) => record.nextSteps.filter((step) => step.area !== "info");

/** Steps grouped for the record dialog; payment problems share one heading, and notes are kept apart from tasks. */
export function stepGroups(steps: NextStep[]) {
  return {
    payment: steps.filter((step) => step.area === "payment"),
    other: steps.filter((step) => step.area !== "payment" && step.area !== "info"),
    info: steps.filter((step) => step.area === "info"),
  };
}

const identityRank: Record<Supporter["identityState"], number> = {
  unlinked: 0,
  partial: 1,
  staff_linked: 2,
  patreon_linked: 3,
};
/** Sorts the account match column from least to most matched. */
export const identityOrder = (record: Supporter) => identityRank[record.identityState];

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
      throw new Error(record.founderBlockedMessage ?? "This supporter cannot be recorded as a founder yet.");
    return { ...base, paymentId: record.founderEligiblePayment.id };
  }
  return base;
}
