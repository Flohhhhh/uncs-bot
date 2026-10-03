import { Env } from "../env/env";
import type { EnvService } from "../env/env.service";
import { founderPolicy, patreonCampaign } from "./founder-policy";

const env = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as unknown as EnvService;
const start = "2026-09-30T00:00:00-04:00",
  end = "2026-10-15T00:00:00-04:00";

describe("shared founder window and campaign", () => {
  it("reads the founder window without a service, so automatic matching applies the staff window", () => {
    expect(founderPolicy(env({ SUPPORTER_FOUNDER_START_AT: start, SUPPORTER_FOUNDER_END_AT: end }))).toEqual({
      amountCents: 500,
      currency: "USD",
      startsAt: "2026-09-30T04:00:00.000Z",
      endsAt: "2026-10-15T04:00:00.000Z",
      configured: true,
      source: "SUPPORTER_FOUNDER",
      automaticHoldHours: 72,
    });
    expect(founderPolicy(env({ SUPPORTER_FOUNDER_START_AT: start })).configured).toBe(false);
    expect(founderPolicy(env({ SUPPORTER_AUTO_FOUNDER_HOLD_HOURS: 0 })).automaticHoldHours).toBe(0);
  });
  it("keeps the 72-hour refund wait for a blank hold setting instead of switching it off", () => {
    const hold = Env.shape.SUPPORTER_AUTO_FOUNDER_HOLD_HOURS;
    for (const blank of [undefined, "", "   "]) expect(hold.parse(blank)).toBe(72);
    expect(hold.parse("0")).toBe(0);
    expect(hold.parse("24")).toBe(24);
    expect(hold.parse("720")).toBe(720);
    for (const invalid of ["-1", "721", "1.5", "soon"]) expect(hold.safeParse(invalid).success).toBe(false);
    expect(founderPolicy(env({ SUPPORTER_AUTO_FOUNDER_HOLD_HOURS: hold.parse("") })).automaticHoldHours).toBe(72);
  });
  it("names the Patreon campaign only while Patreon is switched on", () => {
    expect(patreonCampaign(env({ PATREON_ENABLED: true, PATREON_CAMPAIGN_ID: "123" }))).toBe("123");
    expect(patreonCampaign(env({ PATREON_ENABLED: false, PATREON_CAMPAIGN_ID: "123" }))).toBeNull();
    expect(patreonCampaign(env({ PATREON_ENABLED: true }))).toBeNull();
  });
});
