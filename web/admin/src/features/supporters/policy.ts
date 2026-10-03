import type { FounderPolicy, PaymentEvidence, Supporter, SupporterDecision, SupporterReviewInput } from "./types";
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
        : "provider status only";
  return `${amount} · ${evidence}`;
}

export function founderReady(record: Supporter, policy: FounderPolicy) {
  const payment = record.founderEligiblePayment;
  const paidAt = Date.parse(payment?.paidAt ?? "");
  return Boolean(
    policy.configured &&
    record.identityState === "staff_linked" &&
    record.discordId &&
    isPublicIndividualSteamId(record.steamId) &&
    (payment?.source === "manual_receipt" || payment?.source === "patreon_api") &&
    payment.verificationState === "verified" &&
    payment.firstSuccessfulPaymentVerified === true &&
    payment.currency === policy.currency &&
    payment.amountCents !== null &&
    payment.amountCents >= policy.amountCents &&
    paidAt >= Date.parse(policy.startsAt ?? "") &&
    paidAt < Date.parse(policy.endsAt ?? "") &&
    !record.founder,
  );
}

export function reviewInput(
  record: Supporter,
  decision: SupporterDecision,
  id: string,
  values: FormData,
  policy: FounderPolicy,
): SupporterReviewInput {
  const reason = String(values.get("reason") ?? "").trim();
  if (
    reason.length < 3 ||
    reason.length > 200 ||
    [...reason].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("Enter a single-line review reason between 3 and 200 characters.");
  const base = { id, version: record.version, confirm: record.patreonMemberId, reason };
  if (decision === "link") {
    const discordId = String(values.get("discordId") ?? "").trim();
    const steamId = String(values.get("steamId") ?? "").trim();
    if (!/^\d{17,20}$/.test(discordId) || !isPublicIndividualSteamId(steamId))
      throw new Error("Enter the Discord user ID and the player’s 17-digit SteamID64.");
    return { ...base, discordId, steamId };
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
    if (!founderReady(record, policy) || !record.founderEligiblePayment)
      throw new Error(
        "A configured launch window, matched accounts and a qualifying checked first payment are required.",
      );
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
