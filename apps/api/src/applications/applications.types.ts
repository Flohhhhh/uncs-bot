import { z } from "zod";
import { steamId } from "../admin/admin.types";
import { gameServerId, LEGACY_SERVER_ID } from "../common/game-server";
import type { whitelistApplications } from "../database/schema";

export type ApplicantIdentity = { userId: string; displayName: string; csrf: string };
export type WhitelistApplication = typeof whitelistApplications.$inferSelect;
export const consentVersion = "whitelist-application-contact-v1-2026-09-30";

export const applicationSchema = z
  .object({
    steamId,
    serverId: gameServerId.default(LEGACY_SERVER_ID),
    email: z.string().trim().email().max(254).optional(),
    contactConsent: z.boolean(),
    rulesAccepted: z.literal(true),
    relationship: z.enum(["unc_member", "friend_regular", "new_player"]),
  })
  .strict()
  .refine(
    (value) => !value.email || value.contactConsent,
    "Agree to application and access contact when providing an email.",
  );

export const reviewSchema = z
  .object({
    id: z.uuid(),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .refine(
        (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
        "Use a single-line reason.",
      ),
    // Approval only: staff confirmed this Discord member owns a SteamID that is already whitelisted.
    existingAccessConfirmed: z.literal(true).optional(),
  })
  .strict();
export type ApplicationReview = z.infer<typeof reviewSchema>;
export type ReviewKind = "approve" | "decline" | "recheck" | "revoke";
/** Live whitelist state shown to staff for unresolved requests; null for resolved ones. */
export type WhitelistState = "active" | "saved" | "absent" | "unknown" | null;

export function ownApplication(application: WhitelistApplication | undefined | null) {
  if (!application) return null;
  return {
    id: application.id,
    serverId: application.serverId,
    steamId: application.steamId,
    steamOwnershipVerified: application.steamOwnershipVerified,
    relationship: application.relationship,
    email: application.email,
    emailVerified: application.emailVerified,
    contactConsent: application.contactConsent,
    consentVersion: application.consentVersion,
    contactConsentAt: application.contactConsentAt,
    rulesAcceptedAt: application.rulesAcceptedAt,
    // A revocation in progress looks like any other staff action in progress to the applicant.
    status: application.status === "revoking" ? "processing" : application.status,
    submittedAt: application.submittedAt,
    updatedAt: application.updatedAt,
  };
}
