import { DiscordRolesService } from "../src/discord-roles/discord-roles.service";
import { MapVotesService } from "../src/map-votes/map-votes.service";
import { PatreonSyncService } from "../src/supporters/patreon-sync.service";
import { SupporterMatchService } from "../src/supporters/supporter-match.service";
import { ServerCommunityService, ServerCommunityWorker } from "../src/server-community/server-community.service";
import { ServerEventsService } from "../src/server-events/server-events.service";
import { StaffAlertsMonitor, StaffAlertsWorker } from "../src/staff-alerts/staff-alerts.monitor";
import { WeeklyLeaderboardService } from "../src/weekly-leaderboard/weekly-leaderboard.service";

/** No providers/targets are supplied: passive checks must return before accessing any business dependencies. */
describe("passive worker controls", () => {
  beforeEach(() => {
    process.env.API_WORKERS_ENABLED = "false";
    jest.useFakeTimers();
  });
  afterEach(() => {
    delete process.env.API_WORKERS_ENABLED;
    jest.useRealTimers();
  });
  it.each([
    DiscordRolesService,
    MapVotesService,
    PatreonSyncService,
    SupporterMatchService,
    ServerCommunityService,
    ServerCommunityWorker,
    ServerEventsService,
    StaffAlertsMonitor,
    WeeklyLeaderboardService,
  ])("does not bootstrap automation for %p", (service) => {
    const instance = Object.create(service.prototype);
    instance.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each([
    [DiscordRolesService, "wake"],
    [DiscordRolesService, "scheduleSafetyPass"],
    [MapVotesService, "schedule"],
    [PatreonSyncService, "schedule"],
    [ServerCommunityWorker, "schedule"],
    [ServerEventsService, "schedule"],
    [StaffAlertsWorker, "schedule"],
    [WeeklyLeaderboardService, "schedule"],
  ] as const)("does not arm manual timers for %p.%s", (service, method) => {
    const instance = Object.create(service.prototype);
    instance[method](0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
