import { createHmac, randomUUID } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import type { EnvService } from "../env/env.service";
import { SupportersService } from "./supporters.service";
import type { SupportersStore } from "./supporters.store";
import { parsePatreon } from "./supporters.types";

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
  };
  return {
    store,
    service: new SupportersService(
      store as unknown as SupportersStore,
      { get: (key: string) => values[key] } as EnvService,
    ),
  };
}
describe("Patreon signed observations", () => {
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
    expect(store.list).not.toHaveBeenCalled();
    expect(store.mutate).not.toHaveBeenCalled();
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
