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
    });
    expect(founderPolicy(env({ SUPPORTER_FOUNDER_START_AT: start })).configured).toBe(false);
  });
  it("names the Patreon campaign only while Patreon is switched on", () => {
    expect(patreonCampaign(env({ PATREON_ENABLED: true, PATREON_CAMPAIGN_ID: "123" }))).toBe("123");
    expect(patreonCampaign(env({ PATREON_ENABLED: false, PATREON_CAMPAIGN_ID: "123" }))).toBeNull();
    expect(patreonCampaign(env({ PATREON_ENABLED: true }))).toBeNull();
  });
});
