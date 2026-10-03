import type {
  FounderPolicy,
  NextStep,
  PaymentEvidence,
  Supporter,
  SupporterDecision,
  SupporterReviewInput,
} from "./types";
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
    return reported
      ? `Patreon reports Discord account ${reported}, which another supporter record links.`
      : "Record the account after confirming the member’s identity.";
  const patreon =
    record.provider !== "patreon" || !reported
      ? ""
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

/** The SteamID an approved application offers, for staff to check when the record has none. */
export function applicationSteamId(record: Supporter) {
  return !record.steamId && record.match.steam?.steamId && record.match.steam.reason !== "application_pending"
    ? record.match.steam.steamId
    : null;
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
export const accountsToMatch = (record: Supporter) =>
  record.identityState === "unlinked" || record.identityState === "partial";

/** Steps grouped for the record dialog; payment problems share one heading. */
export function stepGroups(steps: NextStep[]) {
  return {
    payment: steps.filter((step) => step.area === "payment"),
    other: steps.filter((step) => step.area !== "payment"),
  };
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
    const steamConfirmed =
      discordChanged && !steamChanged && record.steamSource === "application" && values.get("steamConfirmed") === "on";
    if (discordChanged && !steamChanged && record.steamSource === "application" && !steamConfirmed)
      throw new Error(
        "This SteamID was copied from the old Discord account’s application. Confirm it belongs to the new account, or enter the right SteamID64.",
      );
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
