import { createHmac, randomUUID } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import type { EnvService } from "../env/env.service";
import { SupportersService } from "./supporters.service";
import type { SupportersStore } from "./supporters.store";
import type { PatreonSyncService } from "./patreon-sync.service";
import { linkSchema, parsePatreon } from "./supporters.types";

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
  };
  const sync = {
    configured: jest.fn().mockReturnValue(true),
    status: jest.fn().mockReturnValue({ configured: true, running: false, members: 2 }),
    staffSync: jest.fn().mockResolvedValue({ joined: false, sync: { configured: true, members: 2 } }),
  };
  return {
    store,
    sync,
    service: new SupportersService(
      store as unknown as SupportersStore,
      { get: (key: string) => values[key] } as EnvService,
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
  it.each(["a".repeat(121), "Hidden\u0000name", {}])("still rejects invalid member names: %p", (full_name) => {
    const { raw, signature } = signed(payload({ full_name }));
    expect(() => parsePatreon(raw, signature, "members:update", secret, campaign)).toThrow("Invalid Patreon member");
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
  });
  it("bounds all-record searches and never treats invalid query shapes as an unfiltered list", async () => {
    const { service, store } = fixture();
    await expect(service.list(admin, "  earlier%_member  ")).resolves.toMatchObject({
      search: "earlier%_member",
      limit: 100,
    });
    expect(store.list).toHaveBeenCalledWith(campaign, expect.any(Object), undefined, "earlier%_member");
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
      "supporters",
      "search",
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
    ]) {
      const { service, store } = fixture(overrides);
      const { raw, signature } = signed();
      await expect(service.webhook(raw, signature, "members:update")).rejects.toMatchObject({ status: 503 });
      expect(store.ingest).not.toHaveBeenCalled();
    }
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
