import type { FounderPolicy, PaymentEvidence, Supporter, SupporterDecision, SupporterReviewInput } from "./types";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";

export function paymentDescription(payment: PaymentEvidence | null) {
  if (!payment) return "No payment evidence recorded";
  const amount =
    typeof payment.amountCents === "number"
      ? `${(payment.amountCents / 100).toFixed(2)} ${payment.currency || "currency not recorded"}`
      : "Amount not established";
  const evidence =
    payment.source === "manual_receipt"
      ? `receipt checked by staff · ${payment.firstSuccessfulPaymentVerified ? "first payment history checked" : "first payment history not confirmed"}`
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
    payment?.source === "manual_receipt" &&
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
