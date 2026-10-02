import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AdminAuth } from "../admin/admin.auth";
import { AdminService } from "../admin/admin.service";
import { GameServers } from "../admin/game-servers";
import { GameRounds } from "../admin/game-rounds";
import { planMapNext, UnavailableSelection, validateMapSelection } from "../admin/server-configuration";
import { serves } from "../common/admin-policy";
import { isModeModifier, mapLabel, modeLabel, sameMap, selectionLabel } from "../common/map-labels";
import { observedElapsed, roundElapsed, type RoundTrack } from "../common/round-tracker";
import {
  automationSettings,
  closeReached,
  closeThreshold,
  defaultVotingPolicy,
  defaultVotingSettings,
  voteChoiceKey,
  voteChoiceTitle,
  votingProgress,
  votingSettingLimits,
  type VoteAutomation,
  type VoteChoice,
  type VoteReminder,
  type VoteRotationSnapshot,
  type VoteRoundSnapshot,
  type VotingContext,
  type VotingControls,
  type VotingPolicy,
  type VotingSettings,
} from "../common/voting-policy";
import { roundStamp, sameRound } from "../common/game-round";
import type {
  AutomaticVotePhase,
  AutomaticVoteStatus,
  MapVotePreview,
  MapVoteSetup,
} from "../common/map-vote-automation";
import type { MapSelection } from "../common/server-settings";
import type { AdminAction, Staff } from "../admin/admin.types";
import type { WardogsClient } from "../admin/wardogs.client";
import { EnvService } from "../env/env.service";
import { plainLabel } from "../server-community/community-state";
import { ServerEventsService } from "../server-events/server-events.service";
import { StaffAlerts } from "../staff-alerts/staff-alerts.service";
import type { mapVotePolicies } from "../database/schema";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";
import { buildBallot, rotationFingerprint, type BallotPlan } from "./ballot-builder";
import { cancelMapVoteSchema, mapVoteView, startMapVoteSchema, type MapVoteRecord } from "./map-votes.types";
import {
  mergeSettings,
  readStoredPolicy,
  saveVotingControlsSchema,
  validateVotingDocument,
  votingSettingsPatchSchema,
  votingSettingsShape,
  VotingSettingsError,
  type VotingIssue,
} from "./voting-settings";

type PolicyRow = typeof mapVotePolicies.$inferSelect;
type FinishState = "queued" | "no_votes" | "tied" | "cancelled" | "needs_review";
type Finish = { state: FinishState; message: string; patch?: Partial<VoteAutomation> };
type AutomaticNote = Omit<AutomaticVoteStatus, "enabled" | "delaySeconds" | "closesAtScore" | "choices">;
type AutomaticStart = {
  previousId: string | null;
  map: string;
  index: number;
  policy: VotingPolicy;
  policyVersion: number;
  settings: VotingSettings;
  round: VoteRoundSnapshot;
  rotation: VoteRotationSnapshot;
};
type Evaluation = {
  blocked: string | null;
  message: string;
  detail: Partial<AutomaticNote>;
  plan: BallotPlan | null;
  ready?: { revision: string; currentMap: string; round: VoteRoundSnapshot; rotation: VoteRotationSnapshot };
};

const ACTIVE_STATES = ["publishing", "open", "closing", "needs_review"];
const FRESH_MS = 30_000;
/** Fixed brake against a flapping round detector. */
const BALLOT_GAP_MS = 10 * 60_000;
const REVIEW_ALERT_MS = 2 * 60_000;
const ALERT_REPEAT_MS = 30 * 60_000;
const UNPOSTED_MS = 2 * 60_000;
const SEED_MAX_AGE_MS = 180 * 60_000;
const STEP_SAMPLE_MS = 20_000;
const PREVIEW_INTERVAL_MS = 5_000;
const REFUSAL_BRAKE = 3;
const BROADCAST_LIMIT = 200;
/** A voted 50v50 still needs its offer minimum, less this allowance for leavers, when the ballot closes. */
const FIFTY_CLOSE_ALLOWANCE = 10;

