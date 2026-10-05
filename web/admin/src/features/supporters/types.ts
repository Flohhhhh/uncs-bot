export interface FounderPolicy {
  amountCents: number;
  currency: "USD";
  startsAt: string | null;
  endsAt: string | null;
  configured: boolean;
  /** Hours an imported first payment must stand before automatic matching records a founder promise. */
  automaticHoldHours?: number;
}
export interface PaymentEvidence {
  id: string;
  paidAt: string;
  amountCents: number | null;
  currency: string | null;
  source: "signed_status" | "manual_receipt" | "patreon_api" | "paypal";
  reference: string;
  verificationState: "verified" | "unverified";
  firstSuccessfulPaymentVerified: boolean;
  minimumConfirmed?: boolean;
  recordedBy?: string | null;
}
/** Why the server will not copy an application's SteamID. Mirrors SteamMatchBlock in src/supporters/supporter-match.rules.ts. */
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
 * The SteamID a whitelist application of the record's Discord account names. `reason` is null only when the server
 * says the SteamID is safe to copy; otherwise it names why not, and `steamId` is given for staff to check. For an
 * application on a game server the administrator cannot open, only `reason` is given.
 */
export interface SteamMatch {
  reason: SteamMatchBlock | null;
  steamId: string | null;
  applicationId: string | null;
  serverId: string | null;
}
export interface NextStep {
  code: string;
  /** `info` is a note, not a task: why no founder promise is possible on this record. */
  area: "discord" | "steam" | "payment" | "founder" | "info";
  message: string;
}
export type IdentityState = "unlinked" | "partial" | "patreon_linked" | "staff_linked";
export interface Supporter {
  id: string;
  provider: "patreon" | "paypal";
  /** Null for PayPal supporters. */
  patreonMemberId: string | null;
  /** Sent as `confirm` with every review: the Patreon member ID, or the record ID for PayPal. */
  confirmKey: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: string | null;
  observedAt: string;
  reviewState: "pending" | "verified" | "unverified";
  discordId: string | null;
  discordSource: "staff" | "patreon" | "patron_signin" | null;
  patreonDiscordId: string | null;
  steamId: string | null;
  steamSource: "staff" | "application" | null;
  steamApplicationId: string | null;
  identityState: IdentityState;
  version: number;
  latestPayment: PaymentEvidence | null;
  founderEligiblePayment: PaymentEvidence | null;
  founder: {
    awardedAt: string;
    paymentId: string;
    source?: PaymentEvidence["source"] | null;
    automatic?: boolean;
    /** False once Patreon no longer reports the founder payment as paid. They stay a founder. */
    paymentVerified?: boolean;
    /** False once Patreon shows an earlier payment than the founder payment. They stay a founder. */
    paymentFirst?: boolean;
  } | null;
  /** The server's verdict: why no founder promise can be recorded yet, or null when it can. */
  founderBlockedReason: string | null;
  founderBlockedMessage: string | null;
  needsDiscordLink: boolean;
  match: {
    steam: SteamMatch | null;
    /** Null as well when the application is on a game server the administrator cannot open. */
    sourceApplication: { id: string; serverId: string; status: string } | null;
    sourceApplicationRevoked: boolean;
    patreonDiscordElsewhere: boolean;
    discordReportedForOtherPatron: boolean;
    /** Another Discord account has applied with the linked SteamID. */
    linkedSteamShared: boolean;
  };
  /** The payment automatic matching would record a founder promise on. */
  automaticPayment: PaymentEvidence | null;
  automaticBlockedReason: string | null;
  automaticBlockedMessage: string | null;
  nextSteps: NextStep[];
}
export interface AutomationStatus {
  steamFill: boolean;
  founderAuto: boolean;
  /** Hours an imported first payment must stand before an automatic founder promise. */
  holdHours?: number;
  /** Patreon is configured, so matching has records to run on. */
  configured?: boolean;
  lastRunAt?: string | null;
  /** Fixed text from the server when the last matching run could not finish. */
  lastError?: string | null;
}
/** Mirrors PatreonSyncStatus in src/supporters/patreon-sync.service.ts. It never carries the token. */
export interface PatreonSyncStatus {
  configured: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Fixed, safe text from the server. */
  lastError: string | null;
  tokenRejected: boolean;
  /** Counts from the last successful sync. */
  members: number;
  newMembers: number;
  updated: number;
  payments: number;
  discordLinks: number;
  /** Discord accounts the last import could not settle. Each record says which, in its own Discord step. */
  conflicts: number;
  truncated: number;
  revokedPayments: number;
  /** Members with at least one completed payment. */
  paidMembers: number;
  /** Members Patreon reported a Discord account for, linked or not. */
  discordReported: number;
  /** Completed payments in another currency that count as US$5 or more by their tier's price. */
  tierConfirmed: number;
  /** How many of those the last sync counted for the first time. */
  tierConfirmedNew: number;
  /** Completed payments in another currency that are not confirmed as US$5 or more. */
  tierUnconfirmed: number;
  /** Whether the last sync read tier prices. */
  tierPrices: "read" | "not_requested" | "unavailable" | "refused";
  memberListComplete: boolean;
  intervalMinutes: number;
  nextAttemptAt: string | null;
  conflictDetails: {
    supporterId: string;
    patreonMemberId: string;
    reason: "discord-in-use" | "discord-differs";
  }[];
}
/** POST supporters/sync: joins a running sync, or reuses one that finished moments ago. */
export interface PatreonSyncResponse {
  ok: boolean;
  joined: boolean;
  recent?: boolean;
  sync: PatreonSyncStatus;
}
export interface SupportersResponse {
  enabled: boolean;
  configured: boolean;
  founderPolicy: FounderPolicy;
  webhookConfigured: boolean;
  supporters: Supporter[];
  note: string;
  sync: PatreonSyncStatus;
  automation?: AutomationStatus;
}
export interface SupporterReviewResponse {
  ok: boolean;
  replayed: boolean;
  supporter: Supporter | null;
  /** Set when the save let Gramps copy the SteamID from an approved application straight away. */
  automatic?: { steamFilled: boolean; founderRecorded: boolean };
}
/** `review` keeps the accounts as they are, which settles a refused Link Patreon sign-in. */
export type SupporterDecision = "link" | "review" | "payment" | "founder";
interface ReviewBase {
  id: string;
  version: number;
  confirm: string;
  reason: string;
}
export type SupporterReviewInput = ReviewBase &
  (
    | { discordId?: string; steamId?: string; steamConfirmed?: true }
    | {
        paidAt: string;
        amountCents: number;
        currency: "USD";
        reference: string;
        completedPaymentVerified: true;
        firstSuccessfulPaymentVerified: boolean;
      }
    | { paymentId: string }
  );
