import { Logger } from "@nestjs/common";
import type { DiscordRolesService } from "../discord-roles/discord-roles.service";
import type { EnvService } from "../env/env.service";
import { FIXTURE_DISCORD_ID as discordId } from "./supporter-fixtures";
import {
  SUPPORTER_MATCH_STARTUP_DELAY_MS,
  SUPPORTER_MATCH_SWEEP_LIMIT,
  SupporterMatchService,
} from "./supporter-match.service";
import type { AutoMatchResult, SupporterMatchStore } from "./supporter-match.store";

const result = (overrides: Partial<AutoMatchResult> = {}): AutoMatchResult => ({
  memberId: "member-a",
  discordId,
  skipped: false,
  steamFilled: false,
  founderRecorded: false,
  blocked: [],
  ...overrides,
});
function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    PATREON_ENABLED: true,
    PATREON_CAMPAIGN_ID: "123",
    SUPPORTER_AUTO_STEAM_FILL_ENABLED: true,
    SUPPORTER_AUTO_FOUNDER_ENABLED: true,
    SUPPORTER_FOUNDER_START_AT: "2026-09-30T00:00:00-04:00",
    SUPPORTER_FOUNDER_END_AT: "2026-10-15T00:00:00-04:00",
    ...overrides,
  };
  const store = {
    autoMatch: jest.fn(async (memberId: string, _options: unknown) => result({ memberId })),
    candidates: jest.fn(async (..._args: unknown[]) => ["member-a", "member-b"]),
    patreonMembersForDiscord: jest.fn(async (..._args: unknown[]) => ["member-a"]),
    backfillSources: jest.fn(async () => ({ discord: 0, steam: 0 })),
  };
  const roles = { supporterChanged: jest.fn() };
  const service = new SupporterMatchService(
    store as unknown as SupporterMatchStore,
    { get: (key: string) => values[key] } as EnvService,
    roles as unknown as DiscordRolesService,
  );
  return { service, store, roles, values };
}
let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("automatic supporter matching switches", () => {
  it.each([
    ["both switches off", { SUPPORTER_AUTO_STEAM_FILL_ENABLED: false, SUPPORTER_AUTO_FOUNDER_ENABLED: false }],
    ["Patreon off", { PATREON_ENABLED: false }],
    ["no campaign", { PATREON_CAMPAIGN_ID: undefined }],
  ])("writes nothing with %s", async (_name, overrides) => {
    const { service, store } = fixture(overrides);
    await service.sweep("sync");
    expect(await service.member("member-a", "webhook")).toBeNull();
    await service.applicationChanged(discordId);
    expect(store.candidates).not.toHaveBeenCalled();
    expect(store.autoMatch).not.toHaveBeenCalled();
    expect(store.patreonMembersForDiscord).not.toHaveBeenCalled();
  });
  it("passes each switch to the store separately", async () => {
    const steamOnly = fixture({ SUPPORTER_AUTO_FOUNDER_ENABLED: false });
    await steamOnly.service.member("member-a", "webhook");
    expect(steamOnly.store.autoMatch).toHaveBeenCalledWith(
      "member-a",
      expect.objectContaining({ fillSteam: true, recordFounder: false, campaignId: "123" }),
    );
    const founderOnly = fixture({ SUPPORTER_AUTO_STEAM_FILL_ENABLED: false });
    await founderOnly.service.member("member-a", "webhook");
    expect(founderOnly.store.autoMatch).toHaveBeenCalledWith(
      "member-a",
      expect.objectContaining({ fillSteam: false, recordFounder: true }),
    );
  });
  it("lets a staff link fill the SteamID only, never record a founder promise", async () => {
    const { service, store } = fixture();
    await service.member("member-a", "link", { founder: false });
    expect(store.autoMatch).toHaveBeenCalledWith("member-a", expect.objectContaining({ recordFounder: false }));
    const founderOnly = fixture({ SUPPORTER_AUTO_STEAM_FILL_ENABLED: false });
    expect(await founderOnly.service.member("member-a", "link", { founder: false })).toBeNull();
    expect(founderOnly.store.autoMatch).not.toHaveBeenCalled();
  });
  it("reports both switches, the hold and the last sweep", async () => {
    const { service, store } = fixture({ SUPPORTER_AUTO_FOUNDER_HOLD_HOURS: 24 });
    store.autoMatch
      .mockResolvedValueOnce(result({ steamFilled: true, blocked: ["no_patreon_payment"] }))
      .mockResolvedValueOnce(result({ memberId: "member-b", blocked: ["no_patreon_payment"] }));
    await service.sweep("sync");
    expect(service.status()).toMatchObject({
      steamFill: true,
      founderAuto: true,
      holdHours: 24,
      configured: true,
      running: false,
      lastTrigger: "sync",
      lastError: null,
      checked: 2,
      steamFilled: 1,
      foundersRecorded: 0,
      blocked: { no_patreon_payment: 2 },
      capped: false,
    });
  });
});