function pickPolicy(raw: unknown): VotingPolicy {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const flag = (key: keyof VotingPolicy) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : defaultVotingPolicy[key];
  return {
    enabled: flag("enabled"),
    mapChoices: flag("mapChoices"),
    modeChoices: flag("modeChoices"),
    midpointReminder: flag("midpointReminder"),
    finalReminder: flag("finalReminder"),
  };
}
function stripEvent(choice: VoteChoice): MapSelection {
  const { map, experiences, lighting, zoneAlternator } = choice;
  return { map, experiences, ...(lighting ? { lighting } : {}), ...(zoneAlternator ? { zoneAlternator } : {}) };
}
/** A short in-game label: map, rule modifiers and 50v50 only. */
function gameLabel(choice: VoteChoice, max = 40) {
  return plainLabel(
    [
      mapLabel(choice.map),
      ...choice.experiences.filter(isModeModifier).map((id) => modeLabel(id)),
      choice.event ? "50v50" : "",
    ]
      .filter(Boolean)
      .join(" "),
    max,
  );
}
function fitBroadcast(text: string) {
  return text.length <= BROADCAST_LIMIT ? text : `${text.slice(0, BROADCAST_LIMIT - 3).trimEnd()}...`;
}
function duration(seconds: number) {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
function settingsError(issue: VotingIssue) {
  return new BadRequestException({ message: issue.message, path: issue.path, statusCode: 400 });
}
const withoutStop = (text: string) => text.trim().replace(/[.!?]+$/, "");
/** Automatic ballots, newest first, as the 50v50 cooldown counts them. */
function ballotRounds(history: MapVoteRecord[]) {
  return history
    .filter((vote) => vote.automation)
    .map((vote) => ({ roundId: vote.automation!.round?.id, createdAt: vote.createdAt }));
}
function isFiftyWinner(vote: Pick<MapVoteRecord, "winner" | "choices">) {
  return vote.winner !== null && vote.choices[vote.winner]?.event === "50v50";
}

@Injectable()
export class MapVotesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MapVotesService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  /** Poll every 5 seconds while a ballot is near its close score. */
  private fast = false;
  private readonly automaticMessages = new Map<string, AutomaticNote>();
  private readonly lastScores = new Map<string, { at: number; score: number }>();
  private readonly reviewLogged = new Set<string>();
  private readonly previews = new Map<string, number>();
  /** Voted 50v50 events that need staff review, by server, and their alert counts. */
  private readonly eventReviews = new Map<string, { id: string; at: string; message: string }>();
  private readonly eventAlerts = new Map<string, { count: number; at: number }>();
  constructor(
    private readonly store: MapVotesStore,
    private readonly servers: GameServers,
    private readonly admin: AdminService,
    private readonly auth: AdminAuth,
    private readonly discord: MapVotesDiscord,
    private readonly env: EnvService,
    private readonly rounds: GameRounds,
    private readonly alerts: StaffAlerts,
    private readonly events: ServerEventsService,
  ) {}
  private options() {
    const guildId = this.env.get("ADMIN_GUILD_ID"),
      channelId = this.env.get("MAP_VOTES_CHANNEL_ID");
    return { enabled: this.env.get("MAP_VOTES_ENABLED") === true && !!guildId && !!channelId, guildId, channelId };
  }
  private requireStaff(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can manage map votes.");
  }
  private note(serverId: string, message: string, detail: Partial<AutomaticNote> = {}) {
    this.automaticMessages.set(serverId, { ...detail, message, checkedAt: new Date().toISOString() });
  }
  /** Broadcasts use their own actor so they never share the human administrator's action throttle. */
  private sayActor(actor: Staff, serverId: string): Staff {
    return { ...actor, id: `system:map-vote-say:${serverId}`, name: "Gramps community vote" };
  }
  private queueActor(actor: Staff, serverId: string): Staff {
    return { ...actor, id: `system:map-vote:${serverId}`, name: "Gramps community vote" };
  }
  private async automaticStatus(serverId: string): Promise<AutomaticVoteStatus | null> {
    const saved = await this.store.policy(serverId);
    if (!saved) return null;
    const connectionMatches = saved.connectionHash === this.servers.connectionHash(serverId);
    const policy = pickPolicy(saved.policy);
    let settings = defaultVotingSettings,
      valid = true;
    try {
      settings = readStoredPolicy(saved.policy).settings;
    } catch {
      valid = false;
    }
    const live = this.options().enabled && policy.enabled && connectionMatches && valid;
    const review = this.eventReviews.get(serverId);
    return {
      enabled: live,
      delaySeconds: settings.openDelaySeconds,
      closesAtScore: settings.closeAtScore,
      choices: settings.optionCount,
      message: !connectionMatches
        ? "The server connection changed. Switch voting off and save its controls before setup."
        : !valid
          ? "The saved voting settings are invalid. Review and save them again."
          : live
            ? `Waiting for confirmed rotation and scores. Ballots close at ${settings.closeAtScore} points.`
            : "Automatic voting is switched off.",
      checkedAt: null,
      phase: live ? "waiting_rotation" : "off",
      ...(live ? this.automaticMessages.get(serverId) : {}),
      ...(live && review ? { alert: { at: review.at, message: review.message } } : {}),
    };
  }
  private enabled() {
    const options = this.options();
    if (!options.enabled)
      throw new ServiceUnavailableException(
        "Map voting is not enabled. Its database and Discord channel need owner setup.",
      );
    return { guildId: options.guildId!, channelId: options.channelId! };
  }
  /** Game facts the dashboard needs to explain the settings; null when the game cannot be read. */
  private async votingContext(serverId: string): Promise<VotingContext | null> {
    try {
      const game = this.servers.get(serverId);
      const [config, overview] = await Promise.all([game.configuration(), game.overview()]);
      const capabilities = overview.capabilities ?? (await game.capabilities());
      const eventsEnabled = this.env.get("SERVER_EVENTS_ENABLED") === true;
      const controls =
        serves(capabilities, "PATCH", "/v1/players/{id}") && serves(capabilities, "POST", "/v1/broadcast");
      return {
        startThreshold: this.rounds.threshold(serverId, config.fields),
        factions: (overview.status.factionScores ?? []).map((faction) => faction.name).filter(Boolean),
        eventsEnabled,
        routes: {
          kill: serves(capabilities, "POST", "/v1/players/{id}/kill"),
          message: serves(capabilities, "POST", "/v1/players/{id}/message"),
        },
        fifty: {
          available: eventsEnabled && controls,
          message: !eventsEnabled
            ? "Optional events are off in Gramps, so ballots never offer 50v50. These settings can still be prepared."
            : !controls
              ? "This game build does not advertise team moves and broadcasts, so ballots cannot offer 50v50."
              : "Ballots offer 50v50 as the last option whenever every readiness check passes; the voting status explains any check that fails.",
        },
      };
    } catch {
      return null;
    }
  }
  async controls(staff: Staff): Promise<VotingControls> {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    let controls: VotingControls;
    try {
      const saved = await this.store.policy(serverId);
      const connectionMatches = !saved || saved.connectionHash === this.servers.connectionHash(serverId);
      let settings = defaultVotingSettings,
        valid = true;
      if (saved)
        try {
          settings = readStoredPolicy(saved.policy).settings;
        } catch {
          valid = false;
        }
      controls = {
        serverId,
        version: saved?.version ?? 0,
        // Only the five switches: an older dashboard posts this object back unchanged.
        policy: saved ? pickPolicy(saved.policy) : defaultVotingPolicy,
        available: true,
        ready: this.options().enabled && connectionMatches,
        message: !connectionMatches
          ? "The server connection changed. Switch voting off and save before enabling it for this connection."
          : !valid
            ? "The saved voting settings are invalid, so automatic voting is paused. Review and save them again."
            : this.options().enabled
              ? "Changes apply to the next ballot. Switching off stops open automatic ballots."
              : "Live voting is disabled in Gramps. You can prepare these settings without opening a ballot.",
        settings,
        limits: votingSettingLimits,
      };
    } catch {
      return {
        serverId,
        version: 0,
        policy: defaultVotingPolicy,
        available: false,
        ready: false,
        message:
          "Voting controls storage is unavailable. The new policy table and ballot automation column need the reviewed database migration.",
        settings: defaultVotingSettings,
        limits: votingSettingLimits,
        context: null,
      };
    }
    return { ...controls, context: await this.votingContext(serverId) };
  }
  async saveControls(staff: Staff, input: unknown) {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    this.servers.checkVersion(serverId, staff.serverVersion);
    const parsed = saveVotingControlsSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (item) => item.path[0] === "settings" && item.code !== "unrecognized_keys",
      );
      if (issue)
        throw settingsError({
          path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
          message: issue.message,
        });
    }
    if (!parsed.success || parsed.data.serverId !== serverId)
      throw new BadRequestException("Review the voting controls for the selected server.");
    const request = parsed.data;
    if (request.policy.enabled) {
      const saved = await this.store.policy(serverId);
      if (saved && saved.connectionHash !== this.servers.connectionHash(serverId))
        throw new ConflictException(
          "The server connection changed. Save voting off before reviewing activation again.",
        );
      const options = this.enabled();
      await this.discord.check(options.guildId, options.channelId);
    }
    let result: Awaited<ReturnType<MapVotesStore["savePolicy"]>>;
    try {
      result = await this.store.savePolicy(
        serverId,
        request.version,
        (previous) => {
          // A save without settings (the original dashboard) keeps every stored setting.
          const base = mergeSettings(defaultVotingSettings, previous?.settings);
          const { policy, settings } = validateVotingDocument(request.policy, mergeSettings(base, request.settings));
          return { ...policy, settings };
        },
        staff,
        this.servers.connectionHash(serverId),
      );
    } catch (error) {
      if (error instanceof VotingSettingsError) throw settingsError(error.issue);
      throw error;
    }
    for (const vote of result.closed) await this.updateMessage(vote);
    return this.controls(staff);
  }
  async setup(staff: Staff): Promise<MapVoteSetup> {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    const { guildId, channelId } = this.options();
    const check = async (
      label: string,
      read: () => Promise<Omit<MapVoteSetup["checks"][number], "label">>,
      failure: string,
    ): Promise<MapVoteSetup["checks"][number]> => {
      try {
        return { label, ...(await read()) };
      } catch {
        return { label, status: "blocked", message: failure };
      }
    };
    const savedSettings = async () => {
      const saved = await this.store.policy(serverId);
      return saved ? readStoredPolicy(saved.policy).settings : defaultVotingSettings;
    };
    const checks = await Promise.all([
      check(
        "Storage",
        async () => {
          const storage = await this.store.checkSetup(serverId);
          return storage.unfinished
            ? {
                status: "review",
                message: "Tables are readable. An unfinished ballot exists; review it before enabling voting.",
              }
            : { status: "ok", message: "Voting tables are readable. No unfinished ballot on this server." };
        },
        "Voting storage could not be read. Check database access and the existing 0003 migration.",
      ),
      check(
        "Discord channel",
        async () => {
          if (!guildId || !channelId)
            return { status: "blocked", message: "Choose a voting channel in the community's Gramps configuration." };
          const channel = await this.discord.check(guildId, channelId);
          return { status: "ok", message: `Gramps can read and post in #${channel.name}.` };
        },
        "The voting channel is unavailable or Gramps lacks permission to read and post there.",
      ),
      check(
        "Automatic voting",
        async () => {
          const saved = await this.store.policy(serverId);
          if (saved && saved.connectionHash !== this.servers.connectionHash(serverId))
            return {
              status: "review",
              message:
                "Voting controls belong to the previous server connection. Switch voting off and save before setting it up again.",
            };
          const actorId = saved?.actorId;
          if (!actorId) return { status: "blocked", message: "Save voting controls for this server." };
          const actor = await this.auth.serverStaff(
            { id: actorId, name: "Gramps automatic voting", role: "admin", csrf: "" },
            serverId,
            true,
          );
          if (actor.role !== "admin")
            return { status: "blocked", message: "The configured voting administrator needs access to this server." };
          return {
            status: "ok",
            message:
              "Saved score-based controls and administrator access checked. Voting remains under its on/off switches.",
          };
        },
        "The configured voting administrator's access could not be verified.",
      ),
      check(
        "Rotation",
        async () => {
          const { rotation } = await this.servers.get(serverId).configuration();
          if (!rotation.editable || !rotation.enabled || rotation.mode !== "Ordered")
            return {
              status: "blocked",
              message: "Voting needs an editable ordered rotation with a confirmed current position.",
            };
          return rotation.currentIndex !== null
            ? {
                status: "ok",
                message:
                  "Ordered rotation and current position confirmed. Ballot choices are validated before opening.",
              }
            : {
                status: "review",
                message: rotation.positionNote || "The game has not confirmed the current rotation position.",
              };
        },
        "The server's current rotation could not be read.",
      ),
      check(
        "Players",
        async () => {
          const game = this.servers.get(serverId);
          const [settings, config, overview] = await Promise.all([
            savedSettings(),
            game.configuration(),
            game.overview(),
          ]);
          const threshold = this.rounds.threshold(serverId, config.fields);
          const required = Math.max(settings.minPlayers, threshold);
          const current = overview.status.players?.current ?? 0;
          return current >= required
            ? { status: "ok", message: `${current} players online. Ballots open from ${required} players.` }
            : {
                status: "review",
                message: `${current} players online. Ballots wait for ${required} players; the game starts matches at ${threshold}.`,
              };
        },
        "The player count could not be read.",
      ),
      check(
        "50v50 option",
        async () => {
          const settings = await savedSettings();
          if (!settings.fiftyFifty.offered)
            return { status: "ok", message: "Off. Ballots offer maps and rule variants only." };
          const game = this.servers.get(serverId);
          const [config, overview, history] = await Promise.all([
            game.configuration(),
            game.overview(),
            this.store.history(serverId),
          ]);
          const track = this.rounds.peek(serverId, overview, { fields: config.fields }).track;
          const readiness = await this.events.voteEventReadiness(
            serverId,
            settings.fiftyFifty,
            config,
            overview,
            track,
            ballotRounds(history),
          );
          return readiness.ok
            ? { status: "ok", message: "Ready. Ballots offer 50v50 as the last option while every check passes." }
            : { status: "review", message: `Offered, but not right now: ${readiness.reason}.` };
        },
        "The 50v50 readiness checks could not be read.",
      ),
    ]);
    return { serverId, checkedAt: new Date().toISOString(), checks };
  }
  async list(staff: Staff) {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    const enabled = this.options().enabled;
    const history = enabled ? await this.store.history(serverId) : [];
    const open = history.filter((vote) => vote.state === "open").map((vote) => vote.id);
    const totals = open.length ? await this.store.liveCounts(open) : [];
    const observedAt = new Date().toISOString();
    return {
      enabled,
      serverId,
      observedAt,
      automatic: enabled ? await this.automaticStatus(serverId) : null,
      votes: history.map((vote) => ({
        ...mapVoteView(vote),
        ...(vote.state === "open"
          ? {
              counted: true,
              counts: vote.choices.map(
                (_, choice) => totals.find((row) => row.voteId === vote.id && row.choice === choice)?.total ?? 0,
              ),
            }
          : {}),
      })),
    };
  }
  /** Read-only: what the next automatic ballot would offer with a draft of the settings. */
  async preview(staff: Staff, input: unknown): Promise<MapVotePreview> {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    const parsed = z
      .object({ serverId: z.string(), settings: votingSettingsPatchSchema.optional() })
      .strict()
      .safeParse(input);
    if (!parsed.success || parsed.data.serverId !== serverId)
      throw new BadRequestException("Review the preview request for the selected server.");
    const key = `${serverId}:${staff.id}`;
    if (Date.now() - (this.previews.get(key) ?? 0) < PREVIEW_INTERVAL_MS)
      throw new HttpException("Wait a few seconds before previewing again.", 429);
    if (this.previews.size > 1000) this.previews.clear();
    this.previews.set(key, Date.now());
    const saved = await this.store.policy(serverId);
    const policy = saved ? pickPolicy(saved.policy) : defaultVotingPolicy;
    const draft = votingSettingsShape.safeParse(
      mergeSettings(mergeSettings(defaultVotingSettings, saved?.policy.settings), parsed.data.settings),
    );
    if (!draft.success) {
      const [issue] = draft.error.issues;
      throw settingsError({ path: ["settings", ...issue.path.map(String)], message: issue.message });
    }
    let history: MapVoteRecord[] = [];
    try {
      history = await this.store.history(serverId);
    } catch {
      /* A preview without history cannot apply recent-map rules, but still shows options. */
    }
    let evaluation: Evaluation;
    try {
      evaluation = await this.evaluate(
        serverId,
        policy,
        draft.data,
        history,
        this.servers.connectionHash(serverId),
        "preview",
      );
    } catch {
      throw new ServiceUnavailableException("The game could not be read for a preview. Try again shortly.");
    }
    const blocked = !policy.enabled ? "Automatic voting is switched off." : evaluation.blocked;
    return {
      checkedAt: new Date().toISOString(),
      phase: !policy.enabled ? "off" : (evaluation.detail.phase ?? "open"),
      players: evaluation.detail.players ?? null,
      round: evaluation.detail.round ?? null,
      leadingProgress: evaluation.detail.leadingProgress ?? null,
      next: evaluation.detail.next ?? null,
      options: (evaluation.plan?.options ?? []).map((option) => ({
        label: voteChoiceTitle(option.choice),
        kind: option.kind,
        placement: option.placement,
      })),
      fifty: evaluation.plan?.fifty ?? {
        offered: false,
        reason: draft.data.fiftyFifty.offered
          ? "50v50 is checked once the round and rotation allow a ballot."
          : "The 50v50 option is off.",
      },
      blocked,
    };
  }
  async start(staff: Staff, input: unknown, automatic?: AutomaticStart) {
    this.requireStaff(staff);
    const configured = this.enabled();
    const parsed = startMapVoteSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        "Choose two to five different map/mode combinations, a 2–30 minute duration and a reason.",
      );
    const action = parsed.data;
    if (!automatic && action.choices.some((choice) => choice.event))
      throw new BadRequestException("Only automatic ballots can offer a 50v50 round.");
    const serverId = this.servers.resolve(staff.serverId);
    if (action.serverId !== serverId) throw new BadRequestException("The ballot must target the selected server.");
    const requestHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    const previous = await this.store.get(action.id);
    if (previous) {
      if (previous.serverId !== serverId || previous.actorId !== staff.id || previous.requestHash !== requestHash)
        throw new ConflictException("This ballot ID was used for a different request.");
      return mapVoteView(previous);
    }
    const connectionHash = this.servers.connectionHash(serverId);
    const game = this.servers.get(serverId);
    const settings = await game.configuration();
    if (
      // Automatic ballots follow the rotation itself; unrelated settings saves do not matter.
      (automatic
        ? rotationFingerprint(settings.rotation) !== automatic.rotation.fingerprint
        : settings.revision !== action.revision) ||
      !settings.rotation.editable ||
      !settings.rotation.enabled ||
      settings.rotation.mode !== "Ordered" ||
      settings.rotation.currentIndex === null
    )
      throw new ConflictException("Refresh settings. Map votes need the current editable, ordered rotation.");
    if (
      automatic &&
      (automatic.index !== settings.rotation.currentIndex || !sameMap(automatic.map, settings.rotation.currentMap))
    )
      throw new ConflictException("The observed rotation position changed before the vote opened.");
    const capabilities = await game.capabilities(),
      catalog = await game.catalog();
    for (const choice of action.choices) await validateMapSelection(game, stripEvent(choice), capabilities, catalog);
    const overview = await game.overview();
    const observedAt = Date.parse(overview.observedAt);
    if (!Number.isFinite(observedAt) || !sameMap(overview.status.map, settings.rotation.currentMap))
      throw new ConflictException("The current map could not be confirmed. Refresh before starting a vote.");
    const round = roundStamp(overview.status, observedAt);
    const progress = automatic ? votingProgress(overview.status) : null;
    if (
      automatic &&
      (progress === null ||
        progress >= automatic.settings.openScoreCeiling ||
        Math.abs(Date.now() - observedAt) > FRESH_MS)
    )
      throw new ConflictException(
        `A fresh score below ${automatic.settings.openScoreCeiling} is needed to open an automatic ballot.`,
      );
    const channel = await this.discord.check(configured.guildId, configured.channelId);
    if (this.stopped) throw new ServiceUnavailableException("Gramps is stopping. No ballot was created.");
    const now = new Date();
    const started = await this.store.create(
      {
        id: action.id,
        serverId,
        serverName: overview.status.serverName,
        connectionHash,
        ...configured,
        actorId: staff.id,
        actorName: staff.name,
        reason: action.reason,
        requestHash,
        choices: action.choices,
        revision: settings.revision,
        currentMap: settings.rotation.currentMap,
        currentIndex: settings.rotation.currentIndex,
        roundStartedAt: round ? new Date(round.startedAt) : null,
        closesAt: new Date(now.getTime() + (automatic ? 180 : action.minutes) * 60_000),
        automation: automatic
          ? {
              policy: automatic.policy,
              policyVersion: automatic.policyVersion,
              settings: automatic.settings,
              highestScore: progress!,
              openedAtScore: progress!,
              maxStep: 0,
              reminders: {},
              round: automatic.round,
              rotation: automatic.rotation,
            }
          : null,
        counts: action.choices.map(() => 0),
        createdAt: now,
        updatedAt: now,
      },
      ...(automatic ? [automatic.previousId] : []),
    );
    if (!started.created) return mapVoteView(started.record);
    let record = started.record;
    try {
      if (this.stopped) throw new Error("Gramps is stopping.");
      const messageId = await this.discord.publish(record);
      const published = await this.store.published(record.id, messageId);
      if (!published) throw new Error("Publication was interrupted.");
      record = published;
      if (record.automation && !(await this.store.policy(serverId))?.policy.enabled) {
        await this.cancelAutomatic(record, "Voting was switched off while the ballot was being published.");
        record = (await this.store.get(record.id)) ?? record;
      }
    } catch {
      record =
        (await this.store.finish(
          record.id,
          "needs_review",
          "Discord publication could not be confirmed. Gramps is checking the channel; do not create a duplicate ballot.",
        )) ?? record;
    }
    if (record.state === "open" && record.automation) await this.announceOpen(record, staff, channel.name);
    return mapVoteView(record);
  }
  /** One in-game notice when an automatic ballot opens. Never retried. */
  private async announceOpen(vote: MapVoteRecord, actor: Staff, channelName: string) {
    const settings = automationSettings(vote.automation!);
    if (!vote.automation!.settings || !settings.announce.openInGame) return;
    const prefix = `Next round vote is open in Discord #${plainLabel(channelName, 35)}: `;
    const suffix = `. Closes at ${settings.closeAtScore} points.`;
    let labels = vote.choices.map((choice) => gameLabel(choice)).join(", ");
    if (prefix.length + labels.length + suffix.length > BROADCAST_LIMIT)
      labels = vote.choices.map((choice) => gameLabel(choice, 16)).join(", ");
    try {
      const result = await this.admin.act(this.sayActor(actor, vote.serverId), {
        id: randomUUID(),
        action: "broadcast",
        reason: `Map vote ${vote.id} opened`,
        message: fitBroadcast(`${prefix}${labels}${suffix}`),
      });
      if (!["applied", "accepted"].includes(result.state))
        this.logger.warn("The in-game voting announcement was not confirmed. It is not retried.");
    } catch {
      this.logger.warn("The in-game voting announcement could not be sent. It is not retried.");
    }
  }
  /** The surface-agnostic voting entry point; Discord buttons use it today. */
  async cast(
    id: string,
    choice: string,
    userId: string,
    guildId: string | null,
    channelId: string,
    messageId: string,
    eligible: boolean,
  ) {
    const configured = this.enabled();
    if (!eligible || guildId !== configured.guildId)
      throw new ForbiddenException("Only community members who completed screening can vote.");
    if (!z.uuid().safeParse(id).success || !/^[0-4]$/.test(choice) || !/^\d{17,20}$/.test(userId))
      throw new BadRequestException("This vote button is invalid.");
    return this.store.cast(id, userId, Number(choice), guildId, channelId, messageId);
  }
  async cancel(staff: Staff, id: string, input: unknown) {
    this.requireStaff(staff);
    this.enabled();
    const parsed = cancelMapVoteSchema.safeParse(input);
    if (!z.uuid().safeParse(id).success || !parsed.success)
      throw new BadRequestException("Choose a ballot and enter a reason.");
    const selected = this.servers.resolve(staff.serverId);
    if ((await this.store.get(id))?.serverId !== selected)
      throw new BadRequestException("Choose a ballot on the selected server.");
    const vote = await this.store.cancel(id, parsed.data.id, staff, parsed.data.reason);
    await this.updateMessage(vote);
    return mapVoteView(vote);
  }
  onApplicationBootstrap() {
    if (this.options().enabled) this.schedule();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(
      () => {
        void this.tick().finally(() => this.schedule());
      },
      this.fast ? 5_000 : 15_000,
    );
    this.timer.unref();
  }
  /** Isolated tests call this without starting a timer or touching Discord/the game. */
  async tick() {
    if (this.running || this.stopped || !this.options().enabled) return;
    this.running = true;
    this.fast = false;
    try {
      for (const recovered of await this.store.recover(new Date())) await this.updateMessage(recovered);
      for (const due of await this.store.due(new Date())) {
        if (this.stopped) break;
        if (due.automation) {
          await this.cancelAutomatic(
            due,
            "The ballot expired before a safe score cutoff. The rotation was left unchanged.",
          );
          continue;
        }
        const vote = await this.store.claimClose(due.id);
        if (!vote) continue;
        await this.close(vote);
      }
      await this.reconcile();
      for (const vote of await this.store.automaticOpen()) {
        if (this.stopped) break;
        try {
          await this.observeAutomatic(vote);
        } catch {
          this.note(
            vote.serverId,
            "Current scores or position could not be checked. No new reminder or queue change was confirmed.",
            { phase: "open" },
          );
        }
      }
      const policies = await this.store.policies();
      for (const recipe of policies.filter((row) => row.policy.enabled)) {
        if (this.stopped) break;
        try {
          if (recipe.connectionHash !== this.servers.connectionHash(recipe.serverId))
            throw new Error("Voting server changed.");
          await this.openAutomatic(recipe);
        } catch (error) {
          this.note(
            recipe.serverId,
            error instanceof VotingSettingsError
              ? "The saved voting settings are invalid. Review and save them again."
              : "Automatic voting is waiting for valid rotation options, storage and staff access. No new ballot was confirmed.",
            { phase: "waiting_rotation" },
          );
        }
      }
    } catch {
      this.logger.warn(
        "Map voting could not complete its observation. Recorded work is retained; uncertain actions are not replayed.",
      );
    } finally {
      this.running = false;
    }
  }
  /** Settles automatic ballots in review when Discord, the rotation or the action receipt shows what happened. */
  private async reconcile() {
    let reviews: MapVoteRecord[];
    try {
      reviews = await this.store.needsReview();
    } catch {
      return;
    }
    for (const vote of reviews) {
      if (this.stopped) break;
      try {
        await this.reconcileOne(vote);
      } catch {
        this.logger.warn(`Automatic map vote ${vote.id} could not be rechecked. It stays in review.`);
      }
    }
  }
  private async reconcileOne(vote: MapVoteRecord) {
    if (!this.reviewLogged.has(vote.id)) {
      if (this.reviewLogged.size > 500) this.reviewLogged.clear();
      this.reviewLogged.add(vote.id);
      this.logger.warn(`Automatic map vote ${vote.id} on ${vote.serverId} needs review: ${vote.message}`);
    }
    const resolve = (to: "queued" | "cancelled", message: string, patch: Partial<VoteAutomation> = {}, id?: string) =>
      this.store.resolveReview(
        vote.id,
        to,
        message,
        { ...patch, resolution: { at: new Date().toISOString(), to, by: "system:reconcile", message } },
        id,
      );
    let resolved: MapVoteRecord | null = null;
    if (!vote.messageId) {
      let found: string | null | undefined;
      try {
        found = await this.discord.findBallotMessage(vote);
      } catch {
        found = undefined; // Discord is unreachable; check again next tick.
      }
      if (found)
        resolved = await resolve(
          "cancelled",
          "Published late; closed without counting. A new ballot opens next round.",
          { outcome: "unposted" },
          found,
        );
      else if (found === null && Date.now() - vote.createdAt.getTime() >= UNPOSTED_MS)
        resolved = await resolve("cancelled", "The ballot could not be posted. A new ballot opens next round.", {
          outcome: "unposted",
        });
    } else if (isFiftyWinner(vote)) {
      // R3: a voted 50v50 is confirmed only by the event recorded under this ballot's ID.
      const map = mapLabel(vote.choices[vote.winner!].map);
      resolved = (await this.events.voteEvent(vote.id))
        ? await resolve("queued", "Confirmed on recheck: the 50v50 event is recorded.", { event: { id: vote.id } })
        : await resolve(
            "cancelled",
            `Confirmed on recheck: no 50v50 was recorded. ${map} plays with normal teams; the rotation was left unchanged.`,
          );
    } else {
      const queue = vote.automation?.queue;
      if (queue) {
        const fingerprint = rotationFingerprint((await this.servers.get(vote.serverId).configuration()).rotation);
        if (fingerprint === queue.after)
          resolved = await resolve("queued", "Confirmed on recheck: the winning map is saved as the next entry.");
        else if (fingerprint === queue.before)
          resolved = await resolve("cancelled", "Confirmed on recheck: the rotation was not changed. It continues.");
      }
      if (!resolved) {
        const { record } = await this.admin.receipt(vote.id, vote.serverId);
        // Every game action is recorded before it is sent, so no receipt means nothing was sent.
        if (!record) resolved = await resolve("cancelled", "No queue change was sent. The rotation continues.");
        else if (["applied", "pending"].includes(record.state))
          resolved = await resolve("queued", "Confirmed from the action receipt: the winning map is saved as next.");
        else if (record.state === "failed")
          resolved = await resolve("cancelled", `Not queued: ${record.message} The rotation continues.`, {
            outcome: "refused",
          });
      }
    }
    if (resolved) {
      this.reviewLogged.delete(vote.id);
      await this.updateMessage(resolved);
      return;
    }
    const now = Date.now();
    const alert = vote.automation?.alert;
    if (
      now - vote.updatedAt.getTime() < REVIEW_ALERT_MS ||
      (alert && (alert.count >= 2 || now - Date.parse(alert.lastAt) < ALERT_REPEAT_MS))
    )
      return;
    await this.alerts.send(
      vote.serverId,
      `map-vote-review:${vote.id}`,
      `The automatic map vote on ${vote.serverName} needs staff review: ${vote.message} Automatic voting on this server is paused until staff close it.`,
    );
    const at = new Date(now).toISOString();
    await this.store.patchAutomation(
      vote.id,
      { alert: { firstAt: alert?.firstAt ?? at, lastAt: at, count: (alert?.count ?? 0) + 1 } },
      ["needs_review"],
    );
  }
  /** Shows, and alerts staff about, a voted 50v50 that needs review. The event worker restores the lock. */
  private async watchVoteEvent(serverId: string, history: MapVoteRecord[]) {
    const linked = history.find((vote) => vote.automation?.event);
    let event: Awaited<ReturnType<ServerEventsService["voteEvent"]>> = null;
    try {
      event = linked ? await this.events.voteEvent(linked.automation!.event!.id) : null;
    } catch {
      return;
    }
    if (!linked || event?.state !== "needs_review") {
      this.eventReviews.delete(serverId);
      return;
    }
    const message = `The 50v50 chosen by the ${linked.createdAt.toISOString().slice(11, 16)} UTC ballot needs staff review: ${event.message}`;
    this.eventReviews.set(serverId, { id: linked.id, at: new Date().toISOString(), message });
    const key = `event-review:${linked.id}`;
    const previous = this.eventAlerts.get(key);
    if (previous && (previous.count >= 2 || Date.now() - previous.at < ALERT_REPEAT_MS)) return;
    if (this.eventAlerts.size > 500) this.eventAlerts.clear();
    this.eventAlerts.set(key, { count: (previous?.count ?? 0) + 1, at: Date.now() });
    await this.alerts.send(serverId, key, `${linked.serverName}: ${message}`);
  }
  private async openAutomatic(recipe: PolicyRow) {
    const serverId = this.servers.resolve(recipe.serverId);
    const { policy, settings } = readStoredPolicy(recipe.policy);
    const connection = this.servers.connectionHash(serverId);
    const history = await this.store.history(serverId);
    await this.watchVoteEvent(serverId, history);
    const active = history.find((vote) => ACTIVE_STATES.includes(vote.state));
    if (active) {
      if (active.state === "needs_review") {
        const alert = active.automation?.alert;
        this.note(
          serverId,
          `Paused: the ${active.updatedAt.toISOString().slice(11, 16)} UTC ballot needs staff review: ${active.message}`,
          {
            phase: "paused_review",
            alert: alert ? { at: alert.lastAt, message: "Staff were alerted about this ballot." } : null,
          },
        );
        return;
      }
      if (active.state === "open" && active.automation && this.automaticMessages.get(serverId)?.phase === "open")
        return;
      this.note(serverId, active.state === "open" ? "Community voting is open." : "Finishing the current ballot.", {
        phase: active.state === "open" ? "open" : "closing",
      });
      return;
    }
    // Three clean refusals in a row under the same saved controls pause until a save.
    const recent = history.filter((vote) => vote.automation && vote.connectionHash === connection).slice(0, 3);
    if (
      recent.length === REFUSAL_BRAKE &&
      recent.every(
        (vote) =>
          vote.state === "cancelled" &&
          vote.automation?.outcome === "refused" &&
          vote.automation.policyVersion === recipe.version,
      )
    ) {
      const message = `Paused after 3 refused results (${recent[0].message}). Save the voting controls to resume.`;
      this.note(serverId, message, { phase: "paused" });
      if (!recent[0].automation?.alert) {
        await this.alerts.send(serverId, `map-vote-brake:${recent[0].id}`, `${recent[0].serverName}: ${message}`);
        const at = new Date().toISOString();
        await this.store.patchAutomation(recent[0].id, { alert: { firstAt: at, lastAt: at, count: 1 } }, ["cancelled"]);
      }
      return;
    }
    const evaluation = await this.evaluate(serverId, policy, settings, history, connection, "open");
    this.note(serverId, evaluation.message, evaluation.detail);
    if (evaluation.blocked || !evaluation.ready || !evaluation.plan) return;
    const actor = await this.auth.serverStaff(
      { id: recipe.actorId, name: "Gramps automatic voting", role: "admin", csrf: "" },
      serverId,
      true,
    );
    if (actor.role !== "admin") {
      this.note(serverId, "The administrator who saved the voting controls no longer has access to this server.", {
        ...evaluation.detail,
        phase: "paused",
      });
      return;
    }
    if (this.stopped) return;
    const { ready, plan } = evaluation;
    const result = await this.start(
      actor,
      {
        id: randomUUID(),
        serverId,
        revision: ready.revision,
        choices: plan.options.map((option) => option.choice),
        minutes: 5,
        reason: "Automatic community map vote.",
      },
      {
        previousId: history[0]?.id ?? null,
        map: ready.currentMap,
        index: ready.rotation.currentIndex,
        policy,
        policyVersion: recipe.version,
        settings,
        round: ready.round,
        rotation: ready.rotation,
      },
    );
    this.note(serverId, result.state === "open" ? "Automatic community voting is open." : result.message, {
      ...evaluation.detail,
      phase: result.state === "open" ? "open" : result.state === "needs_review" ? "paused_review" : "waiting_rotation",
    });
  }
  /**
   * The automatic opening gates, in order. "open" stops at the first failure and feeds the shared round
   * tracker; "preview" records the first failure but still lists the options, without recording anything.
   */
  private async evaluate(
    serverId: string,
    policy: VotingPolicy,
    settings: VotingSettings,
    history: MapVoteRecord[],
    connection: string,
    mode: "open" | "preview",
  ): Promise<Evaluation> {
    const now = Date.now();
    const game = this.servers.get(serverId);
    const config = await game.configuration();
    const rotation = config.rotation;
    const overview = await game.overview();
    const observedAt = Date.parse(overview.observedAt);
    const result: Evaluation = { blocked: null, message: "", detail: {}, plan: null };
    /** Records the first failure; true when an opening pass should stop. */
    const block = (phase: AutomaticVotePhase, message: string) => {
      if (result.blocked === null) {
        result.blocked = message;
        result.message = message;
        result.detail.phase = phase;
      }
      return mode === "open";
    };
    const latestAutomatic = history.find((vote) => vote.automation);
    const seedRound = latestAutomatic?.automation?.round;
    const seed =
      seedRound &&
      latestAutomatic.connectionHash === connection &&
      now - latestAutomatic.createdAt.getTime() <= SEED_MAX_AGE_MS
        ? { round: seedRound, highest: latestAutomatic.automation!.highestScore }
        : null;
    let track: RoundTrack | null = null;
    let threshold = this.rounds.threshold(serverId, config.fields);
    if (Number.isFinite(observedAt)) {
      const observed =
        mode === "open"
          ? this.rounds.observe(serverId, overview, { fields: config.fields, seed })
          : this.rounds.peek(serverId, overview, { fields: config.fields, seed });
      track = observed.track;
      threshold = observed.threshold;
    }
    const players = overview.status.players?.current ?? 0;
    const required = Math.max(settings.minPlayers, threshold);
    const progress = votingProgress(overview.status);
    const positioned =
      rotation.editable && rotation.enabled && rotation.mode === "Ordered" && rotation.currentIndex !== null;
    const length = rotation.entries.length;
    const currentIndex = rotation.currentIndex ?? 0;
    const statusNextIndex = overview.status.rotation?.nextIndex;
    const lastRow = positioned && currentIndex === length - 1;
    const nextSlot = lastRow ? (statusNextIndex === 0 ? 0 : length) : currentIndex + 1;
    result.detail = {
      players: { current: players, required },
      ...(track
        ? {
            round: {
              source: track.round.source,
              elapsedSeconds: roundElapsed(track, now),
              exact: track.round.exact,
            },
          }
        : {}),
      leadingProgress: progress,
      next: positioned && nextSlot < length ? { label: selectionLabel(rotation.entries[nextSlot]) } : null,
    };
    if (!Number.isFinite(observedAt) || Math.abs(now - observedAt) > FRESH_MS)
      if (block("waiting_rotation", "Waiting for a fresh match status.")) return result;
    if (!rotation.editable || !rotation.enabled || rotation.mode !== "Ordered") {
      if (block("waiting_rotation", "Voting needs an editable, enabled, ordered rotation.")) return result;
    } else if (rotation.currentIndex === null)
      if (block("waiting_rotation", rotation.positionNote || "Waiting for a confirmed current rotation position."))
        return result;
    if (!sameMap(overview.status.map, rotation.currentMap))
      if (block("waiting_rotation", "Waiting for the rotation to match the running map.")) return result;
    if (track?.phase === "waiting")
      if (block("pre_round", `Waiting for players (${players}/${threshold}) before the round starts.`)) return result;
    if (track?.phase === "unknown" || progress === null)
      if (block("waiting_rotation", "Waiting for valid match scores.")) return result;
    if (players < required)
      if (
        block(
          "waiting_players",
          `Waiting for ${required} players before a ballot opens (${players}/${overview.status.players?.max ?? 0}).`,
        )
      )
        return result;
    const latest = history[0];
    if (latest && track && positioned && this.ballotedThisRound(latest, track, connection, config, overview))
      if (block("done_this_round", "This round already had a ballot. Waiting for the next round.")) return result;
    if (latestAutomatic && now - latestAutomatic.createdAt.getTime() < BALLOT_GAP_MS)
      if (block("done_this_round", "Waiting at least 10 minutes between automatic ballots.")) return result;
    if (progress !== null && (progress >= settings.openScoreCeiling || track?.ended))
      if (block("too_late", "Too late in this round; the next round gets a ballot.")) return result;
    if (track) {
      // Exact rounds count from the observed start; after a restart or gap, from the first observation.
      const elapsed = roundElapsed(track, now) ?? observedElapsed(track, now);
      if (elapsed < settings.openDelaySeconds)
        if (
          block(
            "waiting_delay",
            `Opens in ${duration(settings.openDelaySeconds - elapsed)}, ${settings.openDelaySeconds} seconds into the round.`,
          )
        )
          return result;
    }
    if (!positioned) return result;
    if (lastRow && statusNextIndex !== 0)
      if (
        block(
          "waiting_rotation",
          "The game has not confirmed it returns to entry 1 after the last entry; skipping this ballot so the rotation does not grow.",
        )
      )
        return result;
    const checked = await game.checkRotation();
    if (checked.revision !== config.revision || checked.issues.some((issue) => !issue.unavailable))
      throw new Error("Rotation options could not be checked.");
    let fifty: { ready: boolean; reason: string } | undefined;
    if (settings.fiftyFifty.offered)
      try {
        const readiness = await this.events.voteEventReadiness(
          serverId,
          settings.fiftyFifty,
          config,
          overview,
          track,
          ballotRounds(history),
        );
        fifty = readiness.ok ? { ready: true, reason: "" } : { ready: false, reason: readiness.reason };
      } catch {
        fifty = { ready: false, reason: "its checks could not be read" };
      }
    const plan = buildBallot({
      policy,
      settings,
      rotation: { entries: rotation.entries, currentIndex },
      issues: checked.issues,
      statusNextIndex,
      history: history.map((vote) => ({ currentMap: vote.currentMap, automatic: !!vote.automation })),
      unavailablePool: settings.source === "pool" ? await this.unavailablePool(game, settings.pool) : undefined,
      fifty,
    });
    result.plan = plan;
    result.detail.fifty = plan.fifty;
    if (plan.options.length < 2 && block("waiting_rotation", plan.notes[0])) return result;
    if (result.blocked || !track) return result;
    result.message = "Opening a ballot.";
    result.detail.phase = "open";
    result.ready = {
      revision: config.revision,
      currentMap: rotation.currentMap,
      round: { ...track.round },
      rotation: {
        fingerprint: rotationFingerprint(rotation),
        length,
        currentIndex,
        nextSlot: plan.nextSlot,
        nextKey: plan.next ? voteChoiceKey(plan.next) : null,
        ...(plan.next ? { nextLabel: voteChoiceTitle(plan.next) } : {}),
      },
    };
    return result;
  }
  private async unavailablePool(game: WardogsClient, pool: MapSelection[]) {
    const unavailable = new Set<string>();
    if (!pool.length) return unavailable;
    const capabilities = await game.capabilities(),
      catalog = await game.catalog(),
      reads = new Map<string, Promise<unknown>>();
    for (const entry of pool)
      try {
        await validateMapSelection(game, entry, capabilities, catalog, reads);
      } catch (error) {
        // Only a confirmed unavailable entry is skipped; anything uncertain stops this pass.
        if (!(error instanceof UnavailableSelection)) throw error;
        unavailable.add(voteChoiceKey(entry));
      }
    return unavailable;
  }
  /** One automatic ballot per round. Unobserved rounds and older ballots use the rotation position. */
  private ballotedThisRound(
    latest: MapVoteRecord,
    track: RoundTrack,
    connection: string,
    config: Awaited<ReturnType<WardogsClient["configuration"]>>,
    overview: Awaited<ReturnType<WardogsClient["overview"]>>,
  ) {
    if (latest.connectionHash !== connection) return false;
    const round = latest.automation?.round;
    if (round && track.round.source !== "baseline") return round.id === track.round.id;
    if (latest.currentIndex !== config.rotation.currentIndex || !sameMap(latest.currentMap, config.rotation.currentMap))
      return false;
    if (round) return true;
    const clock = roundStamp(overview.status, Date.parse(overview.observedAt));
    return (
      !clock ||
      !latest.roundStartedAt ||
      sameRound(clock, { map: latest.currentMap, startedAt: latest.roundStartedAt.getTime() })
    );
  }
  private async cancelAutomatic(vote: MapVoteRecord, reason: string) {
    this.lastScores.delete(vote.id);
    const cancelled = await this.store.cancel(
      vote.id,
      randomUUID(),
      { id: vote.actorId, name: "Gramps", role: "admin", csrf: "", serverId: vote.serverId },
      reason,
      reason,
    );
    await this.updateMessage(cancelled);
  }
  private async observeAutomatic(vote: MapVoteRecord) {
    const automation = vote.automation;
    if (!automation) return;
    const saved = await this.store.policy(vote.serverId);
    const configured = this.options();
    if (
      !saved?.policy.enabled ||
      saved.connectionHash !== vote.connectionHash ||
      vote.connectionHash !== this.servers.connectionHash(vote.serverId) ||
      vote.guildId !== configured.guildId ||
      vote.channelId !== configured.channelId
    ) {
      await this.cancelAutomatic(vote, "Automatic voting is off or the server connection changed.");
      return;
    }
    const settings = automationSettings(automation);
    const game = this.servers.get(vote.serverId);
    const config = await game.configuration();
    const overview = await game.overview();
    const observedAt = Date.parse(overview.observedAt);
    let track: RoundTrack | null = null;
    if (automation.rotation && automation.round) {
      // Only the rotation itself matters: settings or whitelist saves change the revision, not the vote.
      if (
        rotationFingerprint(config.rotation) !== automation.rotation.fingerprint ||
        (config.rotation.currentIndex !== null &&
          (config.rotation.currentIndex !== vote.currentIndex || !sameMap(config.rotation.currentMap, vote.currentMap)))
      ) {
        await this.cancelAutomatic(vote, "Staff changed the rotation. Votes were not applied.");
        return;
      }
      if (Number.isFinite(observedAt)) {
        track = this.rounds.observe(vote.serverId, overview, {
          fields: config.fields,
          seed: { round: automation.round, highest: automation.highestScore },
        }).track;
        if (track.round.id !== automation.round.id || !sameMap(overview.status.map, vote.currentMap)) {
          await this.cancelAutomatic(vote, "The match ended before voting closed. The rotation continues.");
          return;
        }
      }
    } else {
      // Ballots opened before customizable settings keep the original revision and clock rule.
      const round = roundStamp(overview.status, observedAt);
      if (
        config.revision !== vote.revision ||
        config.rotation.currentIndex !== vote.currentIndex ||
        !sameMap(config.rotation.currentMap, vote.currentMap) ||
        !sameMap(overview.status.map, vote.currentMap) ||
        (vote.roundStartedAt &&
          (!round || !sameRound(round, { map: vote.currentMap, startedAt: vote.roundStartedAt.getTime() })))
      ) {
        await this.cancelAutomatic(vote, "The match or staff rotation changed. The rotation was left unchanged.");
        return;
      }
    }
    const fresh = Number.isFinite(observedAt) && Math.abs(Date.now() - observedAt) <= FRESH_MS;
    const progress = fresh ? votingProgress(overview.status) : null;
    if (progress === null) {
      this.note(vote.serverId, "Waiting for fresh match scores. Voting remains open.", { phase: "open" });
      return;
    }
    this.note(vote.serverId, `Voting is open. Leading score: ${progress}/100; closes at ${settings.closeAtScore}.`, {
      phase: "open",
      leadingProgress: progress,
    });
    if (progress >= 100 || progress < automation.highestScore) {
      await this.cancelAutomatic(vote, "The match ended before voting closed. The rotation continues.");
      return;
    }
    const previous = this.lastScores.get(vote.id);
    const step =
      previous && observedAt - previous.at <= STEP_SAMPLE_MS && progress > previous.score
        ? progress - previous.score
        : null;
    if (this.lastScores.size > 100) this.lastScores.clear();
    this.lastScores.set(vote.id, { at: observedAt, score: progress });
    if (!(await this.store.observeScore(vote.id, progress, step)) || this.stopped) return;
    const current = {
      ...automation,
      highestScore: Math.max(automation.highestScore, progress),
      maxStep: automation.settings ? Math.max(automation.maxStep ?? 0, step ?? 0) : 0,
    };
    if (current.highestScore >= closeThreshold(current).early) this.fast = true;
    if (closeReached(current, progress)) {
      const claimed = await this.store.claimClose(vote.id, true);
      if (claimed) await this.close(claimed);
      return;
    }
    if (track?.phase === "waiting") return;
    // The reminder reached is the highest-scoring one switched on, both now and when the ballot opened.
    // If observations jump past both milestones, only the later one is sent.
    const field = (stage: VoteReminder) => (stage === "midpoint" ? "midpointReminder" : "finalReminder");
    const stage =
      (["midpoint", "final"] as const)
        .filter(
          (slot) =>
            saved.policy[field(slot)] && automation.policy[field(slot)] && progress >= settings.reminders[slot].score,
        )
        .sort((a, b) => settings.reminders[b].score - settings.reminders[a].score)[0] ?? null;
    if (!stage) return;
    const slot = settings.reminders[stage];
    // A reminder whose score had already passed when the ballot opened is skipped.
    if ((automation.openedAtScore ?? -1) >= slot.score) return;
    const actor = await this.auth.serverStaff(
      { id: vote.actorId, name: vote.actorName, role: "admin", csrf: "" },
      vote.serverId,
      true,
    );
    if (actor.role !== "admin" || this.stopped) return;
    const claimed = await this.store.claimReminder(vote.id, stage, randomUUID());
    if (!claimed?.automation) return;
    const id = claimed.automation.reminders[stage]!.id;
    try {
      const totals = await this.store.liveCounts([vote.id]);
      const counts = vote.choices.map((_, index) => totals.find((row) => row.choice === index)?.total ?? 0);
      const total = counts.reduce((sum, value) => sum + value, 0);
      const maximum = Math.max(0, ...counts);
      const leaders = counts.flatMap((count, index) => (count === maximum ? [index] : []));
      const tally = !total
        ? "No votes yet"
        : leaders.length === 1
          ? `${plainLabel(voteChoiceTitle(vote.choices[leaders[0]]), 65)} leads ${maximum}/${total}`
          : `Tied at ${maximum} votes (${total} total)`;
      const channel = await this.discord.check(vote.guildId, vote.channelId);
      const message = fitBroadcast(
        `${stage === "final" ? "Last chance" : "Next round vote"}: ${tally}. Choose in Discord #${plainLabel(channel.name, 35)}. Closes at ${settings.closeAtScore} points.`,
      );
      const stillOn = async () => {
        const current = await this.store.policy(vote.serverId);
        return (
          !!current?.policy.enabled &&
          !!current.policy[field(stage)] &&
          (await this.store.get(vote.id))?.state === "open" &&
          !this.stopped
        );
      };
      if (!(await stillOn())) throw new Error("Voting was stopped before sending.");
      if (slot.discord) {
        await this.discord.remind({ ...vote, counts }, stage);
        if (!(await stillOn())) throw new Error("Voting stopped before the in-game reminder.");
      }
      if (slot.inGame) {
        const result = await this.admin.act(this.sayActor(actor, vote.serverId), {
          id,
          action: "broadcast",
          reason: `Map vote ${stage} totals`,
          message,
        });
        await this.store.finishReminder(
          vote.id,
          stage,
          result.state,
          slot.discord ? result.message : `In game only. ${result.message}`,
        );
      } else await this.store.finishReminder(vote.id, stage, "applied", "Sent in Discord only.");
    } catch {
      await this.store.finishReminder(
        vote.id,
        stage,
        "unknown",
        "Reminder delivery was not confirmed. Check its receipt; it will not be repeated.",
      );
    }
  }
  /** Sends the winning map. A clean refusal closes the ballot; only an unconfirmed write needs review. */
  private async queueWinner(actor: Staff, request: Extract<AdminAction, { action: "map-next" }>) {
    let result: Awaited<ReturnType<AdminService["act"]>>;
    try {
      result = await this.admin.act(actor, request);
    } catch (error) {
      // Every exception act() raises happens before anything is sent to the game.
      if (error instanceof HttpException)
        return {
          state: "cancelled" as const,
          message: `Not queued: ${error.message} The rotation continues.`,
          patch: { outcome: "refused" as const },
        };
      return {
        state: "needs_review" as const,
        message: "The queue result is unconfirmed. Gramps is rechecking the rotation and action receipt.",
      };
    }
    if (result.state === "applied" || result.state === "pending")
      return {
        state: "queued" as const,
        message: "The winning map was saved in the next rotation position. The current match continues.",
      };
    if (result.state === "failed")
      return {
        state: "cancelled" as const,
        message: `Not queued: ${result.message} The rotation continues.`,
        patch: { outcome: "refused" as const },
      };
    return { state: "needs_review" as const, message: result.message };
  }
  private async close(vote: MapVoteRecord) {
    const automation = vote.automation;
    const current = !!automation?.rotation && !!automation.round;
    let state: FinishState = "cancelled";
    let message =
      "The position, settings, connection or staff access changed or could not be read. The ballot closed without sending a queue change.";
    let patch: Partial<VoteAutomation> | undefined;
    let actor: Staff | null = null;
    try {
      if (vote.winner === null) {
        const tied = vote.counts.some((count) => count > 0);
        state = tied ? "tied" : "no_votes";
        message = tied
          ? "The vote tied. The saved rotation was left unchanged."
          : "No votes were cast. The rotation was left unchanged.";
      } else {
        const configured = this.enabled();
        if (
          vote.connectionHash !== this.servers.connectionHash(vote.serverId) ||
          vote.guildId !== configured.guildId ||
          vote.channelId !== configured.channelId
        )
          throw new Error("Ballot connection changed.");
        actor = await this.auth.serverStaff(
          { id: vote.actorId, name: vote.actorName, role: "admin", csrf: "" },
          vote.serverId,
          true,
        );
        if (actor.role !== "admin") throw new Error("Creator no longer authorized.");
        const game = this.servers.get(vote.serverId);
        const settings = await game.configuration();
        const rotation = settings.rotation;
        if (
          (current
            ? rotationFingerprint(rotation) !== automation.rotation!.fingerprint
            : settings.revision !== vote.revision) ||
          rotation.currentIndex !== vote.currentIndex ||
          !sameMap(rotation.currentMap, vote.currentMap)
        )
          throw new Error("Rotation changed.");
        const overview = await game.overview();
        const observedAt = Date.parse(overview.observedAt);
        if (automation) {
          const progress = votingProgress(overview.status);
          if (
            progress === null ||
            !closeReached(automation, progress) ||
            progress >= 100 ||
            Math.abs(Date.now() - observedAt) > FRESH_MS
          )
            throw new Error("Score cutoff no longer confirmed.");
        }
        if (!Number.isFinite(observedAt) || !sameMap(overview.status.map, vote.currentMap) || this.stopped)
          throw new Error("Round cannot be confirmed.");
        if (current) {
          const track = this.rounds.observe(vote.serverId, overview, {
            fields: settings.fields,
            seed: { round: automation.round!, highest: automation.highestScore },
          }).track;
          if (track.round.id !== automation.round!.id) throw new Error("Round changed.");
        } else {
          // Manual and older ballots keep the elapsed-clock rule.
          const seconds = overview.status.matchSeconds;
          const roundStart =
            typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
              ? observedAt - seconds * 1000
              : null;
          if (
            vote.roundStartedAt !== null &&
            (roundStart === null || Math.abs(roundStart - vote.roundStartedAt.getTime()) > 30_000)
          )
            throw new Error("Round cannot be confirmed.");
        }
        const policyRow = automation ? await this.store.policy(vote.serverId) : null;
        if (automation && !policyRow?.policy.enabled) throw new Error("Voting switched off.");
        if ((await this.store.get(vote.id))?.state !== "closing" || this.stopped) return;
        const winner = vote.choices[vote.winner];
        const entry = stripEvent(winner);
        if (winner.event === "50v50") {
          if (!current) throw new Error("Only automatic ballots can start a 50v50.");
          // No queue change: the next rotation entry plays as 50v50.
          ({ state, message, patch } = await this.startFifty(
            vote,
            { ...actor, name: policyRow?.actorName || actor.name },
            overview.status.players?.current ?? 0,
          ));
        } else if (current) {
          const plan = planMapNext(
            rotation.entries,
            rotation.currentIndex!,
            overview.status.rotation?.nextIndex,
            entry,
          );
          // The ballot was planned for this next slot and never appends; after the last entry, a fresh
          // read that no longer confirms the wrap to entry 1 would append a duplicate row instead.
          if (plan.placement === "append" || plan.nextSlot !== automation.rotation!.nextSlot) {
            state = "cancelled";
            message =
              "The game no longer confirms it returns to entry 1 after the last entry, so the winner was not queued. The rotation continues.";
          } else if (plan.placement === "already-next") {
            state = "queued";
            message = `${voteChoiceTitle(winner)} was already next. The rotation was left unchanged.`;
          } else {
            const queue = {
              receiptId: vote.id,
              before: rotationFingerprint(rotation),
              after: rotationFingerprint({ ...rotation, entries: plan.entries }),
              kind: plan.placement,
            };
            if (!(await this.store.patchAutomation(vote.id, { queue }, ["closing"]))) return;
            ({ state, message, patch } = await this.queueWinner(this.queueActor(actor, vote.serverId), {
              id: vote.id,
              action: "map-next",
              reason: `Discord map vote ${vote.id}`,
              // The fresh revision: the game's If-Match still refuses a concurrent edit cleanly.
              revision: settings.revision,
              currentIndex: vote.currentIndex,
              currentMap: vote.currentMap,
              entry,
              nextSlot: plan.nextSlot,
            }));
          }
        } else
          ({ state, message, patch } = await this.queueWinner(actor, {
            id: vote.id,
            action: "map-next",
            reason: `Discord map vote ${vote.id}`,
            revision: vote.revision,
            currentIndex: vote.currentIndex,
            currentMap: vote.currentMap,
            entry,
          }));
      }
    } catch {
      state = "cancelled";
    }
    this.lastScores.delete(vote.id);
    const finished = patch
      ? await this.store.finish(vote.id, state, message, patch)
      : await this.store.finish(vote.id, state, message);
    if (!finished) return;
    await this.updateMessage(finished);
    if (current) await this.announceResult(finished, actor);
  }
  /**
   * Starts the 50v50 a ballot chose, or explains why normal teams continue. Only an error after the
   * event may have been recorded needs review, and the review recheck reads the event store.
   */
  private async startFifty(vote: MapVoteRecord, actor: Staff, players: number): Promise<Finish> {
    const fifty = automationSettings(vote.automation!).fiftyFifty;
    const votes = vote.counts[vote.winner!] ?? 0;
    const total = vote.counts.reduce((sum, count) => sum + count, 0);
    const map = mapLabel(vote.choices[vote.winner!].map);
    const normal = (reason: string): Finish => ({
      state: "cancelled",
      message: `50v50 won but ${reason}. The rotation continues with normal teams.`,
    });
    if (votes < fifty.minVotes) return normal(`it needed ${fifty.minVotes} votes and had ${votes}`);
    const floor = Math.max(0, fifty.minPlayers - FIFTY_CLOSE_ALLOWANCE);
    if (players < floor) return normal(`only ${players} players are online (${floor} needed)`);
    const end = fifty.autoEnd
      ? `normal teams return after ${fifty.rounds} round${fifty.rounds === 1 ? "" : "s"}`
      : "normal teams return when staff stop it";
    const queued: Finish = {
      state: "queued",
      message: `50v50 chosen (${votes} of ${total} votes). Next round on ${map} runs as 50v50; teams are sorted at round start; ${end}.`,
      patch: { event: { id: vote.id } },
    };
    try {
      await this.events.startFromVote({
        voteId: vote.id,
        serverId: vote.serverId,
        actor,
        fifty,
        minPlayers: floor,
        votes,
        total,
        label: map,
      });
      return queued;
    } catch (error) {
      // Readiness at the close is not a queue refusal, so it never pauses automatic voting.
      if (error instanceof HttpException)
        return {
          state: "cancelled",
          message: `50v50 could not start: ${withoutStop(error.message)}. ${map} plays with normal teams; the rotation was left unchanged.`,
          patch: { outcome: "fifty_unready" },
        };
      try {
        if (await this.events.voteEvent(vote.id)) return queued;
      } catch {
        /* The review recheck reads the event store again. */
      }
      return {
        state: "needs_review",
        message: "The 50v50 start is unconfirmed. Gramps is checking whether its event was recorded.",
      };
    }
  }
  /** One in-game result notice for queued, tied or no-vote automatic ballots. Never retried. */
  private async announceResult(vote: MapVoteRecord, verified: Staff | null) {
    const settings = automationSettings(vote.automation!);
    if (!settings.announce.resultInGame || !["queued", "tied", "no_votes"].includes(vote.state)) return;
    // A voted 50v50 is announced by its event's own notice.
    if (vote.state === "queued" && isFiftyWinner(vote)) return;
    try {
      const actor =
        verified ??
        (await this.auth.serverStaff(
          { id: vote.actorId, name: vote.actorName, role: "admin", csrf: "" },
          vote.serverId,
          true,
        ));
      if (actor.role !== "admin" || this.stopped) return;
      const next = vote.automation!.rotation?.nextLabel;
      const continues = `the rotation continues${next ? ` with ${plainLabel(next, 60)}` : ""}.`;
      const total = vote.counts.reduce((sum, count) => sum + count, 0);
      const message =
        vote.state === "queued" && vote.winner !== null
          ? `Vote result: ${gameLabel(vote.choices[vote.winner], 60)} is next (${vote.counts[vote.winner] ?? 0} of ${total} votes).`
          : vote.state === "tied"
            ? `Vote tied: ${continues}`
            : `No votes were cast: ${continues}`;
      await this.admin.act(this.sayActor(actor, vote.serverId), {
        id: randomUUID(),
        action: "broadcast",
        reason: `Map vote ${vote.id} result`,
        message: fitBroadcast(message),
      });
    } catch {
      this.logger.warn("The in-game vote result could not be sent. It is not retried.");
    }
  }
  private async updateMessage(vote: MapVoteRecord) {
    const configured = this.options();
    if (vote.guildId !== configured.guildId || vote.channelId !== configured.channelId) return;
    try {
      await this.discord.update(vote);
    } catch {
      this.logger.warn(
        "The saved map-vote result could not be shown in Discord. Use the staff dashboard for its status.",
      );
    }
  }
}
