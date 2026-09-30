export type ApplicationStatus = "pending" | "processing" | "approved" | "declined" | "needs_review";
export type ApplicationDecision = "approve" | "decline" | "recheck";
export type ReviewOutcomeState = "started" | "applied" | "accepted" | "pending" | "failed" | "unknown";

export interface WhitelistApplication {
  id: string;
  discordUserId: string;
  discordDisplayName: string;
  steamId: string;
  steamOwnershipVerified: boolean;
  relationship: "unc_member" | "friend_regular" | "new_player";
  email: string | null;
  emailVerified: boolean;
  contactConsent: boolean;
  consentVersion: string;
  contactConsentAt: string | null;
  rulesAcceptedAt: string;
  status: ApplicationStatus;
  submittedAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewReason: string | null;
  reviewKind: ApplicationDecision | null;
  reviewId: string | null;
  actionId: string | null;
  lastActionState: ReviewOutcomeState | null;
  lastActionMessage: string | null;
}

export interface ApplicationsResponse {
  applications: WhitelistApplication[];
}

export interface ApplicationReviewResponse {
  application: WhitelistApplication;
  outcome: { id: string; state: ReviewOutcomeState; message: string };
}