describe("startup", () => {
  it("labels older links after a delay even with matching off, then sweeps only when on, on an unref'd timer", async () => {
    jest.useFakeTimers();
    const off = fixture({ SUPPORTER_AUTO_STEAM_FILL_ENABLED: false, SUPPORTER_AUTO_FOUNDER_ENABLED: false });
    const unref = jest.spyOn(globalThis, "setTimeout");
    off.service.onApplicationBootstrap();
    const timer = unref.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await jest.advanceTimersByTimeAsync(SUPPORTER_MATCH_STARTUP_DELAY_MS);
    expect(off.store.backfillSources).toHaveBeenCalledTimes(1);
    expect(off.store.candidates).not.toHaveBeenCalled();
    const on = fixture();
    on.service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(SUPPORTER_MATCH_STARTUP_DELAY_MS);
    expect(on.store.backfillSources).toHaveBeenCalledTimes(1);
    expect(on.store.candidates).toHaveBeenCalledTimes(1);
    expect(on.service.status().lastTrigger).toBe("startup");
  });
  it("holds matching until the labels are written", async () => {
    jest.useFakeTimers();
    const { service, store } = fixture();
    service.onApplicationBootstrap();
    const early = service.member("member-a", "webhook");
    await jest.advanceTimersByTimeAsync(SUPPORTER_MATCH_STARTUP_DELAY_MS - 1);
    expect(store.autoMatch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await early;
    expect(store.backfillSources.mock.invocationCallOrder[0]).toBeLessThan(store.autoMatch.mock.invocationCallOrder[0]);
  });
  it("matches after a failed labelling, saying only founder recording is withheld, in fixed text", async () => {
    jest.useFakeTimers();
    const { service, store } = fixture();
    store.backfillSources.mockRejectedValueOnce(new Error(`duplicate key ${discordId}`));
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(SUPPORTER_MATCH_STARTUP_DELAY_MS);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(discordId);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be classified"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Matching still runs"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("never matched");
    expect(store.candidates).toHaveBeenCalledTimes(1);
  });
  it("cancels the startup timer when the module is destroyed and releases anything waiting", async () => {
    jest.useFakeTimers();
    const { service, store } = fixture();
    service.onApplicationBootstrap();
    const waiting = service.sweep("sync");
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(SUPPORTER_MATCH_STARTUP_DELAY_MS * 2);
    await waiting;
    expect(store.backfillSources).not.toHaveBeenCalled();
    expect(store.candidates).not.toHaveBeenCalled();
  });
});

describe("sweeps", () => {
  it("runs one sweep at a time and runs once more for a sweep asked for meanwhile", async () => {
    const { service, store } = fixture();
    let release!: () => void;
    store.candidates.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (release = () => resolve(["member-a"]))),
    );
    const first = service.sweep("startup");
    const second = service.sweep("sync");
    const third = service.sweep("sync");
    expect(service.status().running).toBe(true);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second, third]);
    expect(store.candidates).toHaveBeenCalledTimes(2);
    expect(service.status()).toMatchObject({ running: false, lastTrigger: "sync" });
  });
  it("never rejects and logs fixed text only when the store fails", async () => {
    const { service, store } = fixture();
    store.candidates.mockRejectedValueOnce(new Error(`steam_id ${discordId}`));
    await expect(service.sweep("sync")).resolves.toBeUndefined();
    store.autoMatch.mockRejectedValueOnce(new Error(`steam_id ${discordId}`));
    await expect(service.sweep("sync")).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(discordId);
    expect(service.status().lastError).toBe(
      "Automatic supporter matching could not finish. Records already saved were kept; the next sync or approval retries.",
    );
    await service.sweep("sync");
    expect(service.status().lastError).toBeNull();
  });
  it("reports a lost race for the SteamID as held by another record", async () => {
    const { service, store } = fixture();
    store.autoMatch.mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505" }));
    expect(await service.member("member-a", "approval")).toMatchObject({
      steamFilled: false,
      blocked: ["steam_on_another_record"],
    });
    expect(service.status().lastError).toBeNull();
  });
  it("continues after the last record a capped sweep checked", async () => {
    const { service, store } = fixture();
    const many = Array.from({ length: SUPPORTER_MATCH_SWEEP_LIMIT + 1 }, (_, index) => `member-${index}`);
    store.candidates.mockResolvedValueOnce(many).mockResolvedValueOnce([]);
    await service.sweep("sync");
    expect(store.autoMatch).toHaveBeenCalledTimes(SUPPORTER_MATCH_SWEEP_LIMIT);
    expect(service.status().capped).toBe(true);
    await service.sweep("sync");
    expect(store.candidates.mock.calls[1][3]).toBe(`member-${SUPPORTER_MATCH_SWEEP_LIMIT - 1}`);
  });
  it("stops between records on shutdown", async () => {
    const { service, store } = fixture();
    store.autoMatch.mockImplementationOnce(async (memberId: string) => {
      service.onModuleDestroy();
      return result({ memberId });
    });
    await service.sweep("sync");
    expect(store.autoMatch).toHaveBeenCalledTimes(1);
  });
});

