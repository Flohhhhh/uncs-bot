import { createHmac, randomUUID } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import type { EnvService } from "../env/env.service";
import type { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { SupportersService } from "./supporters.service";
import type { SupportersStore } from "./supporters.store";
import type { PatreonSyncService } from "./patreon-sync.service";
import {
  founderBlocker,
  linkSchema,
  parsePatreon,
  PAYPAL_SUPPORT_MS,
  SUPPORTER_DECLINE_GRACE_MS,
  supportActive,
  type FounderPolicy,
  type SupportFacts,
} from "./supporters.types";

const secret = "dedicated-patreon-webhook-secret";
const campaign = "123456";
const admin: Staff = { id: "123456789012345678", name: "Admin", role: "admin", csrf: "csrf" };
function payload(attributes: Record<string, unknown> = {}, campaignId = campaign) {
  return {
    data: {
      id: "member-123",
      type: "member",
      attributes: {
        full_name: "Supporter",
        patron_status: "active_patron",
        last_charge_status: "Paid",
        last_charge_date: "2026-09-29T12:00:00Z",
        email: "private@example.test",
        note: "private note",
        currently_entitled_amount_cents: 500,
        ...attributes,
      },
      relationships: {
        campaign: { data: { id: campaignId, type: "campaign" } },
        user: { data: { id: "private-user", type: "user" } },
      },
    },
    included: [{ email: "private@example.test", address: "private address" }],
  };
}
function signed(value = payload()) {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, signature: createHmac("md5", secret).update(raw).digest("hex") };
}
function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    PATREON_ENABLED: true,
    PATREON_CAMPAIGN_ID: campaign,
    PATREON_WEBHOOK_SECRET: secret,
    PATREON_FOUNDER_START_AT: undefined,
    PATREON_FOUNDER_END_AT: undefined,
    ...overrides,
  };
  const store = {
    list: jest.fn().mockResolvedValue([]),
    ingest: jest.fn().mockResolvedValue({ duplicate: false }),
    mutate: jest.fn().mockResolvedValue({ ok: true }),
    register: jest.fn().mockResolvedValue({ ok: true }),
    recordPaypal: jest.fn().mockResolvedValue({ ok: true }),
  };
  const roles = { supporterChanged: jest.fn() };
  const sync = {
    configured: jest.fn().mockReturnValue(true),
    status: jest.fn().mockReturnValue({ configured: true, running: false, members: 2 }),
    staffSync: jest.fn().mockResolvedValue({ joined: false, sync: { configured: true, members: 2 } }),
  };
  return {
    store,
    values,
    roles,
    sync,
    service: new SupportersService(
      store as unknown as SupportersStore,
      { get: (key: string) => values[key] } as EnvService,
      roles as unknown as DiscordRolesService,
      sync as unknown as PatreonSyncService,
    ),
  };
}
describe("Patreon signed observations", () => {
  it.each(["", "   ", null, undefined])(
    "accepts hidden member names without inventing an identity: %p",
    (full_name) => {
      const { raw, signature } = signed(payload({ full_name }));
      expect(parsePatreon(raw, signature, "members:update", secret, campaign).displayName).toBeNull();
    },
  );
  it.each(["a".repeat(121), "Jane\tDoe", "Hidden\u0000name", {}])(
    "drops an unusable member name like the API import and keeps the rest of the observation: %p",
    (full_name) => {
      const { raw, signature } = signed(payload({ full_name }));
      expect(parsePatreon(raw, signature, "members:update", secret, campaign)).toMatchObject({
        patreonMemberId: "member-123",
        displayName: null,
        patronStatus: "active_patron",
        lastChargeStatus: "Paid",
        lastChargeAt: new Date("2026-09-29T12:00:00Z"),
      });
    },
  );
  it.each([
    ["  Jane Doe  ", "Jane Doe"],
    ["a".repeat(120), "a".repeat(120)],
  ])("trims usable member names like the API import: %p", (full_name, expected) => {
    const { raw, signature } = signed(payload({ full_name }));
    expect(parsePatreon(raw, signature, "members:update", secret, campaign).displayName).toBe(expected);
  });
  it("verifies original bytes and persists only the selected private ledger fields", () => {
    const { raw, signature } = signed();
    const observation = parsePatreon(raw, signature, "members:update", secret, campaign);
    expect(observation).toMatchObject({
      patreonMemberId: "member-123",
      campaignId: campaign,
      lastChargeStatus: "Paid",
      lastChargeAt: new Date("2026-09-29T12:00:00Z"),
    });
    expect(JSON.stringify(observation)).not.toMatch(/private|email|address|entitled|user|note/);
    expect(() =>
      parsePatreon(Buffer.from(raw.toString() + " "), signature, "members:update", secret, campaign),
    ).toThrow("Invalid Patreon signature");
  });
  it("deduplicates the signed body independently of the unsigned event header", () => {
    const { raw, signature } = signed();
    const first = parsePatreon(raw, signature, "members:update", secret, campaign);
    const swapped = parsePatreon(raw, signature, "members:delete", secret, campaign);
    expect(swapped.hash).toBe(first.hash);
    expect(swapped.patronStatus).toBe("active_patron");
  });
  it.each([undefined, "", "f".repeat(31), "z".repeat(32), "0".repeat(32), "0".repeat(32) + "\n"])(
    "rejects malformed or false signatures",
    (signature) => {
      expect(() => parsePatreon(signed().raw, signature, "members:update", secret, campaign)).toThrow();
    },
  );
  it("rejects cross-campaign payloads, deprecated triggers, oversized and missing original bodies", () => {
    const other = signed(payload({}, "777"));
    expect(() => parsePatreon(other.raw, other.signature, "members:update", secret, campaign)).toThrow(
      "Unexpected Patreon campaign",
    );
    const { raw, signature } = signed();
    expect(() => parsePatreon(raw, signature, "pledges:create", secret, campaign)).toThrow("Unsupported");
    expect(() => parsePatreon(payload(), signature, "members:update", secret, campaign)).toThrow(
      "original webhook body",
    );
    expect(() => parsePatreon(Buffer.alloc(65537), signature, "members:update", secret, campaign)).toThrow("bounded");
  });
  it("does not turn active membership or entitlement amount into a completed payment", () => {
    const { raw, signature } = signed(payload({ last_charge_date: null, last_charge_status: null }));
    expect(parsePatreon(raw, signature, "members:create", secret, campaign)).toMatchObject({
      patronStatus: "active_patron",
      lastChargeStatus: null,
      lastChargeAt: null,
    });
  });
});
describe("supporter reviews", () => {
  it("accepts the full public player SteamID range and rejects structurally invalid account IDs", () => {
    const input = {
      id: randomUUID(),
      version: 1,
      confirm: "member-123",
      discordId: "123456789012345678",
      reason: "Checked account identity",
    };
    for (const steamId of ["76561197960265729", "76561202255233023"])
      expect(linkSchema.safeParse({ ...input, steamId }).success).toBe(true);
    for (const steamId of ["76561190000000001", "76561197960265728", "76561202255233024"])
      expect(linkSchema.safeParse({ ...input, steamId }).success).toBe(false);
    // Either identity may be linked alone; at least one is required.
    expect(linkSchema.safeParse(input).success).toBe(true);
    expect(linkSchema.safeParse({ ...input, discordId: undefined, steamId: "76561197960265729" }).success).toBe(true);
    expect(linkSchema.safeParse({ ...input, discordId: undefined }).success).toBe(false);
  });
  it("bounds all-record searches and never treats invalid query shapes as an unfiltered list", async () => {
    const { service, store } = fixture();
    await expect(service.list(admin, "  earlier%_member  ")).resolves.toMatchObject({
      search: "earlier%_member",
      limit: 100,
    });
    expect(store.list).toHaveBeenCalledWith(campaign, expect.any(Object), undefined, "earlier%_member", undefined);
    store.list.mockClear();
    for (const query of ["x".repeat(101), ["one", "two"], {}, null])
      await expect(service.list(admin, query)).rejects.toMatchObject({ status: 400 });
    expect(store.list).not.toHaveBeenCalled();
  });
  it("adds the Patreon sync status to the private list without changing existing fields", async () => {
    const { service } = fixture();
    const result = await service.list(admin);
    expect(Object.keys(result)).toEqual([
      "enabled",
      "configured",
      "webhookConfigured",
      "founderPolicy",
      "paypal",
      "supporters",
      "search",
      "provider",
      "limit",
      "sync",
      "note",
    ]);
    expect(result.sync).toEqual({ configured: true, running: false, members: 2 });
  });
  it("lets only administrators start a configured Patreon sync", async () => {
    const { service, sync } = fixture();
    await expect(service.syncNow(admin)).resolves.toEqual({
      ok: true,
      joined: false,
      sync: { configured: true, members: 2 },
    });
    for (const role of ["viewer", "moderator"] as const)
      await expect(service.syncNow({ ...admin, role })).rejects.toMatchObject({ status: 403 });
    sync.configured.mockReturnValue(false);
    await expect(service.syncNow(admin)).rejects.toMatchObject({ status: 503 });
    expect(sync.staffSync).toHaveBeenCalledTimes(1);
  });
  it("allows audited manual tracking before webhook setup without enabling webhook ingestion", async () => {
    const { service, store } = fixture({ PATREON_WEBHOOK_SECRET: undefined });
    const input = {
      id: randomUUID(),
      patreonMemberId: "membership-123",
      campaignMembershipVerified: true,
      reason: "Checked this campaign in Patreon",
    };
    await expect(service.register(admin, input)).resolves.toEqual({ ok: true });
    expect(store.register).toHaveBeenCalledWith({ ...input, displayName: null }, admin, campaign, expect.any(Object));
    await expect(service.list(admin)).resolves.toMatchObject({ configured: true, webhookConfigured: false });
    await expect(service.webhook(undefined, undefined, undefined)).rejects.toMatchObject({ status: 503 });
    expect(store.ingest).not.toHaveBeenCalled();
  });
  it("rejects unconfirmed membership entry, imported benefit claims and disabled ledger writes", async () => {
    const { service, store } = fixture();
    const input = { id: randomUUID(), patreonMemberId: "membership-123", reason: "Checked Patreon membership" };
    await expect(service.register(admin, input)).rejects.toMatchObject({ status: 400 });
    await expect(
      service.register(admin, { ...input, campaignMembershipVerified: true, paid: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.register(admin, {
        ...input,
        campaignMembershipVerified: true,
        patreonMemberId: "https://patreon.com/member",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      fixture({ PATREON_ENABLED: false }).service.register(admin, { ...input, campaignMembershipVerified: true }),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.register).not.toHaveBeenCalled();
  });
  it("fails closed when disabled or reusing another server secret", async () => {
    for (const overrides of [
      { PATREON_ENABLED: false },
      { WARDOGS_RCON_PASSWORD: secret },
      { WARDOGS_FEED_TOKEN: secret },
      { ADMIN_SESSION_SECRET: secret },
      { WARDOGS_SERVERS: [{ id: "event", password: "other-password", feedToken: secret }] },
      { DISCORD_BOT_TOKEN: secret },
      { ADMIN_DISCORD_CLIENT_SECRET: secret },
      { DATABASE_URL: secret },
    ]) {
      const { service, store } = fixture(overrides);
      const { raw, signature } = signed();
      await expect(service.webhook(raw, signature, "members:update")).rejects.toMatchObject({ status: 503 });
      expect(store.ingest).not.toHaveBeenCalled();
    }
  });
  it("refuses a webhook secret that is the creator token, as the setup guide promises", async () => {
    const { service, store } = fixture({ PATREON_CREATOR_ACCESS_TOKEN: secret });
    const { raw, signature } = signed();
    await expect(service.list(admin)).resolves.toMatchObject({ webhookConfigured: false });
    await expect(service.webhook(raw, signature, "members:update")).rejects.toMatchObject({ status: 503 });
    expect(service.signedWebhook(raw, signature)).toBe(false);
    expect(store.ingest).not.toHaveBeenCalled();
  });
  it.each(["viewer", "moderator"] as const)("denies %s private records and all mutations", async (role) => {
    const { service, store } = fixture();
    await expect(service.list({ ...admin, role })).rejects.toMatchObject({ status: 403 });
    await expect(service.mutate({ ...admin, role }, randomUUID(), "link", {})).rejects.toMatchObject({ status: 403 });
    await expect(service.register({ ...admin, role }, {})).rejects.toMatchObject({ status: 403 });
    expect(store.list).not.toHaveBeenCalled();
    expect(store.mutate).not.toHaveBeenCalled();
    expect(store.register).not.toHaveBeenCalled();
  });
  it("leaves the founder launch window unset and rejects assumed or non-15-day windows", async () => {
    const { service, store } = fixture();
    expect(service.policy()).toMatchObject({
      configured: false,
      startsAt: null,
      endsAt: null,
      amountCents: 500,
      currency: "USD",
    });
    await expect(
      service.mutate(admin, randomUUID(), "founder", {
        id: randomUUID(),
        version: 1,
        confirm: "member-123",
        reason: "Checked receipt",
        paymentId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.mutate).not.toHaveBeenCalled();
    expect(
      fixture({
        PATREON_FOUNDER_START_AT: "2026-10-01T00:00:00Z",
        PATREON_FOUNDER_END_AT: "2026-10-17T00:00:00Z",
      }).service.policy().configured,
    ).toBe(false);
  });
  it("requires a completed receipt attestation and does not assume it was the first payment", async () => {
    const { service, store } = fixture();
    const input = {
      id: randomUUID(),
      version: 1,
      confirm: "member-123",
      reason: "Checked Patreon receipt",
      paidAt: "2026-09-29T12:00:00Z",
      amountCents: 500,
      currency: "USD",
      reference: "Receipt-123",
    };
    await expect(service.mutate(admin, randomUUID(), "payment", input)).rejects.toMatchObject({ status: 400 });
    await service.mutate(admin, randomUUID(), "payment", { ...input, completedPaymentVerified: true });
    expect(store.mutate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: "payment",
        firstSuccessfulPaymentVerified: false,
        paidAt: new Date(input.paidAt),
      }),
      admin,
      campaign,
      expect.any(Object),
    );
    await expect(
      service.mutate(admin, randomUUID(), "payment", {
        ...input,
        completedPaymentVerified: true,
        paidAt: "2099-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.mutate(admin, randomUUID(), "payment", { ...input, completedPaymentVerified: true, role: "admin" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
describe("provider-neutral founder window", () => {
  const start = "2026-09-30T00:00:00-04:00",
    end = "2026-10-15T00:00:00-04:00";
  it("uses a complete SUPPORTER_FOUNDER pair, or a complete PATREON_FOUNDER pair when it is the only one", () => {
    expect(
      fixture({ SUPPORTER_FOUNDER_START_AT: start, SUPPORTER_FOUNDER_END_AT: end }).service.policy(),
    ).toMatchObject({
      configured: true,
      source: "SUPPORTER_FOUNDER",
      startsAt: "2026-09-30T04:00:00.000Z",
      endsAt: "2026-10-15T04:00:00.000Z",
    });
    expect(fixture({ PATREON_FOUNDER_START_AT: start, PATREON_FOUNDER_END_AT: end }).service.policy()).toMatchObject({
      configured: true,
      source: "PATREON_FOUNDER",
    });
    // Two complete pairs naming the same instants in different offsets are the same window.
    expect(
      fixture({
        SUPPORTER_FOUNDER_START_AT: "2026-09-30T04:00:00Z",
        SUPPORTER_FOUNDER_END_AT: "2026-10-15T04:00:00Z",
        PATREON_FOUNDER_START_AT: start,
        PATREON_FOUNDER_END_AT: end,
      }).service.policy(),
    ).toMatchObject({ configured: true, source: "SUPPORTER_FOUNDER" });
  });
  it.each([
    [
      "a half-set supporter pair",
      { SUPPORTER_FOUNDER_START_AT: start, PATREON_FOUNDER_START_AT: start, PATREON_FOUNDER_END_AT: end },
    ],
    [
      "a half-set Patreon pair",
      { SUPPORTER_FOUNDER_START_AT: start, SUPPORTER_FOUNDER_END_AT: end, PATREON_FOUNDER_END_AT: end },
    ],
    [
      "two pairs naming different windows",
      {
        SUPPORTER_FOUNDER_START_AT: start,
        SUPPORTER_FOUNDER_END_AT: end,
        PATREON_FOUNDER_START_AT: "2026-10-01T00:00:00-04:00",
        PATREON_FOUNDER_END_AT: "2026-10-16T00:00:00-04:00",
      },
    ],
    [
      "an inclusive 23:59:59 end",
      { SUPPORTER_FOUNDER_START_AT: start, SUPPORTER_FOUNDER_END_AT: "2026-10-14T23:59:59-04:00" },
    ],
  ])("leaves the window unconfigured for %s", (_label, overrides) => {
    expect(fixture(overrides).service.policy()).toMatchObject({ configured: false, source: null, startsAt: null });
  });
  const policy: FounderPolicy = {
    configured: true,
    amountCents: 500,
    currency: "USD",
    startsAt: "2026-09-30T04:00:00.000Z",
    endsAt: "2026-10-15T04:00:00.000Z",
    source: "SUPPORTER_FOUNDER",
  };
  const payment = {
    source: "paypal",
    verificationState: "verified",
    firstSuccessfulPaymentVerified: true,
    paidAt: "2026-09-30T04:00:00.000Z",
    amountCents: 500,
    currency: "USD",
    minimumConfirmed: false,
  };
  const context = { earlierPayment: false, hasIdentity: true, otherFounder: false };
  it.each([
    [{}, {}, null],
    [{ paidAt: "2026-10-15T03:59:59.999Z" }, {}, null],
    [{ paidAt: "2026-10-15T04:00:00.000Z" }, {}, "outside_window"],
    [{ paidAt: "2026-09-30T03:59:59.999Z" }, {}, "outside_window"],
    [{ source: "signed_status" }, {}, "source_not_qualifying"],
    [{ source: "patreon_api" }, {}, null],
    [{ source: "manual_receipt" }, {}, null],
    [{ amountCents: 499 }, {}, "below_minimum"],
    [{ currency: "GBP", amountCents: 400 }, {}, "below_minimum"],
    [{ currency: "GBP", amountCents: 400, minimumConfirmed: true }, {}, null],
    [{ amountCents: null, currency: null, minimumConfirmed: true }, {}, "below_minimum"],
    [{ verificationState: "unverified" }, {}, "not_verified"],
    [{ firstSuccessfulPaymentVerified: false }, {}, "not_first_payment"],
    [{}, { earlierPayment: true }, "earlier_payment"],
    [{}, { hasIdentity: false }, "no_identity"],
    [{}, { otherFounder: true }, "already_founder"],
  ])("applies one founder rule to every provider: %p %p", (change, contextChange, reason) => {
    expect(founderBlocker({ ...payment, ...change }, policy, { ...context, ...contextChange })).toBe(reason);
  });
  it("reports an unconfigured window before any payment detail", () => {
    expect(founderBlocker({ ...payment, source: "signed_status" }, { ...policy, configured: false }, context)).toBe(
      "window_not_configured",
    );
  });
});
describe("PayPal supporter records", () => {
  const body = {
    id: randomUUID(),
    displayName: "PayPal donor",
    discordId: "123456789012345678",
    paidAt: "2026-10-01T12:00:00-04:00",
    amountCents: 1000,
    currency: "USD",
    transactionId: "8ab12345cd678901e",
    completedPaymentVerified: true,
    firstSuccessfulPaymentVerified: true,
    awardFounder: true,
    reason: "Checked the completed PayPal payment",
  };
  it("lists PayPal records and accepts PayPal entries while Patreon is not configured", async () => {
    const { service, store } = fixture({ PATREON_ENABLED: false, PATREON_CAMPAIGN_ID: undefined });
    store.list.mockResolvedValue([{ id: "paypal-record" }]);
    await expect(service.list(admin)).resolves.toMatchObject({
      configured: false,
      paypal: { available: true },
      supporters: [{ id: "paypal-record" }],
    });
    expect(store.list).toHaveBeenCalledWith(null, expect.any(Object), undefined, "", undefined);
    await service.list(admin, "", "paypal");
    expect(store.list).toHaveBeenLastCalledWith(null, expect.any(Object), undefined, "", "paypal");
    await expect(service.list(admin, "", "stripe")).rejects.toMatchObject({ status: 400 });
    await expect(service.paypal(admin, body)).resolves.toEqual({ ok: true });
    expect(store.recordPaypal).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "8AB12345CD678901E",
        paidAt: new Date(body.paidAt),
        minimumConfirmed: false,
        awardFounder: true,
      }),
      admin,
      null,
      expect.objectContaining({ amountCents: 500 }),
    );
    // A Patreon-only action still needs the Patreon connection.
    await service.mutate(admin, randomUUID(), "review", { id: randomUUID(), version: 1, confirm: "a", reason: "Okay" });
    expect(store.mutate).toHaveBeenCalledWith(expect.any(String), expect.anything(), admin, null, expect.any(Object));
  });
  it.each([
    ["no completed-payment check", { completedPaymentVerified: undefined }],
    ["a record ID without its version", { memberId: randomUUID() }],
    ["a version without a record ID", { version: 1 }],
    ["a malformed transaction ID", { transactionId: "abc-123" }],
    ["a short transaction ID", { transactionId: "ABC123" }],
    ["a lowercase currency", { currency: "usd" }],
    ["a payer email", { email: "donor@example.test" }],
    ["an invalid SteamID", { steamId: "76561190000000001" }],
    ["no display name", { displayName: " " }],
    ["a zero amount", { amountCents: 0 }],
  ])("rejects a PayPal entry with %s", async (_label, change) => {
    const { service, store } = fixture();
    await expect(service.paypal(admin, { ...body, ...change })).rejects.toMatchObject({ status: 400 });
    expect(store.recordPaypal).not.toHaveBeenCalled();
  });
  it("rejects future payments and non-admin staff before recording anything", async () => {
    const { service, store } = fixture();
    await expect(service.paypal(admin, { ...body, paidAt: "2099-01-01T00:00:00Z" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.paypal({ ...admin, role: "moderator" }, body)).rejects.toMatchObject({ status: 403 });
    expect(store.recordPaypal).not.toHaveBeenCalled();
  });
  it("translates a concurrent duplicate into a conflict", async () => {
    const { service, store } = fixture();
    store.recordPaypal.mockRejectedValueOnce({ message: "duplicate", cause: { code: "23505" } });
    await expect(service.paypal(admin, body)).rejects.toMatchObject({ status: 409 });
  });
});
describe("who supports right now, for the Supporter role", () => {
  const day = 86_400_000;
  const chargedAt = Date.parse("2026-11-01T12:00:00Z");
  const paid = (overrides: Partial<SupportFacts["payments"][number]> = {}) => ({
    source: "patreon_api",
    paidAt: "2026-11-01T12:00:00+00:00",
    amountCents: 500,
    currency: "USD",
    minimumConfirmed: false,
    ...overrides,
  });
  const patron = (overrides: Partial<SupportFacts> = {}): SupportFacts => ({
    provider: "patreon",
    patronStatus: "active_patron",
    lastChargeStatus: "Paid",
    lastChargeAt: "2026-11-01T12:00:00+00:00",
    payments: [paid()],
    ...overrides,
  });
  const paypal = (...payments: SupportFacts["payments"]): SupportFacts => ({
    provider: "paypal",
    patronStatus: null,
    lastChargeStatus: null,
    lastChargeAt: null,
    payments,
  });
  const now = chargedAt + day;

  it.each<[string, SupportFacts, boolean]>([
    ["an active patron on the US$5 tier", patron(), true],
    ["an active patron on a higher tier", patron({ payments: [paid({ amountCents: 2000 })] }), true],
    [
      "an active patron paying another currency confirmed by staff",
      patron({ payments: [paid({ currency: "EUR", minimumConfirmed: true })] }),
      true,
    ],
    ["an active patron whose charge is still pending", patron({ lastChargeStatus: "Pending" }), true],
    // Patreon enforces the tier price, so neither the amount nor the currency is checked again.
    ["an active patron on a lower tier", patron({ payments: [paid({ amountCents: 300 }), paid()] }), true],
    [
      "an active patron charged in another currency, as Patreon imports it",
      patron({ payments: [paid({ currency: "GBP", amountCents: 400 })] }),
      true,
    ],
    [
      "an active patron whose imported charge in another currency follows a staff receipt in USD",
      patron({ payments: [paid({ currency: "GBP", amountCents: 400 }), paid({ source: "manual_receipt" })] }),
      true,
    ],
    ["an active patron with no verified payment", patron({ payments: [] }), false],
    ["a refunded latest charge", patron({ lastChargeStatus: "Refunded" }), false],
    ["a partially refunded latest charge", patron({ lastChargeStatus: "Partially Refunded" }), false],
    ["a fraudulent latest charge", patron({ lastChargeStatus: "Fraud" }), false],
    ["a latest charge Patreon reports as Other", patron({ lastChargeStatus: "Other" }), false],
    ["a latest charge with a refund pending", patron({ lastChargeStatus: "Refund Pending" }), false],
    // A declined refund leaves the charge standing.
    ["a latest charge whose refund Patreon declined", patron({ lastChargeStatus: "Refund Declined" }), true],
    ["a former patron", patron({ patronStatus: "former_patron" }), false],
    ["a follower who never paid", patron({ patronStatus: null, lastChargeStatus: null, payments: [] }), false],
    ["a declined patron with no charge date", patron({ patronStatus: "declined_patron", lastChargeAt: null }), false],
    ["a PayPal payment of US$5", paypal(paid({ source: "paypal" })), true],
    ["a PayPal payment below US$5", paypal(paid({ source: "paypal", amountCents: 499 })), false],
    [
      "a non-USD PayPal payment staff confirmed",
      paypal(paid({ source: "paypal", currency: "CAD", amountCents: 700, minimumConfirmed: true })),
      true,
    ],
    [
      "a small PayPal gift after a qualifying one",
      paypal(paid({ source: "paypal", amountCents: 100 }), paid({ source: "paypal" })),
      true,
    ],
  ])("%s", (_label, record, expected) => {
    expect(supportActive(record, now)).toBe(expected);
  });

  it("keeps a declined patron for 7 days after the declined charge while Patreon retries", () => {
    const declined = patron({ patronStatus: "declined_patron", lastChargeStatus: "Declined" });
    expect(supportActive(declined, chargedAt + SUPPORTER_DECLINE_GRACE_MS - 1)).toBe(true);
    expect(supportActive(declined, new Date(chargedAt + SUPPORTER_DECLINE_GRACE_MS))).toBe(false);
    // A reversed charge ends support at once, grace or not.
    expect(supportActive({ ...declined, lastChargeStatus: "Refunded" }, chargedAt + 1)).toBe(false);
  });

  it("counts a PayPal payment for 31 days after it was paid", () => {
    const record = paypal(paid({ source: "paypal", paidAt: new Date(chargedAt) }));
    expect(supportActive(record, chargedAt + PAYPAL_SUPPORT_MS - 1)).toBe(true);
    expect(supportActive(record, chargedAt + PAYPAL_SUPPORT_MS)).toBe(false);
  });

  it("keeps an active patron on an annual or long-standing pledge", () => {
    expect(supportActive(patron(), chargedAt + 364 * day)).toBe(true);
  });
});

describe("Supporter role notifications", () => {
  it("asks for a role check after a new signed observation and a staff receipt, never on a duplicate", async () => {
    const { service, store, roles } = fixture();
    const { raw, signature } = signed();
    store.ingest.mockResolvedValueOnce({ duplicate: false, discordId: "123456789012345678" });
    // The response never carries the supporter's Discord ID back to Patreon.
    await expect(service.webhook(raw, signature, "members:update")).resolves.toEqual({ ok: true, duplicate: false });
    expect(roles.supporterChanged).toHaveBeenCalledWith("123456789012345678");
    store.ingest.mockResolvedValueOnce({ duplicate: true });
    await expect(service.webhook(raw, signature, "members:update")).resolves.toEqual({ ok: true, duplicate: true });
    expect(roles.supporterChanged).toHaveBeenCalledTimes(1);
    store.mutate.mockResolvedValueOnce({ ok: true, replayed: false, supporter: { discordId: "123456789012345678" } });
    await service.mutate(admin, randomUUID(), "payment", {
      id: randomUUID(),
      version: 1,
      confirm: "member-123",
      reason: "Checked Patreon receipt",
      paidAt: "2026-09-29T12:00:00Z",
      amountCents: 500,
      currency: "USD",
      reference: "Receipt-123",
      completedPaymentVerified: true,
    });
    expect(roles.supporterChanged).toHaveBeenCalledTimes(2);
  });
});

describe("Founder role notifications", () => {
  const supporter = { discordId: "123456789012345678" };
  const review = { id: randomUUID(), version: 1, confirm: "member-123", reason: "Checked" };
  const founder = { ...review, paymentId: randomUUID() };
  it("asks for a role check after a founder award, a Discord link or a new PayPal record, never on a replay", async () => {
    const { service, store, roles } = fixture({
      PATREON_FOUNDER_START_AT: "2026-09-30T00:00:00-04:00",
      PATREON_FOUNDER_END_AT: "2026-10-15T00:00:00-04:00",
    });
    store.mutate.mockResolvedValue({ ok: true, replayed: false, supporter });
    await service.mutate(admin, randomUUID(), "founder", founder);
    await service.mutate(admin, randomUUID(), "link", { ...review, discordId: supporter.discordId });
    await service.mutate(admin, randomUUID(), "review", review);
    expect(roles.supporterChanged.mock.calls).toEqual([[supporter.discordId], [supporter.discordId]]);
    store.mutate.mockResolvedValue({ ok: true, replayed: true, supporter });
    await service.mutate(admin, randomUUID(), "founder", founder);
    expect(roles.supporterChanged).toHaveBeenCalledTimes(2);
    store.recordPaypal.mockResolvedValue({ ok: true, replayed: false, supporter });
    await service.paypal(admin, {
      id: randomUUID(),
      displayName: "PayPal donor",
      discordId: supporter.discordId,
      paidAt: "2026-10-01T12:00:00-04:00",
      amountCents: 500,
      currency: "USD",
      transactionId: "8AB12345CD678901E",
      completedPaymentVerified: true,
      firstSuccessfulPaymentVerified: true,
      reason: "Checked the completed PayPal payment",
    });
    expect(roles.supporterChanged).toHaveBeenCalledTimes(3);
  });
  it("never fails a supporter request because the role service throws", async () => {
    const { service, store, roles } = fixture({
      PATREON_FOUNDER_START_AT: "2026-09-30T00:00:00-04:00",
      PATREON_FOUNDER_END_AT: "2026-10-15T00:00:00-04:00",
    });
    store.mutate.mockResolvedValue({ ok: true, replayed: false, supporter });
    roles.supporterChanged.mockImplementation(() => {
      throw new Error("Role service unavailable");
    });
    await expect(service.mutate(admin, randomUUID(), "founder", founder)).resolves.toMatchObject({ ok: true });
  });
});
