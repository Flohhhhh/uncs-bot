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
export interface SupportersResponse {
  enabled: boolean;
  configured: boolean;
  founderPolicy: FounderPolicy;
  webhookConfigured: boolean;
  supporters: Supporter[];
  note: string;
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