describe("the Founder role after an automatic promise", () => {
  it("queues exactly one role check per recorded founder, and none for a SteamID fill alone", async () => {
    const { service, store, roles } = fixture();
    store.autoMatch
      .mockResolvedValueOnce(result({ steamFilled: true }))
      .mockResolvedValueOnce(result({ memberId: "member-b", founderRecorded: true }));
    await service.sweep("sync");
    expect(roles.supporterChanged.mock.calls).toEqual([[discordId]]);
  });
  it("keeps going when the role service throws", async () => {
    const { service, store, roles } = fixture();
    store.autoMatch.mockResolvedValue(result({ founderRecorded: true }));
    roles.supporterChanged.mockImplementation(() => {
      throw new Error("queue unavailable");
    });
    await service.sweep("sync");
    expect(service.status()).toMatchObject({ foundersRecorded: 2, lastError: null });
  });
});

describe("approvals", () => {
  it.each([undefined, null, "", "not-a-snowflake", 123, "1234"])("ignores an invalid Discord ID: %p", async (id) => {
    const { service, store } = fixture();
    await service.applicationChanged(id);
    expect(store.patreonMembersForDiscord).not.toHaveBeenCalled();
  });
  it("matches the campaign's Patreon record for the approved Discord account and never rejects", async () => {
    const { service, store } = fixture();
    await service.applicationChanged(discordId);
    expect(store.patreonMembersForDiscord).toHaveBeenCalledWith("123", discordId);
    expect(store.autoMatch).toHaveBeenCalledWith("member-a", expect.objectContaining({ recordFounder: true }));
    store.patreonMembersForDiscord.mockRejectedValueOnce(new Error("database down"));
    await expect(service.applicationChanged(discordId)).resolves.toBeUndefined();
  });
});
