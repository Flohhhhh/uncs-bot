import {
  applicationFixture as application,
  FIXTURE_DISCORD_ID as discordId,
  FIXTURE_STEAM_ID as steamId,
  paymentFixture,
  supporterFixture,
} from "./supporter-fixtures";
import {
  applicationSteamMatch,
  automaticFounderBlocker,
  sourceApplicationRevoked,
  supporterNextSteps,
  type MatchFacts,
  type MatchMember,
  type NextStepContext,
  type SteamMatch,
  type SteamMatchBlock,
} from "./supporter-match.rules";
import type { SupporterView } from "./supporters.types";

const otherSteam = "76561198000000002";

describe("the SteamID an approved whitelist application offers", () => {
  it.each([
    ["no application", [], { reason: "no_application", steamId: null }],
    [
      "an application under review",
      [application(), application({ id: "b2", serverId: "event", status: "needs_review" })],
      { reason: "application_in_progress", applicationId: "b2" },
    ],
    ["a revocation under way", [application({ status: "revoking" })], { reason: "application_in_progress" }],
    ["an approval under way", [application({ status: "processing" })], { reason: "application_in_progress" }],
    ["only a pending application", [application({ status: "pending" })], { reason: "application_pending" }],
    ["only a declined application", [application({ status: "declined" })], { reason: "no_approved_application" }],
    [
      "a revoked application",
      [application({ status: "revoked", accessIntent: "revoke", revokedAt: "2026-10-02T00:00:00Z" })],
      { reason: "no_approved_application" },
    ],
    [
      "an approved application with a revocation time",
      [application({ revokedAt: "2026-10-02T00:00:00Z" })],
      { reason: "no_approved_application" },
    ],
    [
      "an approved application meant to revoke",
      [application({ accessIntent: "revoke" })],
      { reason: "no_approved_application" },
    ],
    [
      "two approved SteamIDs",
      [application(), application({ id: "b2", serverId: "event", steamId: otherSteam })],
      { reason: "several_steam_ids", steamId: null },
    ],
    ["an invalid SteamID", [application({ steamId: "76561190000000001" })], { reason: "invalid_steam_id" }],
    [
      "an approval without a recorded grant",
      [application({ whitelistGrant: null })],
      { reason: "application_not_confirmed", steamId, applicationId: application().id },
    ],
    [
      "another Discord account's claim",
      [application({ otherDiscordClaim: true })],
      { reason: "steam_shared", steamId },
    ],
    ["an earlier rejection", [application({ rejectedBefore: true })], { reason: "steam_rejected_before", steamId }],
    [
      "another supporter record",
      [application({ otherSupporter: true })],
      { reason: "steam_on_another_record", steamId },
    ],
  ])("refuses %s", (_name, applications, expected) => {
    expect(applicationSteamMatch(applications)).toMatchObject(expected);
  });
  it("offers the SteamID of the earliest confirmed approval, also when two servers approved the same SteamID", () => {
    expect(
      applicationSteamMatch([
        application({ id: "late", serverId: "event", reviewedAt: "2026-10-03T00:00:00Z", whitelistGrant: "existing" }),
        application({ id: "early", reviewedAt: "2026-10-02T00:00:00Z" }),
        application({ id: "unconfirmed", serverId: "east", reviewedAt: "2026-10-01T00:00:00Z", whitelistGrant: null }),
      ]),
    ).toEqual({ reason: null, steamId, applicationId: "early", serverId: "primary" });
  });
  it("ignores a pending application for another SteamID and declined or revoked ones", () => {
    expect(
      applicationSteamMatch([
        application(),
        application({ id: "pending", serverId: "event", status: "pending", steamId: otherSteam }),
        application({ id: "declined", serverId: "east", status: "declined", steamId: otherSteam }),
        application({ id: "revoked", serverId: "west", status: "revoked", steamId: otherSteam }),
      ]),
    ).toMatchObject({ reason: null, steamId });
  });
});

const patreonDiscord: MatchMember = {
  provider: "patreon",
  discordId,
  discordSource: "patreon",
  patreonDiscordId: discordId,
  steamId,
  steamSource: "staff",
  steamApplicationId: null,
  lastChargeStatus: "Paid",
  lastChargeAt: "2026-10-01T12:00:00.000Z",
};
const facts = (overrides: Partial<MatchFacts> = {}): MatchFacts => ({
  applications: [application()],
  automatic: { payment: paymentFixture(), earlier: false, earlierOtherRecord: false },
  discordReportedForOtherPatron: false,
  patreonDiscordElsewhere: false,
  linkedSteamShared: false,
  ...overrides,
});
const later = { now: Date.parse("2026-10-05T12:00:00.000Z"), holdHours: 72 };

