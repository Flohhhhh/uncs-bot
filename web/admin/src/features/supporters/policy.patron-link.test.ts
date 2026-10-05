import { describe, expect, it } from "vitest";
import { discordDescription, matchSummary } from "./policy";
import type { Supporter } from "./types";

/** A Patreon record whose Discord account the patron linked by signing in ("Link Patreon"). */
const linkedByPatron: Supporter = {
  id: "01234567-89ab-4cde-8fab-0123456789ab",
  provider: "patreon",
  patreonMemberId: "patreon-member-1",
  confirmKey: "patreon-member-1",
  displayName: "Fixture patron",
  patronStatus: "active_patron",
  lastChargeStatus: "Paid",
  lastChargeAt: "2026-10-01T12:00:00Z",
  observedAt: "2026-10-01T12:00:00Z",
  reviewState: "pending",
  discordId: "23456789012345678",
  discordSource: "patron_signin",
  patreonDiscordId: null,
  steamId: null,
  steamSource: null,
  steamApplicationId: null,
  identityState: "partial",
  version: 2,
  latestPayment: null,
  founderEligiblePayment: null,
  founder: null,
  founderBlockedReason: "no_payment",
  founderBlockedMessage: "No payment is recorded for this supporter.",
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
  automaticBlockedReason: "no_patreon_payment",
  automaticBlockedMessage: null,
  nextSteps: [],
};

describe("a Discord account linked by the patron's own sign-in", () => {
  it("is labelled as linked by the patron", () => {
    expect(discordDescription(linkedByPatron)).toBe("Linked by patron through Discord and Patreon sign-in.");
    expect(matchSummary(linkedByPatron)).toBe("Discord: patron · SteamID: not linked");
  });

  it("still says what Patreon reports for it", () => {
    expect(discordDescription({ ...linkedByPatron, patreonDiscordId: "23456789012345678" })).toBe(
      "Linked by patron through Discord and Patreon sign-in. Patreon reports the same account.",
    );
    expect(discordDescription({ ...linkedByPatron, patreonDiscordId: "34567890123456789" })).toBe(
      "Linked by patron through Discord and Patreon sign-in. Patreon now reports a different account: 34567890123456789.",
    );
  });

  it("leaves the other labels as they were", () => {
    expect(matchSummary({ ...linkedByPatron, discordSource: "patreon" })).toBe(
      "Discord: Patreon · SteamID: not linked",
    );
    expect(matchSummary({ ...linkedByPatron, discordSource: "staff", steamId: "76561198000000001" })).toBe(
      "Discord: staff · SteamID: staff",
    );
    expect(matchSummary({ ...linkedByPatron, steamId: "76561198000000001", steamSource: "application" })).toBe(
      "Discord: patron · SteamID: application",
    );
    expect(matchSummary({ ...linkedByPatron, discordId: null })).toBe("Discord: not linked · SteamID: not linked");
  });
});
