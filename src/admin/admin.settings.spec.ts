import { AdminSettings } from "./admin.settings";
import type { EnvService } from "../env/env.service";

function settings(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    ADMIN_ENABLED: true,
    ADMIN_ORIGIN: "https://theuncs.example",
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
  it("keeps access disabled until all required server settings exist", () => {
    expect(() => settings({ ADMIN_ENABLED: false }).get()).toThrow("not been connected");
    expect(() => settings({ WARDOGS_RCON_PASSWORD: undefined }).get()).toThrow("not been connected");
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
    expect(() => settings({ WARDOGS_RCON_URL: url }).get()).toThrow("need attention"),
  );
  it("uses only explicit IDs without implicitly granting Discord administrators access", () => {
    expect(settings().get()).toMatchObject({ ownerIds: [], adminRoleIds: [], moderatorRoleIds: [], viewerRoleIds: [] });
  });
});