describe("the automatic founder rule", () => {
  it("accepts a Patreon Discord account, a valid SteamID and a settled first imported payment", () => {
    expect(automaticFounderBlocker(patreonDiscord, facts(), later)).toBeNull();
  });
  it.each([
    ["a PayPal record", { provider: "paypal" }, {}, "not_patreon"],
    ["no Discord account", { discordId: null, discordSource: null }, {}, "no_discord"],
    ["a staff-entered Discord account", { discordSource: "staff" }, {}, "discord_not_from_patreon"],
    ["an unclassified Discord account", { discordSource: null }, {}, "discord_not_from_patreon"],
    ["Patreon reporting another account", { patreonDiscordId: "234567890123456789" }, {}, "discord_differs"],
    ["Patreon reporting no account", { patreonDiscordId: null }, {}, "discord_differs"],
    [
      "the account reported for another patron",
      {},
      { discordReportedForOtherPatron: true },
      "discord_reported_for_other_patron",
    ],
    ["no SteamID", { steamId: null, steamSource: null }, {}, "no_steam"],
    ["an invalid SteamID", { steamId: "76561190000000001" }, {}, "no_steam"],
    ["no imported first payment", {}, { automatic: null }, "no_patreon_payment"],
    [
      "a refunded latest charge",
      { lastChargeStatus: "Refunded", lastChargeAt: "2026-10-02T00:00:00Z" },
      {},
      "charge_reversed",
    ],
    ["a reversed charge with no date", { lastChargeStatus: "Fraud", lastChargeAt: null }, {}, "charge_reversed"],
    [
      "an earlier payment on another record",
      {},
      { automatic: { payment: paymentFixture(), earlier: false, earlierOtherRecord: true } },
      "earlier_payment_other_record",
    ],
  ] as const)("refuses %s", (_name, member, factChange, reason) => {
    expect(automaticFounderBlocker({ ...patreonDiscord, ...member }, facts(factChange), later)).toBe(reason);
  });
  it.each([
    ["dated with the payment", paymentFixture().paidAt],
    ["dated a few seconds before the payment", "2026-10-01T11:59:55.000Z"],
    ["dated before the payment", "2026-09-01T00:00:00Z"],
  ])("refuses a reversed latest charge %s, which can be the qualifying charge itself", (_name, lastChargeAt) => {
    for (const lastChargeStatus of ["Refunded", "Fraud"])
      expect(automaticFounderBlocker({ ...patreonDiscord, lastChargeStatus, lastChargeAt }, facts(), later)).toBe(
        "charge_reversed",
      );
    expect(
      automaticFounderBlocker({ ...patreonDiscord, lastChargeStatus: "Paid", lastChargeAt }, facts(), later),
    ).toBeNull();
  });
  describe("a SteamID staff linked", () => {
    it("is refused when this Discord account's approved application names another SteamID", () => {
      const differs = facts({ applications: [application({ steamId: otherSteam })] });
      expect(automaticFounderBlocker(patreonDiscord, differs, later)).toBe("steam_differs_from_application");
      expect(automaticFounderBlocker({ ...patreonDiscord, steamSource: null }, differs, later)).toBe(
        "steam_differs_from_application",
      );
      // An application that only offers this same SteamID, or none, is no alert.
      expect(automaticFounderBlocker(patreonDiscord, facts(), later)).toBeNull();
      expect(automaticFounderBlocker(patreonDiscord, facts({ applications: [] }), later)).toBeNull();
    });
    it.each([
      ["pending", { status: "pending" as const }],
      ["under review", { status: "needs_review" as const }],
    ])("is not doubted for a %s application with another SteamID", (_name, change) => {
      expect(
        automaticFounderBlocker(
          patreonDiscord,
          facts({ applications: [application({ steamId: otherSteam, ...change })] }),
          later,
        ),
      ).toBeNull();
    });
    it("is refused while another Discord account has applied with it", () => {
      expect(automaticFounderBlocker(patreonDiscord, facts({ linkedSteamShared: true }), later)).toBe("steam_shared");
      expect(
        automaticFounderBlocker(
          { ...patreonDiscord, steamSource: "application", steamApplicationId: application().id },
          facts({ linkedSteamShared: true }),
          later,
        ),
      ).toBe("steam_shared");
    });
  });
  it("waits the configured hours after the payment", () => {
    const paidAt = Date.parse(paymentFixture().paidAt);
    expect(automaticFounderBlocker(patreonDiscord, facts(), { now: paidAt + 72 * 3_600_000 - 1, holdHours: 72 })).toBe(
      "payment_too_recent",
    );
    expect(
      automaticFounderBlocker(patreonDiscord, facts(), { now: paidAt + 72 * 3_600_000, holdHours: 72 }),
    ).toBeNull();
    expect(automaticFounderBlocker(patreonDiscord, facts(), { now: paidAt, holdHours: 0 })).toBeNull();
  });
  it("checks the Discord rules before the SteamID and the payment", () => {
    expect(
      automaticFounderBlocker(
        { ...patreonDiscord, discordSource: "staff", steamId: null },
        facts({ automatic: null }),
        later,
      ),
    ).toBe("discord_not_from_patreon");
  });
  describe("a SteamID copied from an application", () => {
    const copied = { ...patreonDiscord, steamSource: "application" as const, steamApplicationId: application().id };
    it("is rechecked against the applications before a founder promise", () => {
      expect(automaticFounderBlocker(copied, facts(), later)).toBeNull();
      expect(
        automaticFounderBlocker(copied, facts({ applications: [application({ status: "revoked" })] }), later),
      ).toBe("source_application_revoked");
      expect(
        automaticFounderBlocker(
          copied,
          facts({
            applications: [application(), application({ id: "b2", serverId: "event", status: "needs_review" })],
          }),
          later,
        ),
      ).toBe("application_in_progress");
      expect(
        automaticFounderBlocker(copied, facts({ applications: [application({ otherDiscordClaim: true })] }), later),
      ).toBe("steam_shared");
      expect(
        automaticFounderBlocker(copied, facts({ applications: [application({ rejectedBefore: true })] }), later),
      ).toBe("steam_rejected_before");
    });
    it("is flagged only when no approved application for that SteamID remains", () => {
      const copiedFacts = facts({
        applications: [application({ status: "revoked" }), application({ id: "b2", serverId: "event" })],
      });
      expect(sourceApplicationRevoked(copied, copiedFacts)).toBe(false);
      expect(sourceApplicationRevoked(copied, facts({ applications: [application({ status: "revoked" })] }))).toBe(
        true,
      );
      expect(sourceApplicationRevoked(patreonDiscord, facts({ applications: [] }))).toBe(false);
    });
  });
});

