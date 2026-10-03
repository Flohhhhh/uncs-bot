import { Env } from "../env/env";

describe("seeding settings", () => {
  it("are off by default with a two-hour ping cooldown and no role or channel", () => {
    expect(Env.shape.SEEDING_ENABLED.parse(undefined)).toBe(false);
    expect(Env.shape.SEEDING_PING_COOLDOWN_MINUTES.parse(undefined)).toBe(120);
    expect(Env.shape.SEEDING_ROLE_ID.parse(undefined)).toBeUndefined();
    expect(Env.shape.SEEDING_PING_CHANNEL_ID.parse(undefined)).toBeUndefined();
  });

  it("turn on only for the exact value true", () => {
    expect(Env.shape.SEEDING_ENABLED.parse("true")).toBe(true);
    expect(Env.shape.SEEDING_ENABLED.parse("false")).toBe(false);
    expect(Env.shape.SEEDING_ENABLED.safeParse("TRUE").success).toBe(false);
    expect(Env.shape.SEEDING_ENABLED.safeParse("1").success).toBe(false);
  });

  it("keep the cooldown between 15 minutes and one day, in whole minutes", () => {
    const cooldown = Env.shape.SEEDING_PING_COOLDOWN_MINUTES;
    expect(cooldown.parse("15")).toBe(15);
    expect(cooldown.parse("1440")).toBe(1440);
    for (const value of ["14", "1441", "0", "-5", "90.5", "soon"])
      expect(cooldown.safeParse(value).success).toBe(false);
  });

  it("accept only Discord numeric IDs for the role and channel", () => {
    expect(Env.shape.SEEDING_ROLE_ID.parse("123456789012345678")).toBe("123456789012345678");
    expect(Env.shape.SEEDING_PING_CHANNEL_ID.parse("123456789012345678")).toBe("123456789012345678");
    for (const value of ["<@&123456789012345678>", "Seeder", "1234"]) {
      expect(Env.shape.SEEDING_ROLE_ID.safeParse(value).success).toBe(false);
      expect(Env.shape.SEEDING_PING_CHANNEL_ID.safeParse(value).success).toBe(false);
    }
  });
});
