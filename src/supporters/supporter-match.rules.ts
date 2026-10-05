import { isPublicIndividualSteamId } from "../common/steam-id";
import type { SupporterDiscordSource, SupporterProvider, SupporterSteamSource } from "../database/supporters.schema";
import { PATREON_REVERSED_CHARGE_STATUSES } from "./patreon.client";
import {
  founderBlockedMessage,
  founderBlockedMessages,
  type FounderBlockedReason,
  type PaymentView,
} from "./supporters.types";

/**
 * Automatic supporter matching fills a Patreon supporter's empty SteamID from their approved whitelist application
 * and, separately, records a founder promise under a stricter rule than staff awards. These are the pure rules; the
 * SQL that gathers their facts is in founder-rules.ts, so the Supporters page and the automatic writes read the same
 * facts the same way.
 */
export const SUPPORTER_MATCH_ACTOR = { id: "system:supporter-match", name: "Automatic supporter match" } as const;
export const AUTO_FOUNDER_REASON =
  "Recorded automatically: Discord account from Patreon and a first Patreon payment inside the founder window.";
/** The same promise on a Discord account the patron linked themselves ("Link Patreon"). */
export const PATRON_LINK_FOUNDER_REASON =
  "Recorded automatically: Discord account linked by the patron's own Discord and Patreon sign-in, and a first Patreon payment inside the founder window.";
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
 * Supporters page shows this alert. A founder needs no SteamID, so it never stops an automatic founder promise.
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

/** An application that still ties its SteamID to the Discord account: any that was not declined or revoked. */
const standing = (application: ApplicationFact) =>
  application.status !== "declined" && application.status !== "revoked";
/**
 * The SteamIDs this Discord account applied with (applications not declined or revoked), apart from the one linked to
 * the record, in the order their locks are taken.
 */
export function appliedSteamIds(facts: Pick<MatchFacts, "applications">, linkedSteamId: string | null = null) {
  const applied = facts.applications.filter((application) => standing(application));
  return [...new Set(applied.map((application) => application.steamId))]
    .filter((steamId) => steamId !== linkedSteamId)
    .sort();
}
/**
 * Another supporter record holds a SteamID this Discord account applied with (an application not declined or
 * revoked), other than the one linked to this record. The founder checks compare the Discord account and the linked
 * SteamID only, so they cannot see that record's founder promise or earlier payment. Each person is a founder once, so
 * staff check both records. It is the same with and without a linked SteamID, so the SteamID fill never changes it.
 */
export function heldOnAnotherRecord(facts: Pick<MatchFacts, "applications">, linkedSteamId: string | null = null) {
  return facts.applications.some(
    (application) => application.otherSupporter && standing(application) && application.steamId !== linkedSteamId,
  );
}

/**
 * Why automatic matching wrote nothing: the automatic founder rule's own reasons, the SteamID rule's reasons when it
 * did not copy a SteamID, and the staff founder rule's reasons.
 */
export type AutomaticFounderBlockedReason =
  | "not_patreon"
  | "no_discord"
  | "discord_not_from_patreon"
  | "discord_differs"
  | "discord_reported_for_other_patron"
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
  discord_not_from_patreon: "Patreon has not reported this Discord account for them yet.",
  discord_differs: "Patreon shows a different Discord account for them.",
  discord_reported_for_other_patron: "Patreon reports this Discord account for another patron.",
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
  steam_on_another_record: "Another supporter record holds a SteamID this Discord account applied with.",
  no_patreon_payment: "No first payment from the Patreon import. A staff receipt is made a founder by staff.",
  charge_reversed: "Patreon reports the latest charge as refunded, reversed or fraudulent.",
  payment_too_recent: "The first payment is still inside the waiting period for refunds.",
  earlier_payment_other_record: "Another supporter record for this person has an earlier payment.",
};