const on: NextStepContext = { steamFill: true, founderAuto: true, importConfigured: true, holdHours: 72 };
const off: NextStepContext = { steamFill: false, founderAuto: false, importConfigured: true, holdHours: 72 };
const codes = (record: SupporterView, context = on) => supporterNextSteps(record, context).map((step) => step.code);
const ready = (overrides: Partial<SupporterView> = {}) =>
  supporterFixture({
    discordId,
    discordSource: "patreon",
    patreonDiscordId: discordId,
    steamId,
    steamSource: "staff",
    identityState: "patreon_linked",
    founderEligiblePayment: paymentFixture(),
    founderBlockedReason: null,
    automaticBlockedReason: null,
    match: {
      steam: { reason: null, steamId, applicationId: application().id, serverId: "primary" },
      sourceApplication: null,
      sourceApplicationRevoked: false,
      patreonDiscordElsewhere: false,
      discordReportedForOtherPatron: false,
      linkedSteamShared: false,
    },
    ...overrides,
  });
const steamMatch = (reason: SteamMatchBlock | null): SteamMatch => ({
  reason,
  steamId,
  applicationId: application().id,
  serverId: "primary",
});

describe("next steps on the Supporters page", () => {
  it("lists nothing for a founder with both identities", () => {
    expect(
      codes(
        ready({
          founder: { awardedAt: "2026-10-02T00:00:00Z", paymentId: "p", source: "patreon_api", automatic: true },
        }),
      ),
    ).toEqual([]);
  });
  it.each([
    ["the import fills it in", supporterFixture(), on, "connect_discord_in_patreon"],
    ["the import is off", supporterFixture(), { ...on, importConfigured: false }, "link_discord_no_import"],
    ["a PayPal donor", supporterFixture({ provider: "paypal" }), on, "link_discord_paypal"],
    [
      "Patreon reports an account another record links",
      supporterFixture({
        patreonDiscordId: discordId,
        match: { ...supporterFixture().match, patreonDiscordElsewhere: true },
      }),
      on,
      "discord_on_another_record",
    ],
  ])("asks for a Discord account when %s", (_name, record, context, code) => {
    expect(codes(record, context)[0]).toBe(code);
  });
  it("flags a different Discord account reported by Patreon and one reported for another patron", () => {
    expect(codes(ready({ patreonDiscordId: "234567890123456789" }))).toContain("discord_differs");
    expect(codes(ready({ match: { ...ready().match, discordReportedForOtherPatron: true } }))).toContain(
      "discord_reported_for_other_patron",
    );
  });
  it("flags a Discord account from Patreon that Patreon no longer reports, also for a founder", () => {
    const disconnected = ready({ patreonDiscordId: null });
    const [step] = supporterNextSteps(disconnected, on);
    expect(step).toMatchObject({ code: "discord_not_reported", area: "discord" });
    expect(step.message).toContain("no longer reports this Discord account");
    expect(
      codes(
        ready({
          patreonDiscordId: null,
          founder: { awardedAt: "2026-10-02T00:00:00Z", paymentId: "p", source: "patreon_api", automatic: true },
        }),
      ),
    ).toEqual(["discord_not_reported"]);
    // Only for an account Patreon supplied, and only while the import keeps Patreon's answer current.
    expect(codes(ready({ patreonDiscordId: null, discordSource: "staff" }))).not.toContain("discord_not_reported");
    expect(codes(disconnected, { ...on, importConfigured: false })).not.toContain("discord_not_reported");
    expect(codes(ready())).not.toContain("discord_not_reported");
  });
  it.each([
    ["no_application", "no_whitelist_application"],
    ["application_pending", "application_pending"],
    ["application_in_progress", "application_in_progress"],
    ["no_approved_application", "no_approved_application"],
    ["application_not_confirmed", "application_not_confirmed"],
    ["several_steam_ids", "several_steam_ids"],
    ["invalid_steam_id", "invalid_steam_id"],
    ["steam_shared", "steam_shared"],
    ["steam_rejected_before", "steam_rejected_before"],
    ["steam_on_another_record", "steam_on_another_record"],
  ] as const)("explains a missing SteamID (%s)", (reason, code) => {
    const record = ready({ steamId: null, steamSource: null, match: { ...ready().match, steam: steamMatch(reason) } });
    expect(codes(record)).toContain(code);
  });
  it("says Gramps copies an available SteamID only for Patreon with the fill on", () => {
    const missing = { steamId: null, steamSource: null } as const;
    expect(codes(ready(missing))).toContain("steam_ready_automatic");
    expect(codes(ready(missing), off)).toContain("steam_available");
    expect(codes(ready({ ...missing, provider: "paypal" }))).toContain("steam_available");
  });
  it.each(["no_application", "application_pending"] as const)(
    "promises a SteamID fill for %s only for Patreon with the fill on",
    (reason) => {
      const steam = { steamId: null, steamSource: null, match: { ...ready().match, steam: steamMatch(reason) } };
      const message = (record: SupporterView, context: NextStepContext) =>
        supporterNextSteps(record, context).find((step) => step.area === "steam")!.message;
      expect(message(ready(steam), on)).toContain("fills in once");
      for (const [record, context] of [
        [ready(steam), off],
        [ready(steam), { ...on, steamFill: false }],
        [ready({ ...steam, provider: "paypal" }), on],
      ] as const) {
        expect(message(record, context)).not.toContain("fills in");
        expect(message(record, context)).toContain("Staff can link the SteamID");
      }
    },
  );
  it("hides SteamID steps once no founder promise is possible, but keeps them for a founder without one", () => {
    for (const founderBlockedReason of ["outside_window", "below_minimum", "already_founder"] as const)
      expect(supporterNextSteps(ready({ steamId: null, founderBlockedReason }), on)).toEqual([
        // Not a task: why no founder promise is possible on this record.
        expect.objectContaining({ code: `founder_${founderBlockedReason}`, area: "info" }),
      ]);
    expect(
      codes(
        ready({
          steamId: null,
          founder: { awardedAt: "2026-10-02T00:00:00Z", paymentId: "p", source: "manual_receipt", automatic: false },
        }),
      ),
    ).toEqual(["steam_ready_automatic"]);
  });
  it("flags a revoked source application and a staff SteamID that differs from the approved application", () => {
    expect(
      codes(ready({ steamSource: "application", match: { ...ready().match, sourceApplicationRevoked: true } })),
    ).toContain("source_application_revoked");
    expect(codes(ready({ steamId: otherSteam }))).toContain("steam_differs_from_application");
    // A pending application's SteamID is no reason to doubt the linked one.
    expect(
      codes(ready({ steamId: otherSteam, match: { ...ready().match, steam: steamMatch("application_pending") } })),
    ).not.toContain("steam_differs_from_application");
  });
  it("flags a linked SteamID another Discord account applied with, also for a founder", () => {
    const shared = { match: { ...ready().match, linkedSteamShared: true } };
    expect(codes(ready(shared))).toContain("linked_steam_shared");
    expect(
      codes(
        ready({
          ...shared,
          founder: { awardedAt: "2026-10-02T00:00:00Z", paymentId: "p", source: "patreon_api", automatic: false },
        }),
      ),
    ).toEqual(["linked_steam_shared"]);
    expect(codes(ready())).not.toContain("linked_steam_shared");
  });
  it("tells automatic recording, recording with automation off and staff recording apart", () => {
    expect(codes(ready())).toEqual(["founder_ready_automatic"]);
    expect(codes(ready(), off)).toEqual(["founder_ready_automatic_off"]);
    expect(codes(ready({ automaticBlockedReason: "discord_not_from_patreon" }))).toEqual(["founder_ready_staff"]);
    expect(codes(ready({ automaticBlockedReason: "payment_too_recent" }))).toEqual(["founder_automatic_waiting"]);
    const [waiting] = supporterNextSteps(
      ready({ automaticBlockedReason: "payment_too_recent", automaticPayment: paymentFixture() }),
      { ...on, holdHours: 48 },
    );
    expect(waiting.message).toBe(
      "Gramps records it after the refund waiting period (48 hours from the payment, until 2026-10-03 12:00 UTC). Recording it sooner skips that wait.",
    );
    expect(
      supporterNextSteps(ready({ automaticBlockedReason: "payment_too_recent", automaticPayment: null }), on)[0]
        .message,
    ).toContain("(72 hours from the payment)");
    expect(codes(ready({ automaticBlockedReason: "payment_too_recent" }), off)).toEqual(["founder_ready_staff"]);
    const paypal = supporterNextSteps(ready({ provider: "paypal", automaticBlockedReason: "not_patreon" }), on);
    expect(paypal.map((step) => step.code)).toEqual(["founder_ready_staff"]);
    expect(paypal[0].message).toContain("PayPal founders are always recorded by staff");
  });
  it("groups payment problems apart from other founder reasons and explains another currency", () => {
    const steps = supporterNextSteps(ready({ founderBlockedReason: "not_first_payment" }), on);
    expect(steps.at(-1)).toMatchObject({ code: "founder_not_first_payment", area: "payment" });
    expect(supporterNextSteps(ready({ founderBlockedReason: "outside_window" }), on).at(-1)).toMatchObject({
      area: "info",
    });
    expect(supporterNextSteps(ready({ founderBlockedReason: "window_not_configured" }), on).at(-1)).toMatchObject({
      area: "founder",
    });
    const euro = supporterNextSteps(
      ready({
        founderBlockedReason: "below_minimum",
        latestPayment: paymentFixture({ currency: "EUR" }),
        founderEligiblePayment: null,
      }),
      on,
    );
    expect(euro.at(-1)!.message).toContain("EUR payment");
    // Another currency needs a staff decision, so it stays a founder task rather than a note.
    expect(euro.at(-1)!.area).toBe("founder");
  });
  it("asks for a Discord account for a founder without one", () => {
    expect(
      codes(
        ready({
          discordId: null,
          discordSource: null,
          needsDiscordLink: true,
          match: { ...ready().match, steam: null },
          founder: { awardedAt: "2026-10-02T00:00:00Z", paymentId: "p", source: "paypal", automatic: false },
        }),
      ),
    ).toEqual(["connect_discord_in_patreon", "founder_needs_discord"]);
  });
});
