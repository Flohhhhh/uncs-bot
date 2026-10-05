import { isPublicIndividualSteamId } from "../common/steam-id";
import type { SupporterDiscordSource, SupporterProvider, SupporterSteamSource } from "../database/supporters.schema";
import { PATREON_REVERSED_CHARGE_STATUSES } from "./patreon.client";
import { founderBlockedMessages, type FounderBlockedReason, type PaymentView } from "./supporters.types";

/**
 * Automatic supporter matching fills a Patreon supporter's empty SteamID from their approved whitelist application
 * and, separately, records a founder promise under a stricter rule than staff awards. These are the pure rules; the
 * SQL that gathers their facts is in founder-rules.ts, so the Supporters page and the automatic writes read the same
 * facts the same way.
 */
export const SUPPORTER_MATCH_ACTOR = { id: "system:supporter-match", name: "Automatic supporter match" } as const;
export const AUTO_FOUNDER_REASON =
  "Recorded automatically: Discord account from Patreon and a first Patreon payment inside the founder window.";
/** Default wait after an imported first payment before an automatic founder promise (Patreon's refund window). */
export const AUTO_FOUNDER_HOLD_HOURS_DEFAULT = 72;

/** One whitelist application of the supporter's Discord account, on any server. Never includes contact details. */
export type ApplicationFact = {
  id: string;
  serverId: string;
  steamId: string;
  status: "pending" | "processing" | "approved" | "declined" | "needs_review" | "revoking" | "revoked";
  accessIntent: "grant" | "revoke";
  whitelistGrant: "granted" | "existing" | null;
  revokedAt: string | null;
  reviewedAt: string | null;
  /** Another Discord account has an application for this SteamID that was not declined or revoked. */
  otherDiscordClaim: boolean;
  /** Any application for this SteamID, from any Discord account on any server, was declined or revoked. */
  rejectedBefore: boolean;
  /** Another supporter record (any PayPal record, or a Patreon record of the campaign) holds this SteamID. */
  otherSupporter: boolean;
};
export type SteamMatchBlock =
  | "no_application"
  | "application_in_progress"
  | "application_pending"
  | "no_approved_application"
  | "several_steam_ids"
  | "invalid_steam_id"
  | "application_not_confirmed"
  | "steam_shared"
  | "steam_rejected_before"
  | "steam_on_another_record";
/**
 * The SteamID an approved application offers for this Discord account. `reason` is null for a SteamID automatic
 * matching may copy; otherwise it names why not. The SteamID and application are given whenever one is known, so
 * staff can check it.
 */
export type SteamMatch = {
  reason: SteamMatchBlock | null;
  steamId: string | null;
  applicationId: string | null;
  serverId: string | null;
};
/** The facts automatic matching reads for one supporter record, gathered by one shared SQL builder. */
export type MatchFacts = {
  /** The Discord account's applications, empty without a Discord account. */
  applications: ApplicationFact[];
  /** The earliest verified first Patreon API payment, with the founder rule's earlier-payment checks. */
  automatic: { payment: PaymentView; earlier: boolean; earlierOtherRecord: boolean } | null;
  /** Patreon reports this record's Discord account for another patron of the campaign. */
  discordReportedForOtherPatron: boolean;
  /** Patreon reports a different Discord account for this record, and another record of the campaign links it. */
  patreonDiscordElsewhere: boolean;
  /** Another Discord account has an application for the record's linked SteamID that was not declined or revoked. */
  linkedSteamShared: boolean;
};
export type MatchMember = {
  provider: SupporterProvider;
  discordId: string | null;
  discordSource: SupporterDiscordSource | null;
  patreonDiscordId: string | null;
  steamId: string | null;
  steamSource: SupporterSteamSource | null;
  steamApplicationId: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: Date | string | null;
};

const inProgress = new Set<ApplicationFact["status"]>(["processing", "needs_review", "revoking"]);
const approved = (application: ApplicationFact) =>
  application.status === "approved" && application.accessIntent === "grant" && !application.revokedAt;