/**
 * Why automatic matching will not record a founder promise for this Patreon record, apart from the staff founder rule
 * (founderCheck, or founderBlocker on the same facts), which runs after this. It is stricter than staff awards: the
 * Discord account must come from the patron's Patreon connection or from the patron's own Discord and Patreon sign-in
 * ("Link Patreon"), Patreon must report no other account for them and this account for no other patron, and the
 * payment must be a verified first Patreon API payment whose latest charge was not reversed, that has passed the
 * waiting period, and that has no earlier payment on another record for the same person. A link Patreon no longer
 * reports any account for is kept, and still counts. A link the patron made by signing in counts like one from
 * Patreon, since the patron proved the account to both, so it too waits only for the payment's refund window.
 *
 * A founder needs no SteamID: the Discord account is the identity. The SteamID alerts on the Supporters page matter
 * for the whitelist promise later, so they never stop a founder. A linked SteamID must still be a valid player ID, as
 * the staff founder rule requires. One more thing about SteamIDs stops it: another supporter record holds a SteamID
 * this Discord account applied with, other than the linked one, so that record may be the same person's (see
 * heldOnAnotherRecord). The linked SteamID itself is compared by the staff founder rule and the earlier-payment check.
 */
export function automaticFounderBlocker(
  member: MatchMember,
  facts: MatchFacts,
  context: { now: Date | number; holdHours: number },
): AutomaticFounderBlockedReason | null {
  if (member.provider !== "patreon") return "not_patreon";
  if (!member.discordId) return "no_discord";
  // The patron proved the account either way: through Patreon's own connection, or by signing in to both themselves.
  if (member.discordSource !== "patreon" && member.discordSource !== "patron_signin") return "discord_not_from_patreon";
  if (member.patreonDiscordId && member.patreonDiscordId !== member.discordId) return "discord_differs";
  if (facts.discordReportedForOtherPatron) return "discord_reported_for_other_patron";
  // The staff founder rule refuses an invalid SteamID with this same reason.
  if (member.steamId && !isPublicIndividualSteamId(member.steamId)) return "no_identity";
  if (heldOnAnotherRecord(facts, member.steamId)) return "steam_on_another_record";
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

/**
 * Why a patron's own sign-in ("Link Patreon") was refused for this record: it already links another Discord account,
 * another record of the campaign links that Discord account, or another founder record holds it.
 */
export type PatronLinkConflictReason = "membership_linked" | "discord_linked" | "founder_tie";
/** The newest refused sign-in for a record that staff have not settled since (see SupporterView). */
export type PatronLinkConflict = {
  /** The Discord account the patron signed in with. */
  discordId: string;
  conflict: PatronLinkConflictReason;
  /** The Discord account the record links, for `membership_linked`. */
  linkedDiscordId: string | null;
};

/** `info` is not a task: it says why no founder promise is possible on this record. */
export type NextStepArea = "discord" | "steam" | "payment" | "founder" | "info";
export type NextStep = { code: string; area: NextStepArea; message: string };
/** What the Supporters page needs to explain one record. */
export type NextStepRecord = MatchMember & {
  /** A refused patron sign-in staff have not settled yet. Omitted, none. */
  patronLinkConflict?: PatronLinkConflict | null;
  founder: { automatic: boolean } | null;
  founderBlockedReason: FounderBlockedReason | "no_payment" | null;
  /** Only the first-payment mark, which the import has not settled yet, keeps it from being a founder (see SupporterView). */
  founderFirstPaymentWaiting?: boolean;
  /** Patreon priced the tier of its payment in another currency under US$5, so no sync confirms it (see SupporterView). */
  founderTierBelowMinimum?: boolean;
  /** The record's founder verdict in staff words. A founder step that only states the verdict uses it as it is. */
  founderBlockedMessage?: string | null;
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
   * Patrons can link their own Discord account with "Link Patreon": PATREON_LINK_ENABLED is on and every setting it
   * uses is ready (patronLinkSetupProblem). Omitted, off.
   */
  patronLink?: boolean;
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

const PAYMENT_REASONS = new Set<string>(["no_payment", "not_first_payment", "earlier_payment", "not_verified"]);
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

/**
 * The viewer cannot see the SteamID on an application on a server they cannot open, so they cannot take it from
 * there. The supporter can still give it to them. This also covers a failed server check and a server that is no
 * longer set up, where no administrator can open it.
 */
const ASK_FOR_STEAM_ID = "Their application is on a server you cannot open, so ask them for their SteamID.";
/** Waiting texts: what Gramps waits for, so no one has to do it. */
const WAITING_FOR_DISCORD = "Waiting for them to connect Discord on Patreon.";
/** With Link Patreon on, a patron can link a record that has no Discord account themselves. */
const WAITING_FOR_PATRON_LINK = "Waiting for them to tap Link Patreon in Discord.";
const WAITING_FOR_IMPORT = "Waiting for the Patreon import to be set up.";

function steamStep(steam: SteamMatch, record: NextStepRecord, context: NextStepContext): NextStep {
  // An application on a server the viewer cannot open is named without its SteamID.
  const hidden = steamMatchHidden(steam, context);
  const id = hidden ? ` (${HIDDEN_SERVER.trim()})` : steam.steamId ? ` (${steam.steamId})` : "";
  const messages: Record<SteamMatchBlock, string> = {
    no_application: "No approved whitelist application yet.",
    application_pending: "Their whitelist application is waiting for review.",
    application_in_progress: "Their whitelist application is in review.",
    no_approved_application: "No approved whitelist application yet.",
    application_not_confirmed: hidden ? ASK_FOR_STEAM_ID : `Check this SteamID${id} is theirs, then add it.`,
    several_steam_ids: "Their applications list different SteamIDs.",
    invalid_steam_id: `The SteamID${id} on their application is not valid.`,
    steam_shared: `Another Discord account applied with this SteamID${id}.`,
    steam_rejected_before: `This SteamID${id} was declined or revoked before.`,
    // One line with what to do: linking it here lets the founder checks compare the two records.
    steam_on_another_record: `Another supporter has this SteamID${id}. Link it here if they are the same person.`,
  };
  if (steam.reason) return { code: steamStepCodes[steam.reason], area: "steam", message: messages[steam.reason] };
  // Only a Patreon record with the fill switched on is ever filled in; anything else waits for staff.
  if (record.provider === "patreon" && context.steamFill)
    return { code: "steam_ready_automatic", area: "steam", message: "Gramps adds their SteamID at the next sync." };
  return {
    code: "steam_available",
    area: "steam",
    message: hidden ? ASK_FOR_STEAM_ID : `Add the SteamID${id} from their application.`,
  };
}

const patronLinkConflictMessages: Record<PatronLinkConflictReason, (conflict: PatronLinkConflict) => string> = {
  membership_linked: ({ discordId, linkedDiscordId }) =>
    `Discord account ${discordId} signed in as this patron, but this record links ${linkedDiscordId ?? "another account"}.`,
  discord_linked: ({ discordId }) =>
    `Discord account ${discordId} signed in as this patron, but another record already links it.`,
  founder_tie: ({ discordId }) =>
    `Discord account ${discordId} signed in as this patron, but another founder record holds it.`,
};

/**
 * The steps still needed for one record, in the order they are taken: Discord, SteamID, payment, founder. Alerts
 * (a refused patron sign-in, a different Discord account reported by Patreon, a revoked source application) come
 * first in their area. Anything the Patreon import can settle is worded as what Gramps waits for, so no one has to do
 * it.
 */
export function supporterNextSteps(record: NextStepRecord, context: NextStepContext): NextStep[] {
  const steps: NextStep[] = [];
  const discord = (code: string, message: string) => steps.push({ code, area: "discord", message });
  const refused = record.patronLinkConflict;
  if (refused) discord("patron_link_conflict", patronLinkConflictMessages[refused.conflict](refused));
  // Without the import nothing reports the account, so the wait is for the import itself.
  const waitingForDiscord = context.importConfigured ? WAITING_FOR_DISCORD : WAITING_FOR_IMPORT;
  // A record with no account waits for the patron, who can link it in Discord while Link Patreon is on.
  const waitingForAccount =
    context.importConfigured && context.patronLink ? WAITING_FOR_PATRON_LINK : waitingForDiscord;
  if (!record.discordId) {
    if (record.provider === "paypal") discord("link_discord_paypal", "Add their Discord account so they get roles.");
    else if (record.match.patreonDiscordElsewhere)
      discord(
        "discord_on_another_record",
        `Discord account ${record.patreonDiscordId} is already on another supporter.`,
      );
    else if (context.importConfigured)
      discord(
        "connect_discord_in_patreon",
        record.patreonDiscordId ? "Gramps links their Discord at the next sync." : waitingForAccount,
      );
    else discord("link_discord_no_import", WAITING_FOR_IMPORT);
  } else if (record.provider === "patreon") {
    // A link Patreon no longer reports is kept. The record's Discord fact says so; nothing is left to do.
    if (record.patreonDiscordId && record.patreonDiscordId !== record.discordId)
      discord("discord_differs", `Patreon now shows a different Discord account, ${record.patreonDiscordId}.`);
    if (record.match.discordReportedForOtherPatron)
      discord("discord_reported_for_other_patron", "Patreon shows this Discord account for another supporter too.");
  }

  const founderPossible = !record.founder && !FOUNDER_IMPOSSIBLE.has(record.founderBlockedReason ?? "");
  if (record.steamId) {
    if (record.match.sourceApplicationRevoked)
      steps.push({
        code: "source_application_revoked",
        area: "steam",
        message: "The application this SteamID came from is no longer approved.",
      });
    else if (steamDiffersFromApplication(record, record.match.steam))
      steps.push({
        code: "steam_differs_from_application",
        area: "steam",
        message: `Their application lists a different SteamID (${steamMatchHidden(record.match.steam, context) ? HIDDEN_SERVER.trim() : record.match.steam?.steamId}).`,
      });
    if (record.match.linkedSteamShared)
      steps.push({
        code: "linked_steam_shared",
        area: "steam",
        message: "Another Discord account applied with their SteamID.",
      });
  } else if (record.match.steam && (record.founder || founderPossible))
    // A founder without a SteamID still needs one for the whitelist promise.
    steps.push(steamStep(record.match.steam, record, context));

  if (record.founder) {
    if (record.needsDiscordLink)
      steps.push({
        code: "founder_needs_discord",
        area: "founder",
        // A Patreon founder's account arrives from Patreon. A PayPal founder's is added by staff.
        message:
          record.provider === "patreon" ? waitingForAccount : "Add a Discord account so they get the Founder role.",
      });
    return steps;
  }
  const reason = record.founderBlockedReason;
  if (reason) {
    const code = `founder_${reason}`;
    const payment = record.founderEligiblePayment ?? record.latestPayment;
    const otherCurrency = reason === "below_minimum" && payment?.currency && payment.currency !== "USD";
    if (otherCurrency && record.provider === "patreon" && !record.founderTierBelowMinimum)
      // The import counts a Patreon payment in another currency by its tier's price and checks again at every sync,
      // so Gramps waits for a tier Patreon did not report, or could not be read. A tier priced under US$5 is an
      // answer, so that one is a note.
      steps.push({
        code,
        area: "founder",
        message: `Waiting for Patreon to confirm this ${payment.currency} payment is US$5 or more.`,
      });
    else if (reason === "not_first_payment" && record.founderFirstPaymentWaiting)
      // Patreon's history has not settled whether this imported payment was the first. Every sync reads it again.
      steps.push({ code, area: "founder", message: "Waiting for Patreon to confirm their first payment." });
    else if (reason === "source_not_qualifying")
      // Only a webhook status is on record. The import brings in the payment itself, so without it the wait is for
      // the import.
      steps.push({
        code,
        area: "founder",
        message: context.importConfigured ? "Waiting for Patreon to show a payment." : WAITING_FOR_IMPORT,
      });
    else if (reason === "no_identity" && !record.discordId && !record.steamId)
      // Linking an account is the Discord step's job. This says what it unlocks.
      steps.push({ code, area: "founder", message: "Can be a founder once their Discord is linked." });
    else if (reason === "no_identity")
      // The record has an account, so the SteamID linked to it is what the founder rule refuses.
      steps.push({ code, area: "founder", message: "Their SteamID is not valid." });
    else
      steps.push({
        code,
        // Outside the window, below the minimum, or a founder elsewhere: nothing staff can do here. Staff answered
        // whether a PayPal payment in another currency is worth US$5 or more when they recorded it.
        area: FOUNDER_IMPOSSIBLE.has(reason) ? "info" : PAYMENT_REASONS.has(reason) ? "payment" : "founder",
        // The record's own verdict names the payment it judged, which need not be the one the record shows.
        message: record.founderBlockedMessage ?? founderBlockedMessage(reason, payment),
      });
    return steps;
  }
  // Why automation would not record it is on the record as automaticBlockedMessage, so the step stays one sentence.
  const automatic = record.automaticBlockedReason;
  const founder = (code: string, message: string) => steps.push({ code, area: "founder", message });
  if (record.provider !== "patreon") founder("founder_ready_staff", "Ready to be made a founder.");
  // Gramps would record it now, or once the refund wait is over. With automatic founders off it waits for the switch.
  else if ((automatic === null || automatic === "payment_too_recent") && !context.founderAuto)
    founder("founder_ready_automatic_off", "Waiting for automatic founders to be turned on.");
  else if (automatic === null) founder("founder_ready_automatic", "Gramps makes them a founder at the next sync.");
  else if (automatic === "payment_too_recent") {
    const paidAt = record.automaticPayment ? Date.parse(record.automaticPayment.paidAt) : NaN;
    const until = Number.isFinite(paidAt)
      ? ` (${new Date(paidAt + context.holdHours * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC)`
      : "";
    founder("founder_automatic_waiting", `Gramps makes them a founder after the refund wait${until}.`);
  } else if (automatic === "charge_reversed")
    founder("founder_waiting_patreon", "Waiting for Patreon to settle a refunded charge.");
  // The import makes the account a Patreon link once Patreon reports it for them.
  else if (automatic === "no_discord" || automatic === "discord_not_from_patreon")
    // Link Patreon links only a record with no account: one staff linked waits for Patreon to report it.
    founder("founder_waiting_discord", automatic === "no_discord" ? waitingForAccount : waitingForDiscord);
  // The Discord step already says which account Patreon reports, and that staff check it.
  else if (automatic === "discord_differs" || automatic === "discord_reported_for_other_patron") return steps;
  else if (automatic === "steam_on_another_record") {
    // The SteamID step already says which SteamID and what to do, so the record shows one line.
    if (!steps.some((step) => step.code === "steam_on_another_record"))
      founder("founder_steam_on_another_record", "Another supporter has a SteamID they applied with.");
  } else if (automatic === "earlier_payment_other_record")
    // The person's first payment is on another record with the same Discord account or SteamID, so this one is not
    // a founder. Gramps decided it, so it is a note.
    steps.push({
      code: "founder_earlier_payment_other_record",
      area: "info",
      message: "Their first payment is on another record.",
    });
  // A staff receipt saved while the import was off, or a payment the staff rule judges differently: staff decide.
  else founder("founder_ready_staff", "Ready to be made a founder.");
  return steps;
}
