import { z } from "zod";

import { overviewSchema } from "~/components/overview/overview-data";

const reviewStateSchema = z.enum(["started", "applied", "accepted", "pending", "failed", "unknown"]);

export const whitelistEntrySchema = z.object({
  steamId: z.string(),
  active: z.boolean(),
  configured: z.boolean().nullable(),
});

export const whitelistResponseSchema = z.object({
  entries: z.array(whitelistEntrySchema),
  configurationAvailable: z.boolean(),
  invalidEntryCount: z.number().int().nonnegative(),
  configuredInvalidEntryCount: z.number().int().nonnegative().optional(),
});

export const whitelistOverviewSchema = overviewSchema.extend({
  capabilities: z.object({
    routes: z.array(z.string()),
    config: z.object({ writable: z.boolean() }).optional(),
    limits: z.object({ maxRequestsPerMinutePerIp: z.number().finite().optional() }).optional(),
  }),
});

export const whitelistApplicationSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  discordUserId: z.string(),
  discordDisplayName: z.string(),
  steamId: z.string(),
  steamOwnershipVerified: z.boolean(),
  relationship: z.enum(["unc_member", "friend_regular", "new_player"]),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  contactConsent: z.boolean(),
  consentVersion: z.string(),
  contactConsentAt: z.string().nullable(),
  rulesAcceptedAt: z.string(),
  status: z.enum(["pending", "processing", "approved", "declined", "needs_review", "revoking", "revoked"]),
  submittedAt: z.string(),
  updatedAt: z.string(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewReason: z.string().nullable(),
  reviewKind: z.enum(["approve", "decline", "recheck", "revoke"]).nullable(),
  reviewId: z.string().nullable(),
  actionId: z.string().nullable(),
  lastActionState: reviewStateSchema.nullable(),
  lastActionMessage: z.string().nullable(),
  whitelistState: z.enum(["active", "saved", "absent", "unknown"]).nullable().optional(),
});

export const applicationsResponseSchema = z.object({
  enabled: z.boolean(),
  serverId: z.string().optional(),
  applications: z.array(whitelistApplicationSchema),
});

export const applicationReviewResponseSchema = z.object({
  application: whitelistApplicationSchema,
  outcome: z.object({
    id: z.string(),
    state: reviewStateSchema,
    message: z.string(),
  }),
});

export type WhitelistEntry = z.infer<typeof whitelistEntrySchema>;
export type WhitelistResponse = z.infer<typeof whitelistResponseSchema>;
export type WhitelistOverview = z.infer<typeof whitelistOverviewSchema>;
export type WhitelistApplication = z.infer<typeof whitelistApplicationSchema>;
export type ApplicationsResponse = z.infer<typeof applicationsResponseSchema>;
export type ApplicationReviewResponse = z.infer<typeof applicationReviewResponseSchema>;
export type ApplicationDecision = "approve" | "decline" | "recheck";
export type ApplicationStatusFilter = "all" | "pending" | "follow-up" | "approved" | "declined";
export type WhitelistStatusFilter = "all" | "active" | "pending" | "unknown";

export const APPLICATION_PAGE_SIZE = 10;
export const APPLICATION_APPROVAL_REASON = "Website whitelist application reviewed and approved.";

export const applicationStatuses: Record<WhitelistApplication["status"], string> = {
  pending: "Awaiting review",
  processing: "Awaiting confirmation",
  approved: "Approved",
  declined: "Declined",
  needs_review: "Needs review",
  revoking: "Revoking",
  revoked: "Revoked",
};

export const applicationRelationships: Record<WhitelistApplication["relationship"], string> = {
  unc_member: "UNC member (self-reported)",
  friend_regular: "Friend or server regular (self-reported)",
  new_player: "New player (self-reported)",
};

export const applicationFilterOptions: {
  id: ApplicationStatusFilter;
  label: string;
  matches: (application: WhitelistApplication) => boolean;
}[] = [
  { id: "all", label: "All", matches: () => true },
  { id: "pending", label: "Awaiting review", matches: (application) => application.status === "pending" },
  {
    id: "follow-up",
    label: "Need follow-up",
    matches: (application) => ["processing", "needs_review", "revoking"].includes(application.status),
  },
  { id: "approved", label: "Approved", matches: (application) => application.status === "approved" },
  { id: "declined", label: "Declined", matches: (application) => application.status === "declined" },
];

export function applicationNeedsFollowUp(application: WhitelistApplication) {
  return ["processing", "needs_review", "revoking"].includes(application.status);
}

export function whitelistEntryStatus(entry: WhitelistEntry) {
  if (entry.active && entry.configured) return { label: "Active", note: "", kind: "active" as const };
  if (entry.active && entry.configured === null)
    return { label: "Active", note: "Saved configuration unavailable", kind: "active" as const };
  if (entry.active)
    return {
      label: "Removal pending",
      note: "In the running game, not in the saved list",
      kind: "pending" as const,
    };
  if (entry.configured)
    return {
      label: "Addition pending",
      note: "Saved, not in the running game yet",
      kind: "pending" as const,
    };
  return { label: "Not active", note: "Not in the running game", kind: "pending" as const };
}

export function isWhitelistOverviewFresh(overview: WhitelistOverview | undefined, now = Date.now()) {
  if (!overview) return false;
  const observedAt = Date.parse(overview.observedAt);
  return Number.isFinite(observedAt) && now - observedAt <= 30_000 && observedAt <= now + 5_000;
}

export function reasonProblem(reason: string) {
  return reason.length < 3 ||
    reason.length > 200 ||
    [...reason].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? "Enter a single-line review reason between 3 and 200 characters."
    : "";
}

export function formatSubmittedAt(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Date unavailable";
}
