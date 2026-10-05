import {
  applicationFixture as application,
  FIXTURE_DISCORD_ID as discordId,
  FIXTURE_STEAM_ID as steamId,
  paymentFixture,
  supporterFixture,
} from "./supporter-fixtures";
import {
  applicationSteamMatch,
  appliedSteamIds,
  automaticBlockedMessages,
  automaticFounderBlocker,
  heldOnAnotherRecord,
  sourceApplicationRevoked,
  supporterNextSteps,
  type ApplicationFact,
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
  describe("with only a Discord account", () => {
    const discordOnly: MatchMember = { ...patreonDiscord, steamId: null, steamSource: null };
    it("needs no SteamID", () => {
      expect(automaticFounderBlocker(discordOnly, facts(), later)).toBeNull();
      expect(automaticFounderBlocker(discordOnly, facts({ applications: [] }), later)).toBeNull();
    });
    it.each<[string, Partial<MatchFacts>]>([
      ["names another SteamID", { applications: [application({ steamId: otherSteam })] }],
      ["was approved without a recorded grant", { applications: [application({ whitelistGrant: null })] }],
      ["is under review", { applications: [application({ status: "needs_review" })] }],
      ["was revoked", { applications: [application({ status: "revoked", accessIntent: "revoke" })] }],
      ["names a SteamID another account applied with", { applications: [application({ otherDiscordClaim: true })] }],
      ["names a SteamID that was rejected before", { applications: [application({ rejectedBefore: true })] }],
    ])("skips the SteamID checks when the application %s", (_name, change) => {
      expect(automaticFounderBlocker(discordOnly, facts(change), later)).toBeNull();
    });
    it.each<[string, Partial<ApplicationFact>]>([
      ["approved", {}],
      ["pending", { status: "pending" }],
      ["under review", { status: "needs_review" }],
    ])(
      "leaves it to staff when another supporter record holds the SteamID of an application that is %s",
      (_name, change) => {
        // That record may be the same person's, with its own founder promise or an earlier payment.
        const held = facts({ applications: [application({ otherSupporter: true, ...change })] });
        expect(heldOnAnotherRecord(held)).toBe(true);
        expect(automaticFounderBlocker(discordOnly, held, later)).toBe("steam_on_another_record");
      },
    );
    it.each(["declined", "revoked"] as const)(
      "ignores a SteamID another record holds when the application naming it was %s",
      (status) => {
        const held = facts({ applications: [application({ otherSupporter: true, status })] });
        expect(heldOnAnotherRecord(held)).toBe(false);
        expect(automaticFounderBlocker(discordOnly, held, later)).toBeNull();
      },
    );
    it("checks the Discord account before another record's SteamID", () => {
      const held = facts({ applications: [application({ otherSupporter: true })] });
      expect(automaticFounderBlocker({ ...discordOnly, discordSource: "staff" }, held, later)).toBe(
        "discord_not_from_patreon",
      );
    });
    it.each([
      ["a staff-entered Discord account", { discordSource: "staff" }, {}, "discord_not_from_patreon"],
      ["Patreon reporting no account", { patreonDiscordId: null }, {}, "discord_differs"],
      [
        "the account reported for another patron",
        {},
        { discordReportedForOtherPatron: true },
        "discord_reported_for_other_patron",
      ],
      ["no imported first payment", {}, { automatic: null }, "no_patreon_payment"],
      ["a refunded latest charge", { lastChargeStatus: "Refunded" }, {}, "charge_reversed"],
      [
        "an earlier payment on another record",
        {},
        { automatic: { payment: paymentFixture(), earlier: false, earlierOtherRecord: true } },
        "earlier_payment_other_record",
      ],
    ] as const)("still refuses %s", (_name, member, factChange, reason) => {
      expect(automaticFounderBlocker({ ...discordOnly, ...member }, facts(factChange), later)).toBe(reason);
    });
    it("still waits out the hold", () => {
      const paidAt = Date.parse(paymentFixture().paidAt);
      expect(automaticFounderBlocker(discordOnly, facts(), { now: paidAt + 3_600_000, holdHours: 72 })).toBe(
        "payment_too_recent",
      );
    });
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
    // The staff founder rule refuses a linked SteamID that is not a valid player ID with this same reason.
    ["an invalid SteamID", { steamId: "76561190000000001" }, {}, "no_identity"],
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
  describe("another SteamID the Discord account applied with", () => {
    // The approved application's SteamID is clean. A second application, on another server, names a SteamID that
    // another supporter record holds.
    const elsewhere = (change: Partial<ApplicationFact> = {}) =>
      facts({
        applications: [
          application(),
          application({ id: "b2", serverId: "event", steamId: otherSteam, status: "pending", ...change }),
        ],
      });
    const held = elsewhere({ otherSupporter: true });
    const discordOnly: MatchMember = { ...patreonDiscord, steamId: null, steamSource: null };
    const copied: MatchMember = { ...patreonDiscord, steamSource: "application", steamApplicationId: application().id };
    it("leaves the founder to staff before and after the SteamID fill, and for a SteamID staff linked", () => {
      // The fill would copy the approved SteamID: the pending application does not stop it.
      expect(applicationSteamMatch(held.applications)).toMatchObject({ reason: null, steamId });
      for (const member of [discordOnly, copied, patreonDiscord]) {
        expect(heldOnAnotherRecord(held, member.steamId)).toBe(true);
        expect(automaticFounderBlocker(member, held, later)).toBe("steam_on_another_record");
        expect(automaticFounderBlocker(member, elsewhere(), later)).toBeNull();
      }
    });
    it.each(["declined", "revoked"] as const)("ignores one named only by a %s application", (status) => {
      for (const member of [discordOnly, copied, patreonDiscord])
        expect(automaticFounderBlocker(member, elsewhere({ otherSupporter: true, status }), later)).toBeNull();
    });
    it("leaves a holder of the linked SteamID itself to the founder checks, which compare that SteamID", () => {
      const sameSteam = facts({ applications: [application({ otherSupporter: true })] });
      expect(heldOnAnotherRecord(sameSteam, steamId)).toBe(false);
      // A SteamID staff linked: the staff founder rule sees the other record's founder promise and earlier payment.
      expect(automaticFounderBlocker(patreonDiscord, sameSteam, later)).toBeNull();
      // A SteamID copied from the application is still refused by the SteamID rule.
      expect(automaticFounderBlocker(copied, sameSteam, later)).toBe("steam_on_another_record");
    });
    it("checks a linked SteamID's own alerts first", () => {
      expect(automaticFounderBlocker(patreonDiscord, { ...held, linkedSteamShared: true }, later)).toBe("steam_shared");
    });
    it("lists the SteamIDs whose holders are checked: applied with, not declined or revoked, not the linked one", () => {
      const applications = [
        application({ steamId: otherSteam, status: "pending" }),
        application({ id: "b2", serverId: "event" }),
        application({ id: "b3", serverId: "east" }),
        application({ id: "b4", serverId: "west", steamId: "76561198000000003", status: "declined" }),
        application({ id: "b5", serverId: "north", steamId: "76561198000000004", status: "revoked" }),
      ];
      expect(appliedSteamIds({ applications })).toEqual([steamId, otherSteam]);
      expect(appliedSteamIds({ applications }, steamId)).toEqual([otherSteam]);
      expect(appliedSteamIds({ applications: [] })).toEqual([]);
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
  it("asks for a Discord account in one short sentence while the import runs", () => {
    expect(supporterNextSteps(supporterFixture(), on)[0]).toEqual({
      code: "connect_discord_in_patreon",
      area: "discord",
      message: "Waiting for them to connect Discord on Patreon.",
    });
    expect(supporterNextSteps(supporterFixture({ patreonDiscordId: discordId }), on)[0].message).toBe(
      "Gramps links their Discord at the next sync.",
    );
  });
  it("words each Discord step in one short sentence", () => {
    const message = (record: SupporterView, context = on) => supporterNextSteps(record, context)[0].message;
    expect(message(supporterFixture({ provider: "paypal" }))).toBe("Add their Discord account so they get roles.");
    expect(message(supporterFixture(), { ...on, importConfigured: false })).toBe(
      "Patreon sync is off, so add their Discord here.",
    );
    expect(
      message(
        supporterFixture({
          patreonDiscordId: discordId,
          match: { ...supporterFixture().match, patreonDiscordElsewhere: true },
        }),
      ),
    ).toBe(`Discord account ${discordId} is already on another supporter.`);
    expect(message(ready({ patreonDiscordId: "234567890123456789" }))).toBe(
      "Patreon now shows a different Discord account, 234567890123456789.",
    );
    expect(message(ready({ match: { ...ready().match, discordReportedForOtherPatron: true } }))).toBe(
      "Patreon shows this Discord account for another supporter too.",
    );
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
    expect(step).toEqual({
      code: "discord_not_reported",
      area: "discord",
      message: "Patreon no longer shows this Discord account for them.",
    });
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
    ["no_application", "no_whitelist_application", "No approved whitelist application yet."],
    ["application_pending", "application_pending", "Their whitelist application is waiting for review."],
    ["application_in_progress", "application_in_progress", "Their whitelist application is in review."],
    ["no_approved_application", "no_approved_application", "No approved whitelist application yet."],
    [
      "application_not_confirmed",
      "application_not_confirmed",
      `Check this SteamID (${steamId}) is theirs, then add it.`,
    ],
    ["several_steam_ids", "several_steam_ids", "Their applications list different SteamIDs."],
    ["invalid_steam_id", "invalid_steam_id", `The SteamID (${steamId}) on their application is not valid.`],
    ["steam_shared", "steam_shared", `Another Discord account applied with this SteamID (${steamId}).`],
    ["steam_rejected_before", "steam_rejected_before", `This SteamID (${steamId}) was declined or revoked before.`],
    ["steam_on_another_record", "steam_on_another_record", `Another supporter already has this SteamID (${steamId}).`],
  ] as const)("explains a missing SteamID (%s)", (reason, code, message) => {
    const record = ready({ steamId: null, steamSource: null, match: { ...ready().match, steam: steamMatch(reason) } });
    expect(supporterNextSteps(record, on)).toContainEqual({ code, area: "steam", message });
  });
  it("says Gramps copies an available SteamID only for Patreon with the fill on", () => {
    const missing = { steamId: null, steamSource: null } as const;
    const steamStep = (record: SupporterView, context: NextStepContext) =>
      supporterNextSteps(record, context).find((step) => step.area === "steam");
    expect(steamStep(ready(missing), on)).toEqual({
      code: "steam_ready_automatic",
      area: "steam",
      message: "Gramps adds their SteamID at the next sync.",
    });
    const available = {
      code: "steam_available",
      area: "steam",
      message: `Add the SteamID (${steamId}) from their application.`,
    };
    expect(steamStep(ready(missing), off)).toEqual(available);
    expect(steamStep(ready({ ...missing, provider: "paypal" }), on)).toEqual(available);
  });
  it.each(["no_application", "application_pending"] as const)(
    "words %s the same whether or not Gramps fills the SteamID",
    (reason) => {
      const steam = { steamId: null, steamSource: null, match: { ...ready().match, steam: steamMatch(reason) } };
      const message = (record: SupporterView, context: NextStepContext) =>
        supporterNextSteps(record, context).find((step) => step.area === "steam")!.message;
      const filled = message(ready(steam), on);
      for (const [record, context] of [
        [ready(steam), off],
        [ready(steam), { ...on, steamFill: false }],
        [ready({ ...steam, provider: "paypal" }), on],
      ] as const)
        expect(message(record, context)).toBe(filled);
    },
  );
  it("names an application on a server the viewer cannot open without its SteamID", () => {
    const hidden: NextStepContext = { ...off, serverVisible: (serverId) => serverId !== "primary" };
    const missing = { steamId: null, steamSource: null } as const;
    const message = (record: SupporterView) =>
      supporterNextSteps(record, hidden).find((step) => step.area === "steam")!.message;
    // The viewer cannot take the SteamID from an application they cannot see, so they ask the supporter for it.
    const ask = "Their application is on a server you cannot open, so ask them for their SteamID.";
    expect(message(ready(missing))).toBe(ask);
    expect(message(ready({ ...missing, provider: "paypal" }))).toBe(ask);
    expect(
      message(ready({ ...missing, match: { ...ready().match, steam: steamMatch("application_not_confirmed") } })),
    ).toBe(ask);
    // Gramps can still copy it, whoever is looking.
    expect(supporterNextSteps(ready(missing), { ...on, serverVisible: hidden.serverVisible })).toContainEqual({
      code: "steam_ready_automatic",
      area: "steam",
      message: "Gramps adds their SteamID at the next sync.",
    });
    expect(message(ready({ ...missing, match: { ...ready().match, steam: steamMatch("steam_shared") } }))).toBe(
      "Another Discord account applied with this SteamID (on a server you cannot open).",
    );
    expect(message(ready({ steamId: otherSteam }))).toBe(
      "Their application lists a different SteamID (on a server you cannot open).",
    );
  });
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
      supporterNextSteps(
        ready({ steamSource: "application", match: { ...ready().match, sourceApplicationRevoked: true } }),
        on,
      ),
    ).toContainEqual({
      code: "source_application_revoked",
      area: "steam",
      message: "The application this SteamID came from is no longer approved.",
    });
    expect(supporterNextSteps(ready({ steamId: otherSteam }), on)).toContainEqual({
      code: "steam_differs_from_application",
      area: "steam",
      message: `Their application lists a different SteamID (${steamId}).`,
    });
    // A pending application's SteamID is no reason to doubt the linked one.
    expect(
      codes(ready({ steamId: otherSteam, match: { ...ready().match, steam: steamMatch("application_pending") } })),
    ).not.toContain("steam_differs_from_application");
  });
  it("flags a linked SteamID another Discord account applied with, also for a founder", () => {
    const shared = { match: { ...ready().match, linkedSteamShared: true } };
    expect(supporterNextSteps(ready(shared), on)).toContainEqual({
      code: "linked_steam_shared",
      area: "steam",
      message: "Another Discord account applied with their SteamID.",
    });
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
  it("says Gramps records a founder who has only a Discord account, and still asks for the SteamID", () => {
    const discordOnly = ready({ steamId: null, steamSource: null, identityState: "partial" });
    expect(codes(discordOnly)).toEqual(["steam_ready_automatic", "founder_ready_automatic"]);
    expect(codes(discordOnly, off)).toEqual(["steam_available", "founder_ready_automatic_off"]);
    const none = { ...ready().match, steam: steamMatch("no_application") };
    expect(codes(ready({ steamId: null, steamSource: null, match: none }))).toEqual([
      "no_whitelist_application",
      "founder_ready_automatic",
    ]);
  });
  it("leaves a founder to staff when another record holds the SteamID the Discord account applied with", () => {
    const steps = supporterNextSteps(
      ready({
        steamId: null,
        steamSource: null,
        automaticBlockedReason: "steam_on_another_record",
        match: { ...ready().match, steam: steamMatch("steam_on_another_record") },
      }),
      on,
    );
    expect(steps.map((step) => step.code)).toEqual(["steam_on_another_record", "founder_ready_staff"]);
    expect(steps[0].message).toBe(`Another supporter already has this SteamID (${steamId}).`);
    // Why automation would not record it is the record's automaticBlockedMessage, so the step stays one sentence.
    expect(steps[1].message).toBe("Ready to be made a founder.");
    const linked = supporterNextSteps(ready({ automaticBlockedReason: "steam_on_another_record" }), on);
    expect(linked).toEqual([{ code: "founder_ready_staff", area: "founder", message: "Ready to be made a founder." }]);
    // With a SteamID linked there is no SteamID step, so that message has to stand on its own.
    expect(automaticBlockedMessages.steam_on_another_record).not.toContain("this SteamID");
  });
  it("gives staff a task when a founder with no SteamID applied with this record's SteamID", () => {
    const steps = supporterNextSteps(ready({ founderBlockedReason: "steam_applied_by_founder" }), on);
    expect(steps).toEqual([
      {
        code: "founder_steam_applied_by_founder",
        area: "founder",
        message:
          "A founder with no SteamID linked applied for the whitelist with this SteamID. Link that founder's SteamID first.",
      },
    ]);
  });
  it("tells automatic recording, recording with automation off and staff recording apart", () => {
    expect(supporterNextSteps(ready(), on)).toEqual([
      { code: "founder_ready_automatic", area: "founder", message: "Gramps makes them a founder at the next sync." },
    ]);
    expect(supporterNextSteps(ready(), off)).toEqual([
      { code: "founder_ready_automatic_off", area: "founder", message: "Ready to be made a founder." },
    ]);
    expect(codes(ready({ automaticBlockedReason: "discord_not_from_patreon" }))).toEqual(["founder_ready_staff"]);
    expect(codes(ready({ automaticBlockedReason: "payment_too_recent" }))).toEqual(["founder_automatic_waiting"]);
    const [waiting] = supporterNextSteps(
      ready({ automaticBlockedReason: "payment_too_recent", automaticPayment: paymentFixture() }),
      { ...on, holdHours: 48 },
    );
    expect(waiting.message).toBe("Gramps makes them a founder after the refund wait (2026-10-03 12:00 UTC).");
    expect(
      supporterNextSteps(ready({ automaticBlockedReason: "payment_too_recent", automaticPayment: null }), on)[0]
        .message,
    ).toBe("Gramps makes them a founder after the refund wait.");
    expect(codes(ready({ automaticBlockedReason: "payment_too_recent" }), off)).toEqual(["founder_ready_staff"]);
    const paypal = supporterNextSteps(ready({ provider: "paypal", automaticBlockedReason: "not_patreon" }), on);
    expect(paypal).toEqual([{ code: "founder_ready_staff", area: "founder", message: "Ready to be made a founder." }]);
    // Why the record is not automatic stays on the record itself.
    expect(automaticBlockedMessages.not_patreon).toContain("PayPal founders are always recorded by staff");
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
    // Every sync checks the tier's price again, so Gramps waits for it. The dashboard lists it under Waiting.
    expect(euro.at(-1)).toEqual({
      code: "founder_below_minimum",
      area: "founder",
      message: "Waiting for Patreon to confirm this EUR payment is US$5 or more.",
    });
    // Staff said whether a PayPal payment is worth US$5 or more when they recorded it, so it is a note.
    const paypal = supporterNextSteps(
      ready({
        provider: "paypal",
        founderBlockedReason: "below_minimum",
        latestPayment: paymentFixture({ source: "paypal", currency: "CAD" }),
        founderEligiblePayment: null,
      }),
      on,
    );
    expect(paypal.at(-1)).toEqual({
      code: "founder_below_minimum",
      area: "info",
      message: "This CAD payment is not confirmed as US$5 or more.",
    });
  });
  it("makes a first payment to check in the founder window a task, and leaves any other a note", () => {
    const toCheck = supporterNextSteps(
      ready({ founderBlockedReason: "not_first_payment", founderFirstPaymentToCheck: true }),
      on,
    );
    expect(toCheck.at(-1)).toEqual({
      code: "founder_not_first_payment",
      area: "founder",
      message: "Check if their payment in the founder window was their first, then add it.",
    });
    expect(
      supporterNextSteps(
        ready({ founderBlockedReason: "not_first_payment", founderFirstPaymentToCheck: false }),
        on,
      ).at(-1),
    ).toEqual({ code: "founder_not_first_payment", area: "payment", message: "Not confirmed as their first payment." });
  });
  it("says what a missing account unlocks, leaving the asking to the Discord step", () => {
    const none = {
      discordId: null,
      discordSource: null,
      steamId: null,
      steamSource: null,
      founderBlockedReason: "no_identity" as const,
    };
    for (const provider of ["patreon", "paypal"] as const) {
      const steps = supporterNextSteps(ready({ ...none, provider, match: { ...ready().match, steam: null } }), on);
      expect(steps.at(-1)).toEqual({
        code: "founder_no_identity",
        area: "founder",
        message: "Can be a founder once their Discord is linked.",
      });
      expect(steps[0].area).toBe("discord");
    }
  });
  it("asks for a Discord account for a founder without one", () => {
    const steps = supporterNextSteps(
      ready({
        discordId: null,
        discordSource: null,
        needsDiscordLink: true,
        match: { ...ready().match, steam: null },
        founder: { awardedAt: "2026-10-02T00:00:00Z", paymentId: "p", source: "paypal", automatic: false },
      }),
      on,
    );
    expect(steps.map((step) => step.code)).toEqual(["connect_discord_in_patreon", "founder_needs_discord"]);
    expect(steps[1].message).toBe("Add a Discord account so they get the Founder role.");
  });
  it("words the founder rule's reasons in one short sentence each", () => {
    const message = (founderBlockedReason: SupporterView["founderBlockedReason"]) =>
      supporterNextSteps(ready({ founderBlockedReason }), on).at(-1)!.message;
    expect(message("window_not_configured")).toBe("Founder dates are not set.");
    expect(message("source_not_qualifying")).toBe("Patreon has not confirmed a payment yet.");
    expect(message("not_verified")).toBe("This payment is not confirmed as paid.");
    expect(message("not_first_payment")).toBe("Not confirmed as their first payment.");
    expect(message("earlier_payment")).toBe("They have an earlier payment.");
    expect(message("outside_window")).toBe("Paid outside the founder window.");
    expect(message("below_minimum")).toBe("Paid less than US$5.");
    expect(message("no_identity")).toBe("Add a Discord account first.");
    // A record that is a founder itself never carries a founder reason, so this is always another record.
    expect(message("already_founder")).toBe(
      "Another supporter with this Discord account or SteamID is already a founder.",
    );
    expect(message("no_payment")).toBe("No payment yet.");
  });
});
