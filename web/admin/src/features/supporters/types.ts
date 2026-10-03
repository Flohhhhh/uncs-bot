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
/** The SteamID an approved whitelist application offers; `reason` is null when Gramps may copy it. */
export interface SteamMatch {
  reason: string | null;
  steamId: string | null;
  applicationId: string | null;
  serverId: string | null;
}
export interface NextStep {
  code: string;
  area: "discord" | "steam" | "payment" | "founder";
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
  discordSource: "staff" | "patreon" | null;
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
  } | null;
  /** The server's verdict: why no founder promise can be recorded yet, or null when it can. */
  founderBlockedReason: string | null;
  founderBlockedMessage: string | null;
  needsDiscordLink: boolean;
  match: {
    steam: SteamMatch | null;
    sourceApplication: { id: string; serverId: string; status: string } | null;
    sourceApplicationRevoked: boolean;
    patreonDiscordElsewhere: boolean;
    discordReportedForOtherPatron: boolean;
  };
  automaticBlockedReason: string | null;
  automaticBlockedMessage: string | null;
  nextSteps: NextStep[];
}
export interface AutomationStatus {
  steamFill: boolean;
  founderAuto: boolean;
  holdHours?: number;
  configured?: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
}
export interface SupportersResponse {
  enabled: boolean;
  configured: boolean;
  founderPolicy: FounderPolicy;
  webhookConfigured: boolean;
  supporters: Supporter[];
  note: string;
  automation?: AutomationStatus;
}
export interface SupporterReviewResponse {
  ok: boolean;
  replayed: boolean;
  supporter: Supporter | null;
  /** Set when the save let Gramps copy the SteamID from an approved application straight away. */
  automatic?: { steamFilled: boolean; founderRecorded: boolean };
}
export type SupporterDecision = "link" | "payment" | "founder" | "review";
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
    | Record<never, never>
  );
