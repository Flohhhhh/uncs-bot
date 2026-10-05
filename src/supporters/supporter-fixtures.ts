import type { PaymentView, SupporterView } from "./supporters.types";
import type { ApplicationFact } from "./supporter-match.rules";

/** Fictional supporter records for tests and the local preview. No real member, Discord or Steam account. */
export const FIXTURE_DISCORD_ID = "123456789012345678";
export const FIXTURE_STEAM_ID = "76561198000000001";

export function paymentFixture(overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    paidAt: "2026-10-01T12:00:00.000Z",
    amountCents: 500,
    currency: "USD",
    source: "patreon_api",
    reference: "pledge_start:1",
    verificationState: "verified",
    firstSuccessfulPaymentVerified: true,
    minimumConfirmed: false,
    recordedBy: "system:patreon-sync",
    ...overrides,
  };
}

export function applicationFixture(overrides: Partial<ApplicationFact> = {}): ApplicationFact {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    serverId: "primary",
    steamId: FIXTURE_STEAM_ID,
    status: "approved",
    accessIntent: "grant",
    whitelistGrant: "granted",
    revokedAt: null,
    reviewedAt: "2026-10-01T13:00:00.000Z",
    otherDiscordClaim: false,
    rejectedBefore: false,
    otherSupporter: false,
    ...overrides,
  };
}

/** A Patreon record with nothing linked and no payment, ready for overrides. */
export function supporterFixture(overrides: Partial<SupporterView> = {}): SupporterView {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    provider: "patreon",
    patreonMemberId: "member-1",
    confirmKey: "member-1",
    displayName: "Fixture patron",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: "2026-10-01T12:00:00.000Z",
    observedAt: "2026-10-01T12:00:00.000Z",
    reviewState: "pending",
    discordId: null,
    discordSource: null,
    patreonDiscordId: null,
    patronLinkConflict: null,
    patronLinkedAt: null,
    steamId: null,
    steamSource: null,
    steamApplicationId: null,
    identityState: "unlinked",
    version: 1,
    latestPayment: null,
    payments: [],
    founderEligiblePayment: null,
    founder: null,
    founderBlockedReason: "no_payment",
    founderBlockedMessage: null,
    needsDiscordLink: false,
    match: {
      steam: null,
      sourceApplication: null,
      sourceApplicationRevoked: false,
      patreonDiscordElsewhere: false,
      discordReportedForOtherPatron: false,
      linkedSteamShared: false,
    },
    automaticPayment: null,
    automaticBlockedReason: "no_discord",
    automaticBlockedMessage: null,
    ...overrides,
  };
}