const reviewOrder = (a: ApplicationFact, b: ApplicationFact) => {
  const time = (value: string | null) => (value ? Date.parse(value) : Number.POSITIVE_INFINITY);
  return time(a.reviewedAt) - time(b.reviewedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
const blocked = (reason: SteamMatchBlock, application?: ApplicationFact): SteamMatch => ({
  reason,
  steamId: application?.steamId ?? null,
  applicationId: application?.id ?? null,
  serverId: application?.serverId ?? null,
});

/**
 * The single SteamID rule. A SteamID is copied only from an approved, unrevoked application whose approval recorded a
 * real grant or a staff-confirmed existing entry, when the Discord account has exactly one approved SteamID, no review
 * of its applications is under way, and no other Discord account, earlier rejection or other supporter record touches
 * that SteamID. Pending applications for another SteamID, and declined or revoked ones, do not block on their own.
 */
export function applicationSteamMatch(applications: ApplicationFact[]): SteamMatch {
  if (!applications.length) return blocked("no_application");
  const busy = applications.find((application) => inProgress.has(application.status));
  if (busy) return blocked("application_in_progress", busy);
  const live = applications.filter(approved).sort(reviewOrder);
  if (!live.length) {
    const pending = applications.find((application) => application.status === "pending");
    return pending ? blocked("application_pending", pending) : blocked("no_approved_application");
  }
  if (new Set(live.map((application) => application.steamId)).size > 1) return blocked("several_steam_ids");
  if (!isPublicIndividualSteamId(live[0].steamId)) return blocked("invalid_steam_id", live[0]);
  const confirmed = live.filter((application) => application.whitelistGrant !== null);
  if (!confirmed.length) return blocked("application_not_confirmed", live[0]);
  const candidate = confirmed[0];
  if (live.some((application) => application.otherDiscordClaim)) return blocked("steam_shared", candidate);
  if (live.some((application) => application.rejectedBefore)) return blocked("steam_rejected_before", candidate);
  if (live.some((application) => application.otherSupporter)) return blocked("steam_on_another_record", candidate);
  return { reason: null, steamId: candidate.steamId, applicationId: candidate.id, serverId: candidate.serverId };
}

/** The SteamID's source application is no longer an approved application of this Discord account for this SteamID. */
export function sourceApplicationRevoked(member: Pick<MatchMember, "steamId" | "steamSource">, facts: MatchFacts) {
  return (
    member.steamSource === "application" &&
    !facts.applications.some((application) => approved(application) && application.steamId === member.steamId)
  );
}

/** Steam matches whose SteamID comes from an application that is not approved yet. */
const UNAPPROVED_STEAM = new Set<string>(["application_pending", "application_in_progress"]);
/**
 * A SteamID that staff linked (or that was linked before sources were recorded) differs from the one this Discord
 * account's approved application names. A pending application, or one under review, is no reason to doubt it. The
 * Supporters page shows this alert and automatic founder recording refuses on it, from this one test.
 */
export function steamDiffersFromApplication(
  member: Pick<MatchMember, "steamId" | "steamSource">,
  steam: SteamMatch | null,
) {
  return Boolean(
    member.steamId &&
    member.steamSource !== "application" &&
    steam?.steamId &&
    !UNAPPROVED_STEAM.has(steam.reason ?? "") &&
    steam.steamId !== member.steamId,
  );
}

export type AutomaticFounderBlockedReason =
  | "not_patreon"
  | "no_discord"
  | "discord_not_from_patreon"
  | "discord_differs"
  | "discord_reported_for_other_patron"
  | "source_application_revoked"
  | "steam_differs_from_application"
  | SteamMatchBlock
  | "no_patreon_payment"
  | "charge_reversed"
  | "payment_too_recent"
  | "earlier_payment_other_record"
  | FounderBlockedReason;

export const automaticBlockedMessages: Record<AutomaticFounderBlockedReason, string> = {
  ...founderBlockedMessages,
  not_patreon: "Only Patreon supporters are recorded automatically. PayPal founders are always recorded by staff.",
  no_discord: "No Discord account is linked.",
  discord_not_from_patreon:
    "The Discord account was entered by staff, not taken from the patron's Patreon connection, so a person must check it.",
  discord_differs: "Patreon no longer reports the linked Discord account for this patron.",
  discord_reported_for_other_patron: "Patreon reports this Discord account for another patron.",
  source_application_revoked: "The whitelist application the SteamID was copied from is no longer approved.",
  steam_differs_from_application:
    "The SteamID differs from the one on this Discord account's approved whitelist application.",
  no_application: "This Discord account has no whitelist application.",
  application_in_progress: "One of this Discord account's whitelist applications is being reviewed or revoked.",
  application_pending: "This Discord account's whitelist application has not been approved yet.",
  no_approved_application: "This Discord account has no approved whitelist application.",
  several_steam_ids: "This Discord account's approved applications name different SteamIDs.",
  invalid_steam_id: "The approved application's SteamID is not a valid player SteamID64.",
  application_not_confirmed:
    "The approval did not record a whitelist grant or a staff-confirmed existing entry, so the SteamID may belong to someone else.",
  steam_shared: "Another Discord account has an application for this SteamID.",
  steam_rejected_before: "An application for this SteamID was declined or revoked before.",
  steam_on_another_record: "Another supporter record already holds this SteamID.",
  no_patreon_payment:
    "No verified first payment from the Patreon import. A staff receipt or a PayPal payment is always reviewed by staff.",
  charge_reversed: "Patreon reports the latest charge as refunded, reversed or fraudulent.",
  payment_too_recent: "The first payment is still inside the waiting period for refunds.",
  earlier_payment_other_record: "Another supporter record for this person has an earlier payment.",
};

/**
 * Why automatic matching will not record a founder promise for this Patreon record, apart from the staff founder rule
 * (founderCheck, or founderBlocker on the same facts), which runs after this. It is stricter than staff awards: the
 * Discord account must come from the patron's Patreon connection and still be the one Patreon reports, and the payment
 * must be a verified first Patreon API payment whose latest charge was not reversed, that has passed the waiting
 * period, and that has no earlier payment on another record for the same person. No SteamID is needed. One that is
 * linked must be valid with no SteamID alert: one copied from an application must still pass the SteamID rule, one
 * staff entered must not differ from the approved application's, and no other Discord account may have applied with it.
 */
export function automaticFounderBlocker(
  member: MatchMember,
  facts: MatchFacts,
  context: { now: Date | number; holdHours: number },
): AutomaticFounderBlockedReason | null {
  if (member.provider !== "patreon") return "not_patreon";
  if (!member.discordId) return "no_discord";
  if (member.discordSource !== "patreon") return "discord_not_from_patreon";
  if (member.patreonDiscordId !== member.discordId) return "discord_differs";
  if (facts.discordReportedForOtherPatron) return "discord_reported_for_other_patron";
  // A founder needs no SteamID: the Discord account is the identity. A linked SteamID is still checked in full.
  if (member.steamId) {
    // The staff founder rule refuses an invalid SteamID with this same reason.
    if (!isPublicIndividualSteamId(member.steamId)) return "no_identity";
    if (member.steamSource === "application") {
      if (sourceApplicationRevoked(member, facts)) return "source_application_revoked";
      // An approved application still names this SteamID, so the SteamID rule decides; with no refusal, every
      // approved application names this same SteamID.
      const steam = applicationSteamMatch(facts.applications);
      if (steam.reason) return steam.reason;
    } else if (steamDiffersFromApplication(member, applicationSteamMatch(facts.applications)))
      return "steam_differs_from_application";
    if (facts.linkedSteamShared) return "steam_shared";
  }
  const automatic = facts.automatic;
  if (!automatic) return "no_patreon_payment";
  // Any reversed latest charge stops automation. The latest charge can only look older than the first payment when
  // Patreon dates that same charge a few seconds apart, which makes it a refund of the qualifying charge itself.
  if (member.lastChargeStatus && PATREON_REVERSED_CHARGE_STATUSES.has(member.lastChargeStatus))
    return "charge_reversed";
  const paidAt = Date.parse(automatic.payment.paidAt);
  const now = typeof context.now === "number" ? context.now : context.now.getTime();
  if (!(paidAt <= now - context.holdHours * 3_600_000)) return "payment_too_recent";
  if (automatic.earlierOtherRecord) return "earlier_payment_other_record";
  return null;
}

/** `info` is not a task: it says why no founder promise is possible on this record. */
export type NextStepArea = "discord" | "steam" | "payment" | "founder" | "info";
export type NextStep = { code: string; area: NextStepArea; message: string };
/** What the Supporters page needs to explain one record. */
export type NextStepRecord = MatchMember & {
  founder: { automatic: boolean } | null;
  founderBlockedReason: FounderBlockedReason | "no_payment" | null;
  founderEligiblePayment: PaymentView | null;
  latestPayment: PaymentView | null;
  /** The payment automatic matching would record a founder promise on. */
  automaticPayment: PaymentView | null;
  needsDiscordLink: boolean;
  match: {
    steam: SteamMatch | null;
    sourceApplicationRevoked: boolean;
    patreonDiscordElsewhere: boolean;
    discordReportedForOtherPatron: boolean;
    linkedSteamShared: boolean;
  };
  automaticBlockedReason: AutomaticFounderBlockedReason | null;
};
export type NextStepContext = {
  steamFill: boolean;
  founderAuto: boolean;
  importConfigured: boolean;
  /** Hours an imported first payment must stand before an automatic founder promise. */
  holdHours: number;
  /**
   * Whether the viewer may open a game server. An application on any other server is named without its SteamID or
   * server; the step itself stays. Omitted, every server is shown.
   */
  serverVisible?: (serverId: string) => boolean;
};

/** The application behind this match is on a game server the viewer cannot open. */
export function steamMatchHidden(steam: SteamMatch | null, context: Pick<NextStepContext, "serverVisible">) {
  return Boolean(steam?.serverId && context.serverVisible && !context.serverVisible(steam.serverId));
}
const HIDDEN_SERVER = " on a server you cannot open";

const PAYMENT_REASONS = new Set<string>([
  "no_payment",
  "not_first_payment",
  "earlier_payment",
  "not_verified",
  "source_not_qualifying",
]);
/** Founder reasons after which no founder promise is possible, so a missing SteamID no longer matters for one. */
const FOUNDER_IMPOSSIBLE = new Set<string>(["outside_window", "below_minimum", "already_founder"]);
const steamStepCodes: Record<SteamMatchBlock, string> = {
  no_application: "no_whitelist_application",
  application_in_progress: "application_in_progress",
  application_pending: "application_pending",
  no_approved_application: "no_approved_application",
  several_steam_ids: "several_steam_ids",
  invalid_steam_id: "invalid_steam_id",
  application_not_confirmed: "application_not_confirmed",
  steam_shared: "steam_shared",
  steam_rejected_before: "steam_rejected_before",
  steam_on_another_record: "steam_on_another_record",
};

function steamStep(steam: SteamMatch, record: NextStepRecord, context: NextStepContext): NextStep {
  const hidden = steamMatchHidden(steam, context);
  const id = hidden ? ` (${HIDDEN_SERVER.trim()})` : steam.steamId ? ` (${steam.steamId})` : "";
  const server = hidden ? HIDDEN_SERVER : steam.serverId ? ` on server ${steam.serverId}` : "";
  const named = hidden ? "the SteamID" : `SteamID ${steam.steamId}`;
  // Only a Patreon record with the fill switched on is ever filled in; anything else waits for staff.
  const fills = record.provider === "patreon" && context.steamFill;
  const messages: Record<SteamMatchBlock, string> = {
    no_application: fills
      ? "No whitelist application from this Discord account. The SteamID fills in once one is approved with a whitelist grant, or staff can link it."
      : "No whitelist application from this Discord account. Staff can link the SteamID once one is approved, or after confirming it with the supporter.",
    application_pending: fills
      ? `The whitelist application${server} is waiting for review. The SteamID fills in once it is approved with a whitelist grant; otherwise staff link it.`
      : `The whitelist application${server} is waiting for review. Staff can link the SteamID once it is approved.`,
    application_in_progress: `A whitelist application${server} is being reviewed or revoked. Finish that review first.`,
    no_approved_application: "No approved whitelist application from this Discord account. Staff can link the SteamID.",
    application_not_confirmed: `The approved application's SteamID${id} was approved without a recorded grant or confirmed existing entry. Check it belongs to this person, then link it.`,
    several_steam_ids: "This Discord account's approved applications name different SteamIDs. Link the right one.",
    invalid_steam_id: `The approved application's SteamID${id} is not a valid player SteamID64.`,
    steam_shared: `Another Discord account has applied with this SteamID${id}. Check who owns it before linking.`,
    steam_rejected_before: `An application for this SteamID${id} was declined or revoked before. Check it before linking.`,
    steam_on_another_record: `Another supporter record already holds this SteamID${id}. Check both records.`,
  };
  if (steam.reason) return { code: steamStepCodes[steam.reason], area: "steam", message: messages[steam.reason] };
  if (record.provider === "patreon" && context.steamFill)
    return {
      code: "steam_ready_automatic",
      area: "steam",
      message: `Ready: Gramps copies ${named} from the approved application${server} at the next sync or approval.`,
    };
  return {
    code: "steam_available",
    area: "steam",
    message: hidden
      ? `The approved application${server} names a SteamID. An administrator of that server can check it and link it here.`
      : `The approved application${server} names SteamID ${steam.steamId}. Check it and link it here.`,
  };
}

/**
 * The steps still needed for one record, in the order staff take them: Discord, SteamID, payment, founder. Alerts
 * (a different Discord account reported by Patreon, a revoked source application) come first in their area.
 */
export function supporterNextSteps(record: NextStepRecord, context: NextStepContext): NextStep[] {
  const steps: NextStep[] = [];
  const discord = (code: string, message: string) => steps.push({ code, area: "discord", message });
  if (!record.discordId) {
    if (record.provider === "paypal")
      discord(
        "link_discord_paypal",
        "Link the donor's Discord account after confirming who they are. PayPal supplies no Discord account.",
      );
    else if (record.match.patreonDiscordElsewhere)
      discord(
        "discord_on_another_record",
        `Patreon reports Discord account ${record.patreonDiscordId}, which another supporter record already links. Check both records.`,
      );
    else if (context.importConfigured)
      discord(
        "connect_discord_in_patreon",
        record.patreonDiscordId
          ? `Patreon reports Discord account ${record.patreonDiscordId}; the next sync links it.`
          : "Ask the patron to connect Discord on Patreon, or link it here.",
      );
    else
      discord(
        "link_discord_no_import",
        "The Patreon import is off. Link the Discord account after confirming who the patron is.",
      );
  } else if (record.provider === "patreon") {
    // Patreon's answer is only refreshed while the import runs, so a missing one says nothing without it.
    if (record.discordSource === "patreon" && !record.patreonDiscordId && context.importConfigured)
      discord(
        "discord_not_reported",
        "Patreon no longer reports this Discord account for the patron, who may have disconnected it. The link was kept; check it.",
      );
    if (record.patreonDiscordId && record.patreonDiscordId !== record.discordId)
      discord(
        "discord_differs",
        `Patreon now reports Discord account ${record.patreonDiscordId} for this patron. The link was kept; check which is right.`,
      );
    if (record.match.discordReportedForOtherPatron)
      discord(
        "discord_reported_for_other_patron",
        "Patreon reports this Discord account for another patron too. Check both records.",
      );
  }

  const founderPossible = !record.founder && !FOUNDER_IMPOSSIBLE.has(record.founderBlockedReason ?? "");
  if (record.steamId) {
    if (record.match.sourceApplicationRevoked)
      steps.push({
        code: "source_application_revoked",
        area: "steam",
        message:
          "The whitelist application this SteamID was copied from is no longer approved. The SteamID was kept; check it.",
      });
    else if (steamDiffersFromApplication(record, record.match.steam))
      steps.push({
        code: "steam_differs_from_application",
        area: "steam",
        message: `The linked SteamID differs from the one on this Discord account's approved application (${steamMatchHidden(record.match.steam, context) ? HIDDEN_SERVER.trim() : record.match.steam?.steamId}). Check which is right.`,
      });
    if (record.match.linkedSteamShared)
      steps.push({
        code: "linked_steam_shared",
        area: "steam",
        message: "Another Discord account has applied with the linked SteamID. Check who it belongs to.",
      });
  } else if (record.match.steam && (record.founder || founderPossible))
    // A founder without a SteamID still needs one for the whitelist promise.
    steps.push(steamStep(record.match.steam, record, context));

  if (record.founder) {
    if (record.needsDiscordLink)
      steps.push({
        code: "founder_needs_discord",
        area: "founder",
        message: "Founder promise recorded. Link a Discord account so they can receive the Founder role.",
      });
    return steps;
  }
  const reason = record.founderBlockedReason;
  if (reason) {
    const payment = record.founderEligiblePayment ?? record.latestPayment;
    const otherCurrency = reason === "below_minimum" && payment?.currency && payment.currency !== "USD";
    // The import counts a Patreon payment in another currency by its tier's price, so only a tier under US$5, or one
    // Patreon did not report, is left here.
    const message = otherCurrency
      ? `This ${payment.currency} payment is not confirmed as US$5 or more.${record.provider === "patreon" ? " Check the patron's tier on Patreon." : ""}`
      : founderBlockedMessages[reason];
    // Outside the window, below the minimum in US dollars, or a founder elsewhere: nothing staff can do here.
    const area =
      FOUNDER_IMPOSSIBLE.has(reason) && !otherCurrency ? "info" : PAYMENT_REASONS.has(reason) ? "payment" : "founder";
    steps.push({ code: `founder_${reason}`, area, message });
    return steps;
  }
  const automatic = record.automaticBlockedReason;
  if (record.provider === "patreon" && automatic === null)
    steps.push(
      context.founderAuto
        ? {
            code: "founder_ready_automatic",
            area: "founder",
            message: "Ready: Gramps records the founder promise at the next sync or approval.",
          }
        : {
            code: "founder_ready_automatic_off",
            area: "founder",
            message:
              "Ready for staff to record. Automatic recording is off; with it on, Gramps would record this one itself.",
          },
    );
  else if (record.provider === "patreon" && automatic === "payment_too_recent" && context.founderAuto) {
    const paidAt = record.automaticPayment ? Date.parse(record.automaticPayment.paidAt) : NaN;
    const until = Number.isFinite(paidAt)
      ? `, until ${new Date(paidAt + context.holdHours * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "";
    steps.push({
      code: "founder_automatic_waiting",
      area: "founder",
      message: `Gramps records it after the refund waiting period (${context.holdHours} hours from the payment${until}). Recording it sooner skips that wait.`,
    });
  } else
    steps.push({
      code: "founder_ready_staff",
      area: "founder",
      message:
        `Ready for staff to record. ${automatic ? `Not automatic: ${automaticBlockedMessages[automatic]}` : ""}`.trim(),
    });
  return steps;
}
