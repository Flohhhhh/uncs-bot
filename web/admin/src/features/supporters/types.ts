export interface FounderPolicy {
  amountCents: number;
  currency: "USD";
  startsAt: string | null;
  endsAt: string | null;
  configured: boolean;
}
export interface PaymentEvidence {
  id: string;
  paidAt: string;
  amountCents: number | null;
  currency: string | null;
  source: "signed_status" | "manual_receipt";
  reference: string;
  verificationState: "verified" | "unverified";
  firstSuccessfulPaymentVerified: boolean;
}
export interface Supporter {
  id: string;
  patreonMemberId: string;
  displayName: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeAt: string | null;
  observedAt: string;
  reviewState: "pending" | "verified" | "unverified";
  discordId: string | null;
  steamId: string | null;
  identityState: "unlinked" | "staff_linked";
  version: number;
  latestPayment: PaymentEvidence | null;
  founderEligiblePayment: PaymentEvidence | null;
  founder: { awardedAt: string; paymentId: string } | null;
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
  conflicts: number;
  truncated: number;
  revokedPayments: number;
  memberListComplete: boolean;
  intervalMinutes: number;
  nextAttemptAt: string | null;
  conflictDetails: {
    supporterId: string;
    patreonMemberId: string;
    reason: "discord-in-use" | "discord-differs";
  }[];
  founderReviews: {
    supporterId: string;
    patreonMemberId: string;
    paymentId: string;
    paymentSource: string;
    reference: string;
    unverifiedPaymentId: string;
    unverifiedReference: string;
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
}
export interface SupporterReviewResponse {
  ok: boolean;
  replayed: boolean;
  supporter: Supporter | null;
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
    | { discordId: string; steamId: string }
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
