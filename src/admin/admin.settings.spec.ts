import { AdminSettings } from "./admin.settings";
import type { EnvService } from "../env/env.service";

function settings(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    ADMIN_ENABLED: true,
    ADMIN_ORIGIN: "https://theuncs.example",
    APPLICATION_ORIGIN: "https://public.theuncs.example",
    WHITELIST_APPLICATIONS_ENABLED: true,
    ADMIN_DISCORD_CLIENT_ID: "123456789012345678",
    ADMIN_DISCORD_CLIENT_SECRET: "client-secret",
    ADMIN_SESSION_SECRET: "a".repeat(40),
    ADMIN_GUILD_ID: "82988952587337728",
    WARDOGS_RCON_URL: "https://rcon.example",
    WARDOGS_RCON_PASSWORD: "rcon-secret",
    DISCORD_BOT_TOKEN: "bot-secret",
    NEST_ENV: "production",
    ADMIN_OWNER_IDS: "",
    ADMIN_ADMIN_ROLE_IDS: "",
    ADMIN_MODERATOR_ROLE_IDS: "",
    ADMIN_VIEWER_ROLE_IDS: "",
    ...overrides,
  };
  return new AdminSettings({ get: (key: string) => values[key] } as unknown as EnvService);
}

describe("dashboard settings boundary", () => {
  it("adds the optional primary public join code without changing action connection versions", () => {
    const plain = settings().servers()[0];
    expect(plain).not.toHaveProperty("joinId");
    const joinId = "11111111-1111-4111-8111-111111111111";
    expect(settings({ WARDOGS_SERVER_JOIN_ID: joinId }).servers()[0]).toEqual({ ...plain, joinId });
  });
  it("keeps staff access disabled without its flag or Discord credentials", () => {
    expect(() => settings({ ADMIN_ENABLED: false }).get()).toThrow("not been connected");
    expect(() => settings({ ADMIN_DISCORD_CLIENT_SECRET: undefined }).get()).toThrow("not been connected");
  });
  it("allows staff records and public applications without a game connection", () => {
    const config = settings({ WARDOGS_RCON_URL: undefined, WARDOGS_RCON_PASSWORD: undefined });
    expect(config.get().origin).toBe("https://theuncs.example");
    expect(config.applicant().origin).toBe("https://public.theuncs.example");
    expect(() => config.rcon()).toThrow("not been connected");
  });
  it("keeps public sign-in independent of staff access and requires its own origin", () => {
    expect(settings({ ADMIN_ENABLED: false, ADMIN_ORIGIN: undefined }).applicant().origin).toBe(
      "https://public.theuncs.example",
    );
    expect(() => settings({ WHITELIST_APPLICATIONS_ENABLED: false }).applicant()).toThrow("not open yet");
    expect(() => settings({ APPLICATION_ORIGIN: undefined }).applicant()).toThrow("not been connected");
    expect(() => settings({ APPLICATION_ORIGIN: "https://public.theuncs.example/path" }).applicant()).toThrow(
      "need attention",
    );
    expect(() => settings({ APPLICATION_ORIGIN: "http://public.theuncs.example" }).applicant()).toThrow(
      "need attention",
    );
  });
  it("does not require website login settings for the separately enabled community worker's game client", () => {
    const config = settings({ ADMIN_ENABLED: false, ADMIN_ORIGIN: undefined, ADMIN_DISCORD_CLIENT_SECRET: undefined });
    expect(config.rcon()).toEqual({ rconUrl: "https://rcon.example", password: "rcon-secret" });
  });
  it.each([
    "http://theuncs.example",
    "https://theuncs.example/admin",
    "https://theuncs.example/",
    "https://user:secret@theuncs.example",
  ])("requires an exact secure website origin: %s", (origin) => {
    expect(() => settings({ ADMIN_ORIGIN: origin }).get()).toThrow("need attention");
  });
  it("permits local HTTP only in development", () => {
    expect(settings({ ADMIN_ORIGIN: "http://127.0.0.1:4317", NEST_ENV: "development" }).get().secure).toBe(false);
    expect(() => settings({ ADMIN_ORIGIN: "http://127.0.0.1:4317" }).get()).toThrow("need attention");
    expect(() => settings({ ADMIN_ORIGIN: "http://127.0.0.1:4317", NEST_ENV: "staging" }).get()).toThrow(
      "need attention",
    );
    expect(() => settings({ ADMIN_ORIGIN: "ftp://localhost", NEST_ENV: "development" }).get()).toThrow(
      "need attention",
    );
  });
  it.each([
    "file:///secret",
    "https://user:secret@rcon.example",
    "https://rcon.example?target=evil",
    "https://rcon.example#secret",
  ])("rejects credential-bearing or non-HTTP RCON endpoints: %s", (url) =>
    expect(() => settings({ WARDOGS_RCON_URL: url }).rcon()).toThrow("need attention"),
  );
  it("uses only explicit IDs without implicitly granting Discord administrators access", () => {
    expect(settings().get()).toMatchObject({ ownerIds: [], adminRoleIds: [], moderatorRoleIds: [], viewerRoleIds: [] });
  });
  it("reads the staff IDs for Discord staff commands while the dashboard is off", () => {
    const config = settings({
      ADMIN_ENABLED: false,
      ADMIN_OWNER_IDS: " 100000000000000001 ,",
      ADMIN_ADMIN_ROLE_IDS: "200000000000000001",
      ADMIN_MODERATOR_ROLE_IDS: "200000000000000002,200000000000000003",
    });
    expect(config.staffPolicy()).toEqual({
      ownerIds: ["100000000000000001"],
      adminRoleIds: ["200000000000000001"],
      moderatorRoleIds: ["200000000000000002", "200000000000000003"],
      viewerRoleIds: [],
    });
    expect(() => config.get()).toThrow("not been connected");
  });
});
