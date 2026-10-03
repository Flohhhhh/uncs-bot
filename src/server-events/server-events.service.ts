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
import { actionSchema, type ActionResult, type Staff } from "../admin/admin.types";
import { GameRounds } from "../admin/game-rounds";
import { GameServers } from "../admin/game-servers";
import type { WardogsClient } from "../admin/wardogs.client";
import { serves } from "../common/admin-policy";
import type { RoundTrack } from "../common/round-tracker";
import type { SettingsSnapshot } from "../common/server-settings";
import { FIFTY_HELD_REASON, type FiftyFiftySettings } from "../common/voting-policy";
import { EnvService } from "../env/env.service";
import { plainLabel } from "../server-community/community-state";
import { StaffAlerts } from "../staff-alerts/staff-alerts.service";
import {
  RETRY_LIMIT,
  completeEventOperation,
  eventRoster,
  operation,
  planEvent,
  voteTeams,
  type EventStopReason,
} from "./event-planner";
import { ServerEventsStore } from "./server-events.store";
import {
  eventView,
  isVoteEvent,
  observedRound,
  restoreEventSchema,
  sameRound,
  startEventSchema,
  stopEventSchema,
  systemStops,
  trackedEventProgress,
  type EventOperation,
  type EventOptions,
  type EventProgress,
  type EventRecord,
  type EventSnapshot,
  type EventState,
} from "./server-events.types";

type Configuration = Awaited<ReturnType<WardogsClient["configuration"]>>;
type LockField = SettingsSnapshot["fields"][number] | undefined;
type Update = { state: EventState; progress: EventProgress; message: string };
type SystemStop = EventStopReason | "lock_changed";
/** At most one recorded effect per pass. */
type Step =
  | { kind: "op"; op: EventOperation; progress: EventProgress }
  | { kind: "observe"; update: Update }
  | { kind: "stop"; reason: SystemStop; message: string }
  | { kind: "halt"; reason: string }
  | { kind: "problem"; message: string; progress?: EventProgress; alert?: { key: string; message: string } }
  | { kind: "complete"; message: string };
type Outcome = {
  state: EventState;
  progress: EventProgress;
  restoreRevision?: string | null;
  halt?: string | null;
  message?: string;
};
export type VoteEventReadiness = { ok: true } | { ok: false; reason: string };
export type VoteEventStart = {
  voteId: string;
  serverId: string;
  /** The administrator who saved the voting controls, verified for this server. */
  actor: Staff;
  fifty: FiftyFiftySettings;
  /**
   * Players needed when the ballot closes: the offer minimum less an allowance for players who leave as
   * the voted round ends. Defaults to the offer minimum.
   */
  minPlayers?: number;
  votes: number;
  total: number;
  /** The rotation entry that plays as 50v50. */
  label: string;
};
/**
 * When a winning ballot starts the event: `minPlayers` replaces the offer minimum, and a roster that is
 * still settling (unlinked identities, or a roster count that differs from the player count for one
 * read) is left to the planner, which waits on it and stops the event if it stays unsafe.
 */
type ReadinessAtClose = { minPlayers?: number; atClose?: boolean };

const MINUTE = 60_000;
const INTERRUPTED_MS = 2 * MINUTE;
const LOCK_ALERT_MS = 5 * MINUTE;
const LOCK_REVIEW_MS = 30 * MINUTE;
const RESTORE_ATTEMPTS = 5;
const RESTORE_GAP_MS = MINUTE;
const WATCHDOG_MS = 5 * MINUTE;
const WATCHDOG_WINDOW_MS = 24 * 60 * MINUTE;
const ALERT_REPEAT_MS = 30 * MINUTE;
/** A Discord outage reuses an administrator confirmation this recent; a refusal never does. */
const ACCESS_GRACE_MS = 5 * MINUTE;
const stopMessages: Record<SystemStop, string> = {
  rounds: "The voted 50v50 round(s) finished.",
  roster: "The closed team was not playing this round, so the 50v50 ended.",
  population: "The server waited for players for five minutes, so the 50v50 ended.",
  lock_changed: "Staff switched the team lock back on during the 50v50.",
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

@Injectable()
export class ServerEventsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ServerEventsService.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  /**
   * The worker starts in this service's bootstrap hook, which runs after the Discord sign-in, but the dashboard
   * answers before it. Until then no event is armed, so none waits unwatched and starts late.
   */
  private workerStarted = false;
  private readonly running = new Set<string>();
  private readonly alerted = new Map<string, { count: number; at: number }>();
  private readonly watched = new Map<string, number>();
  private readonly lockOffAlerted = new Set<string>();
  private readonly confirmedAdmins = new Map<string, { staff: Staff; at: number }>();
  constructor(
    private readonly store: ServerEventsStore,
    private readonly servers: GameServers,
    private readonly admin: AdminService,
    private readonly auth: AdminAuth,
    private readonly env: EnvService,
    private readonly rounds: GameRounds,
    private readonly alerts: StaffAlerts,
  ) {}
  private enabled() {
    return this.env.get("SERVER_EVENTS_ENABLED") === true;
  }
  /** Voted 50v50 has its own owner-only flag; SERVER_EVENTS_ENABLED alone only allows staff-run events. */
  private voteEventsHeld() {
    return this.env.get("MAP_VOTES_FIFTY_ENABLED") !== true;
  }
  private staff(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can manage optional events.");
  }
  private available() {
    if (!this.enabled())
      throw new ServiceUnavailableException("Optional events need owner setup and a reviewed database migration.");
  }
  private connected(event: EventRecord) {
    return (
      event.connectionHash === this.servers.connectionHash(event.serverId) &&
      event.guildId === this.env.get("ADMIN_GUILD_ID")
    );
  }
  private async selectedEvent(staff: Staff, id: string) {
    const serverId = this.servers.resolve(staff.serverId);
    const event = await this.store.get(id);
    if (!event || event.serverId !== serverId) throw new BadRequestException("Choose an event on the selected server.");
    return event;
  }
  /** Feeds the shared round tracker; a restarted process continues the event's stored round. */
  private observeRound(event: EventRecord, snapshot: EventSnapshot, fields?: SettingsSnapshot["fields"]) {
    const tracker = event.progress.tracker;
    return this.rounds.observe(event.serverId, snapshot, {
      fields,
      seed: tracker ? { round: tracker.round, highest: tracker.highest } : null,
    }).track;
  }
  async list(staff: Staff) {
    this.staff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    const enabled = this.enabled();
    return {
      enabled,
      serverId,
      events: enabled ? (await this.store.history(serverId)).map(eventView) : [],
    };
  }
  async history(staff: Staff, id: string) {
    this.staff(staff);
    this.available();
    if (!z.uuid().safeParse(id).success) throw new BadRequestException("Choose a valid event.");
    await this.selectedEvent(staff, id);
    // Reasons/actions are staff-only. No config documents, credentials or live-game request is involved.
    return { operations: await this.store.operations(id) };
  }
  async start(staff: Staff, input: unknown) {
    this.staff(staff);
    this.available();
    if (!this.workerStarted)
      throw new ServiceUnavailableException("Gramps is still starting. No event was created. Try again shortly.");
    const parsed = startEventSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        "Choose two current teams, a 15–240 minute duration, warning/balance windows and the start confirmation.",
      );
    const {
      id,
      serverId,
      revision,
      reason,
      teams,
      durationMinutes,
      warningSeconds,
      balanceWindowSeconds,
      forceRespawn,
    } = parsed.data;
    if (serverId !== this.servers.resolve(staff.serverId))
      throw new BadRequestException("The event must target the selected server.");
    const options = { teams, durationMinutes, warningSeconds, balanceWindowSeconds, forceRespawn };
    const requestHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    const previous = await this.store.get(id);
    if (previous) {
      if (previous.serverId !== serverId || previous.actorId !== staff.id || previous.requestHash !== requestHash)
        throw new ConflictException("This event ID was already used for a different request.");
      return eventView(previous);
    }
    const guildId = this.env.get("ADMIN_GUILD_ID");
    if (!guildId) throw new ServiceUnavailableException("The staff community is not configured.");
    const game = this.servers.get(serverId);
    const settings = await game.configuration();
    if (settings.revision !== revision)
      throw new ConflictException(
        "Refresh settings. The team lock must be readable, and editable if it is currently on.",
      );
    const { lock, snapshot, track } = await this.prepare(serverId, game, settings, { forceRespawn, messages: true });
    try {
      eventRoster({ options }, snapshot);
    } catch (error) {
      throw new ConflictException((error as Error).message);
    }
    if (this.stopped) throw new ServiceUnavailableException("Gramps is stopping. No event was created.");
    const now = new Date();
    const started = await this.store.create({
      id,
      serverId,
      serverName: snapshot.status.serverName,
      connectionHash: this.servers.connectionHash(serverId),
      guildId,
      actorId: staff.id,
      actorName: staff.name,
      reason,
      requestHash,
      options,
      originalLock: lock,
      initialRevision: revision,
      progress: trackedEventProgress(track, now.getTime()),
      createdAt: now,
      updatedAt: now,
      endsAt: new Date(now.getTime() + options.durationMinutes * 60_000),
    });
    return eventView(started.event);
  }
  /**
   * Checks shared by staff and vote starts: a readable lock (editable if on), a live round (the match
   * clock is used when reported, never required), a stable roster and the game routes the event needs.
   */
  private async prepare(
    serverId: string,
    game: WardogsClient,
    settings: Configuration,
    needs: { forceRespawn: boolean; messages: boolean },
  ) {
    const lock = settings.fields.find((field) => field.id === "lockOverpopulated");
    if (typeof lock?.value !== "boolean" || (lock.value && !lock.editable))
      throw new ConflictException(
        "Refresh settings. The team lock must be readable, and editable if it is currently on.",
      );
    const snapshot = await game.overview();
    const track = this.rounds.observe(serverId, snapshot, { fields: settings.fields }).track;
    if (track.phase !== "live" || !Number.isFinite(Date.parse(snapshot.observedAt)))
      throw new ConflictException(
        track.phase === "waiting"
          ? "The server is waiting for players before its round starts. Arm the event once the round is live."
          : "The current round could not be confirmed from the match status. Refresh before arming the event.",
      );
    if (snapshot.players.length !== snapshot.status.players.current)
      throw new ConflictException("The roster is changing. Refresh before arming the event.");
    const capabilities = snapshot.capabilities;
    const routes = [
      ["PATCH", "/v1/players/{id}"],
      ["POST", "/v1/broadcast"],
      ...(needs.messages ? [["POST", "/v1/players/{id}/message"]] : []),
      ...(needs.forceRespawn ? [["POST", "/v1/players/{id}/kill"]] : []),
      ...(lock.value ? [["PUT", "/v1/config"]] : []),
    ];
    if (routes.some(([method, path]) => !serves(capabilities, method, path)))
      throw new ConflictException("The current game build does not advertise all controls needed by this event.");
    const allowance = capabilities.limits?.maxRequestsPerMinutePerIp;
    if (allowance && allowance < 30)
      throw new ConflictException(
        "The reported game request allowance is too low for this event's observation and move checks.",
      );
    return { lock: lock.value, snapshot, track };
  }
  /**
   * Whether a ballot may offer 50v50 now. The reason is a short phrase for "50v50 not offered: …".
   * `ballots` (automatic ballots, newest first) applies the cooldown after the last vote-started event.
   */
  async voteEventReadiness(
    serverId: string,
    fifty: FiftyFiftySettings,
    configuration: Pick<Configuration, "fields">,
    overview: EventSnapshot,
    track: RoundTrack | null,
    ballots?: { roundId?: string; createdAt: Date }[],
    close: ReadinessAtClose = {},
  ): Promise<VoteEventReadiness> {
    const no = (reason: string): VoteEventReadiness => ({ ok: false, reason });
    if (this.voteEventsHeld()) return no(FIFTY_HELD_REASON);
    if (!this.enabled()) return no("optional events are off in Gramps");
    if (!this.env.get("ADMIN_GUILD_ID")) return no("the staff community is not configured");
    if (await this.store.current(serverId)) return no("another optional event is active or needs review");
    if (ballots && fifty.cooldownRounds > 0) {
      const last = (await this.store.history(serverId)).find((event) => isVoteEvent(event));
      if (last) {
        const since = last.updatedAt.getTime();
        const played = new Set(
          ballots
            .filter((ballot) => ballot.roundId && ballot.createdAt.getTime() > since)
            .map((ballot) => ballot.roundId),
        ).size;
        if (played < fifty.cooldownRounds)
          return no(`${plural(fifty.cooldownRounds - played, "more normal round")} before 50v50 can return`);
      }
    }
    const lock = configuration.fields.find((field) => field.id === "lockOverpopulated");
    if (typeof lock?.value !== "boolean") return no("the team lock cannot be read");
    if (lock.value && !lock.editable) return no("the team lock is on and cannot be edited");
    const capabilities = overview.capabilities;
    const missing = [
      ["PATCH", "/v1/players/{id}", "team moves"],
      ["POST", "/v1/broadcast", "broadcasts"],
      ...(lock.value ? [["PUT", "/v1/config", "settings saves"]] : []),
      ...(fifty.forceRespawn ? [["POST", "/v1/players/{id}/kill", "forced respawns"]] : []),
    ].filter(([method, path]) => !serves(capabilities, method, path));
    if (missing.length) return no(`the game build does not advertise ${missing.map((route) => route[2]).join(" or ")}`);
    const allowance = capabilities.limits?.maxRequestsPerMinutePerIp;
    if (allowance && allowance < 30) return no("the game's request allowance is too low");
    if (track?.phase !== "live")
      return no(track?.phase === "waiting" ? "the server is waiting for players" : "the round is not confirmed");
    const factions = overview.status.factionScores.map((faction) => faction.name);
    if (factions.length !== 3 || new Set(factions).size !== 3) return no("the game does not report three teams");
    if (fifty.closedFaction && !factions.includes(fifty.closedFaction))
      return no(`${plainLabel(fifty.closedFaction, 30)} is not playing`);
    if (!close.atClose) {
      try {
        eventRoster({ options: { ...this.voteOptionsBase(fifty), source: { kind: "vote", voteId: "" } } }, overview);
      } catch {
        return no("the roster has unlinked, duplicate or unassigned players, or more than 100 places");
      }
      if (overview.players.length !== overview.status.players.current) return no("the roster is still changing");
    }
    const minPlayers = close.minPlayers ?? fifty.minPlayers;
    if (overview.status.players.current < minPlayers)
      return no(`${overview.status.players.current} of ${minPlayers} players online`);
    return { ok: true };
  }
  private voteOptionsBase(fifty: FiftyFiftySettings) {
    return {
      teams: ["", ""] as [string, string],
      durationMinutes: 15 + fifty.rounds * fifty.maxRoundMinutes,
      warningSeconds: fifty.warningSeconds,
      balanceWindowSeconds: fifty.balanceWindowSeconds,
      forceRespawn: fifty.forceRespawn,
    };
  }
  /**
   * Arms the 50v50 a ballot chose. The event ID is the ballot ID, so this is idempotent. Neither the
   * match clock nor a reviewed settings revision is needed. A clean refusal throws an HttpException
   * before anything is recorded.
   */
  async startFromVote(input: VoteEventStart) {
    if (this.voteEventsHeld()) throw new ServiceUnavailableException(sentence(FIFTY_HELD_REASON));
    if (!this.enabled()) throw new ServiceUnavailableException("Optional events are off in Gramps.");
    const previous = await this.store.get(input.voteId);
    if (previous) {
      if (previous.serverId !== input.serverId || previous.options.source?.voteId !== input.voteId)
        throw new ConflictException("This ballot's event ID was already used for another event.");
      return { created: false, event: eventView(previous) };
    }
    const guildId = this.env.get("ADMIN_GUILD_ID");
    if (!guildId) throw new ServiceUnavailableException("The staff community is not configured.");
    const game = this.servers.get(input.serverId);
    const configuration = await game.configuration();
    const overview = await game.overview();
    const track = this.rounds.observe(input.serverId, overview, { fields: configuration.fields }).track;
    const readiness = await this.voteEventReadiness(
      input.serverId,
      input.fifty,
      configuration,
      overview,
      track,
      undefined,
      { minPlayers: input.minPlayers, atClose: true },
    );
    if (!readiness.ok) throw new ConflictException(sentence(readiness.reason));
    const lock = configuration.fields.find((field) => field.id === "lockOverpopulated")!.value as boolean;
    const base = this.voteOptionsBase(input.fifty);
    const source = { kind: "vote" as const, voteId: input.voteId, label: plainLabel(input.label, 60) };
    // Provisional: each 50v50 round resolves its own teams when sorting starts. A roster still settling
    // at the close names them from the factions alone.
    let teams: [string, string] | null;
    try {
      const roster = eventRoster({ options: { ...base, source } }, overview);
      teams = voteTeams(input.fifty.closedFaction, roster.factions, roster.players);
    } catch {
      teams = voteTeams(
        input.fifty.closedFaction,
        overview.status.factionScores.map((faction) => faction.name),
        [],
      );
    }
    if (!teams) throw new ConflictException("The closed team is not playing.");
    const options: EventOptions = {
      ...base,
      teams,
      rounds: input.fifty.rounds,
      autoEnd: input.fifty.autoEnd,
      closedFaction: input.fifty.closedFaction,
      playerMessages: serves(overview.capabilities, "POST", "/v1/players/{id}/message"),
      source,
    };
    if (this.stopped) throw new ServiceUnavailableException("Gramps is stopping. No event was created.");
    const now = new Date();
    const started = await this.store.create({
      id: input.voteId,
      serverId: input.serverId,
      serverName: overview.status.serverName,
      connectionHash: this.servers.connectionHash(input.serverId),
      guildId,
      actorId: input.actor.id,
      actorName: `Gramps community vote (${plainLabel(input.actor.name, 40)})`,
      reason: `Community vote ${input.voteId}: 50v50 next round (${input.votes} of ${input.total} votes)`,
      requestHash: createHash("sha256").update(JSON.stringify(options)).digest("hex"),
      options,
      originalLock: lock,
      initialRevision: configuration.revision,
      progress: trackedEventProgress(track, now.getTime()),
      createdAt: now,
      updatedAt: now,
      endsAt: new Date(now.getTime() + options.durationMinutes * 60_000),
    });
    return { created: started.created, event: eventView(started.event) };
  }
  /** The event a ballot started, if one was recorded. */
  async voteEvent(voteId: string) {
    const event = await this.store.get(voteId);
    if (!event || event.options.source?.voteId !== voteId) return null;
    return { state: event.state, stop: event.stop, message: event.message };
  }
  async stop(staff: Staff, id: string, input: unknown) {
    this.staff(staff);
    this.available();
    const parsed = stopEventSchema.safeParse(input);
    if (!z.uuid().safeParse(id).success || !parsed.success)
      throw new BadRequestException("Choose an event and enter a reason.");
    await this.selectedEvent(staff, id);
    return eventView(
      await this.store.stop(id, {
        ...parsed.data,
        actorId: staff.id,
        actorName: staff.name,
        at: new Date().toISOString(),
      }),
    );
  }
  async restore(staff: Staff, id: string, input: unknown) {
    this.staff(staff);
    this.available();
    const parsed = restoreEventSchema.safeParse(input);
    if (!z.uuid().safeParse(id).success || !parsed.success)
      throw new BadRequestException("Review the current team lock and confirm its restoration.");
    const event = await this.selectedEvent(staff, id);
    if (!event || !event.stop || !["needs_review", "stopping", "complete"].includes(event.state))
      throw new ConflictException("Stop this event and inspect its receipts before restoring settings.");
    if (!this.connected(event))
      throw new ConflictException(
        "The configured game or community changed. Restore through the original server's owner.",
      );
    if (event.state === "complete") return eventView(event);
    const op: EventOperation = {
      id: parsed.data.id,
      kind: "restore_lock",
      action: {
        id: parsed.data.id,
        serverId: event.serverId,
        action: "settings-save",
        revision: parsed.data.revision,
        changes: { lockOverpopulated: event.originalLock },
        reason: parsed.data.reason,
      },
    };
    const claimed = await this.store.claim(id, event.version, op, staff, event.progress, true);
    if (claimed) await this.execute(claimed, op, staff);
    return eventView((await this.store.get(id))!);
  }
  onApplicationBootstrap() {
    this.workerStarted = true;
    if (this.enabled()) for (const server of this.servers.list()) this.schedule(server.id, 0);
  }
  onModuleDestroy() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  private schedule(serverId: string, delay: number) {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick(serverId).then((next) => this.schedule(serverId, next));
    }, delay);
    timer.unref();
    this.timers.set(serverId, timer);
  }
  private actor(event: EventRecord): Staff {
    return {
      id: event.stop && !event.stop.actorId.startsWith("system:") ? event.stop.actorId : event.actorId,
      name: event.stop && !event.stop.actorId.startsWith("system:") ? event.stop.actorName : event.actorName,
      role: "admin",
      csrf: "",
      serverId: event.serverId,
    };
  }
  /**
   * A fresh administrator check for event effects. Only a refusal (Discord's 401/403/404, or a role
   * below administrator) is lost access. Any other failure, such as a Discord timeout or 5xx, reuses a
   * confirmation from the last five minutes, and is otherwise `null` so the pass is retried.
   */
  private async administrator(actor: Staff, serverId: string): Promise<Staff | "lost" | null> {
    const key = `${serverId}:${actor.id}`;
    let staff: Staff;
    try {
      staff = await this.auth.serverStaff(actor, serverId, true);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        this.confirmedAdmins.delete(key);
        return "lost";
      }
      const confirmed = this.confirmedAdmins.get(key);
      return confirmed && Date.now() - confirmed.at <= ACCESS_GRACE_MS ? confirmed.staff : null;
    }
    if (staff.role !== "admin") {
      this.confirmedAdmins.delete(key);
      return "lost";
    }
    if (this.confirmedAdmins.size > 500) this.confirmedAdmins.clear();
    this.confirmedAdmins.set(key, { staff, at: Date.now() });
    return staff;
  }
  /** Logs, alerts staff once and once more after 30 minutes, never throws into a worker. */
  private async alert(serverId: string, key: string, message: string) {
    const now = Date.now();
    const previous = this.alerted.get(key);
    if (previous && (previous.count >= 2 || now - previous.at < ALERT_REPEAT_MS)) return;
    if (this.alerted.size > 500) this.alerted.clear();
    this.alerted.set(key, { count: (previous?.count ?? 0) + 1, at: now });
    try {
      await this.alerts.send(serverId, key, message);
    } catch {
      this.logger.warn(`A staff alert for ${serverId} could not be delivered: ${message}`);
    }
  }
  private async problem(
    event: EventRecord,
    message: string,
    progress = event.progress,
    alert?: { key: string; message: string },
  ) {
    this.logger.warn(`Optional event ${event.id} on ${event.serverId} needs review: ${message}`);
    await this.store.observe(event.id, event.version, { state: "needs_review", progress, message });
    if (alert) await this.alert(event.serverId, alert.key, alert.message);
    else if (isVoteEvent(event))
      await this.alert(
        event.serverId,
        `event-review:${event.id}`,
        `The 50v50 on ${event.serverName} needs staff review: ${message}`,
      );
  }
  private async halt(event: EventRecord, reason: string, opId?: string) {
    this.logger.warn(`Optional event ${event.id} on ${event.serverId} stopped itself: ${reason}`);
    const halted = await this.store.halt(event.id, reason, opId);
    if (halted && isVoteEvent(event))
      await this.alert(
        event.serverId,
        `event-halt:${event.id}`,
        `The 50v50 on ${event.serverName} stopped itself: ${reason} Gramps is restoring the team lock.`,
      );
    return halted;
  }
  /** At most one recorded effect per pass, with storage claims coordinating multiple instances. */
  async tick(id?: string): Promise<number> {
    if (this.stopped || !this.enabled()) return 30_000;
    const serverId = this.servers.resolve(id);
    if (this.running.has(serverId)) return 30_000;
    this.running.add(serverId);
    try {
      let event = await this.store.current(serverId);
      if (!event) {
        await this.watchdog(serverId);
        return 15_000;
      }
      if (!event.stop && event.endsAt.getTime() <= Date.now())
        event = await this.store.stop(event.id, {
          id: randomUUID(),
          ...systemStops.expiry,
          reason: "The reviewed event duration ended.",
          at: new Date().toISOString(),
        });
      // A voted 50v50 recorded while the owner's flag was on stops once it is off, before it changes the
      // team lock or sorts another round. The restore path puts the lock back. Staff are not alerted.
      if (!event.stop && isVoteEvent(event) && this.voteEventsHeld())
        event = await this.store.stop(event.id, {
          id: randomUUID(),
          ...systemStops.halted,
          reason: sentence(FIFTY_HELD_REASON),
          at: new Date().toISOString(),
        });
      if (event.operation) {
        await this.recover(event);
        return 15_000;
      }
      if (event.state === "needs_review") {
        if (isVoteEvent(event))
          await this.alert(
            serverId,
            `event-review:${event.id}`,
            `The 50v50 on ${event.serverName} needs staff review: ${event.message}`,
          );
        return 30_000;
      }
      if (!this.connected(event)) {
        await this.problem(
          event,
          "The game endpoint or community changed. No event action was sent; review the original server.",
        );
        return 30_000;
      }
      if (event.stop && !event.originalLock) {
        await this.store.completeUnchanged(event.id, event.version);
        return 15_000;
      }
      const actor = await this.administrator(this.actor(event), serverId);
      if (actor === "lost") {
        await this.problem(
          event,
          "The responsible staff account no longer has administrator access. New moves have stopped; another administrator must review restoration.",
        );
        return 30_000;
      }
      if (!actor) {
        // A Discord outage is not lost access: nothing is sent this pass, and the next one checks again.
        this.logger.warn(`Optional event ${event.id}: administrator access could not be checked. Retrying.`);
        return 30_000;
      }
      const game = this.servers.get(serverId);
      let settings: Configuration;
      try {
        settings = await game.configuration();
      } catch {
        await this.unreadableSettings(event);
        return 30_000;
      }
      const lock = settings.fields.find((field) => field.id === "lockOverpopulated");
      let snapshot: EventSnapshot | null = null;
      let track: RoundTrack | null = null;
      try {
        // Every pass feeds the shared round tracker, so a boundary is not lost in any state.
        snapshot = await game.overview();
        track = this.observeRound(event, snapshot, settings.fields);
      } catch (error) {
        // Restoring the team lock never waits for a status read.
        if (!event.stop) throw error;
      }
      const now = Date.now();
      const step = event.stop
        ? this.restoreStep(event, settings, lock, track, now)
        : event.state === "preparing"
          ? this.prepareStep(event, settings, lock, track, now)
          : this.runStep(event, lock, snapshot!, track, now);
      await this.apply(event, step, actor);
      const allowance = (await game.capabilities()).limits?.maxRequestsPerMinutePerIp;
      return Math.max(5_000, allowance ? Math.ceil((60_000 * 10) / allowance) : 10_000);
    } catch {
      this.logger.warn(
        "Optional-event observation failed. Recorded actions are retained and are not automatically replayed.",
      );
      return 30_000;
    } finally {
      this.running.delete(serverId);
    }
  }
  /** Gramps switched the team lock off, may have (an unconfirmed attempt), or is putting it back. */
  private lockMayBeOff(event: EventRecord) {
    const progress = event.progress;
    return (
      event.originalLock &&
      (progress.lockDisabledAt !== undefined || event.restoreRevision !== null || (progress.disableAttempts ?? 0) > 0)
    );
  }
  /**
   * A failed settings read. While the team lock may be off it escalates like an unreadable lock field:
   * an alert after five minutes and staff review after 30. Otherwise the next pass simply retries.
   */
  private async unreadableSettings(event: EventRecord) {
    this.logger.warn(`Optional event ${event.id}: the game settings could not be read. Retrying.`);
    if (!this.lockMayBeOff(event)) return;
    const now = Date.now();
    const progress = structuredClone(event.progress);
    const since = progress.lockIssueSince ?? now;
    if (now - since >= LOCK_REVIEW_MS) {
      await this.problem(
        event,
        "The game settings could not be read for 30 minutes. Check 'Lock overpopulated teams' and restore it manually if it is still off.",
        progress,
        {
          key: `event-lock-restore:${event.id}`,
          message: `Team lock may still be OFF on ${event.serverName}: the game settings could not be read for 30 minutes during the 50v50. Check 'Lock overpopulated teams' now.`,
        },
      );
      return;
    }
    progress.lockIssueSince = since;
    if (now - since >= LOCK_ALERT_MS)
      await this.alert(
        event.serverId,
        `event-lock-unreadable:${event.id}`,
        `Team lock may still be OFF on ${event.serverName}: the game settings could not be read for 5 minutes. Gramps keeps retrying.`,
      );
    await this.store.observe(event.id, event.version, {
      state: event.state,
      progress,
      message: "The game settings could not be read. Retrying; the team lock may still be off.",
    });
  }
  /**
   * An interrupted action is never replayed. A vote-started event stops itself and restores the lock;
   * an interrupted restore is rechecked from the saved setting. Other staff-started actions need review.
   */
  private async recover(event: EventRecord) {
    const op = event.operation!;
    const rechecks = isVoteEvent(event) || op.kind === "restore_lock" || op.kind === "ended";
    if (!rechecks) {
      await this.store.recover(event, new Date());
      return;
    }
    if (Date.now() - event.updatedAt.getTime() < INTERRUPTED_MS) return;
    await this.halt(
      event,
      op.kind === "restore_lock"
        ? "The team-lock restore was interrupted before its result was recorded."
        : "An event action was interrupted before its result was recorded.",
      op.id,
    );
  }
  private observeStep(event: EventRecord, progress: EventProgress, message: string, state = event.state): Step {
    return { kind: "observe", update: { state, progress, message } };
  }
  /** Puts the team lock back to its value before the event, editing only that key at the fresh revision. */
  private restoreStep(
    event: EventRecord,
    settings: Configuration,
    lock: LockField,
    track: RoundTrack | null,
    now: number,
  ): Step {
    const progress = structuredClone(event.progress);
    if (track) progress.tracker = track;
    if (event.stop!.actorId === systemStops.rounds.actorId && progress.endedAt === undefined) {
      // Recorded before sending: the notice is never repeated.
      progress.endedAt = now;
      return {
        kind: "op",
        op: operation(event, "ended", {
          action: "broadcast",
          message: "50v50 is over: three teams again. Pick any team at your next respawn.",
        }),
        progress,
      };
    }
    const value = lock?.value;
    if (typeof value !== "boolean" || (value !== event.originalLock && !lock!.editable)) {
      const since = progress.lockIssueSince ?? now;
      const issue = "The team-lock setting could not be read or edited";
      if (now - since >= LOCK_REVIEW_MS)
        return {
          kind: "problem",
          message: `${issue} for 30 minutes. Restore 'Lock overpopulated teams' manually.`,
          progress,
          alert: {
            key: `event-lock-restore:${event.id}`,
            message: `Team lock may still be OFF on ${event.serverName}: ${issue.toLowerCase()} for 30 minutes after the 50v50 ended. Restore 'Lock overpopulated teams' manually.`,
          },
        };
      progress.lockIssueSince = since;
      if (now - since >= LOCK_ALERT_MS)
        void this.alert(
          event.serverId,
          `event-lock-unreadable:${event.id}`,
          `Team lock may still be OFF on ${event.serverName}: ${issue.toLowerCase()} for 5 minutes. Gramps keeps retrying.`,
        );
      return this.observeStep(event, progress, `${issue}. Retrying before restoring it.`, "stopping");
    }
    delete progress.lockIssueSince;
    if (value === event.originalLock)
      return {
        kind: "complete",
        message:
          event.stop!.actorId === systemStops.lock_changed.actorId
            ? "Event stopped. Staff had already switched the team lock back on; no restore was needed."
            : "Event stopped. The team lock already has its original value; no change was needed.",
      };
    const attempts = progress.restoreAttempts ?? { count: 0, lastAt: 0 };
    if (attempts.count >= RESTORE_ATTEMPTS)
      return {
        kind: "problem",
        message: `The team lock could not be confirmed back on after ${RESTORE_ATTEMPTS} attempts. Check 'Lock overpopulated teams' now.`,
        progress,
        alert: {
          key: `event-lock-restore:${event.id}`,
          message: `Team lock may still be OFF on ${event.serverName}. Gramps could not confirm 'Lock overpopulated teams' back on after ${RESTORE_ATTEMPTS} attempts. Check it now.`,
        },
      };
    if (attempts.count > 0 && now - attempts.lastAt < RESTORE_GAP_MS)
      return this.observeStep(event, progress, "Rechecking the team lock before another restore attempt.", "stopping");
    progress.restoreAttempts = { count: attempts.count + 1, lastAt: now };
    return {
      kind: "op",
      op: operation(event, "restore_lock", {
        action: "settings-save",
        revision: settings.revision,
        changes: { lockOverpopulated: event.originalLock },
      }),
      progress,
    };
  }
  private stopFor(event: EventRecord, reason: SystemStop, progress: EventProgress, staffMessage: string): Step {
    return isVoteEvent(event)
      ? { kind: "stop", reason, message: stopMessages[reason] }
      : { kind: "problem", message: staffMessage, progress };
  }
  /** Switches the lock off (if it was on) and announces the event; no player is moved this round. */
  private prepareStep(
    event: EventRecord,
    settings: Configuration,
    lock: LockField,
    track: RoundTrack | null,
    now: number,
  ): Step {
    const vote = isVoteEvent(event);
    const progress = structuredClone(event.progress);
    if (track) progress.tracker = track;
    const value = lock?.value;
    if (typeof value !== "boolean" || (value && !lock!.editable)) {
      const since = progress.lockIssueSince ?? now;
      if (now - since >= LOCK_ALERT_MS)
        return {
          kind: "problem",
          message:
            "The team lock could not be read, or is on and cannot be edited, for 5 minutes. No team-lock change was sent.",
          progress,
          alert: {
            key: `event-review:${event.id}`,
            message: `The 50v50 on ${event.serverName} could not prepare: the team lock could not be read or edited for 5 minutes. No change was sent.`,
          },
        };
      progress.lockIssueSince = since;
      return this.observeStep(event, progress, "Waiting to read the team-lock setting before preparing the event.");
    }
    delete progress.lockIssueSince;
    if (value) {
      // The lock was off before the event, or Gramps already confirmed it off: staff switched it on.
      if (!event.originalLock || progress.lockDisabledAt !== undefined || event.restoreRevision !== null)
        return this.stopFor(
          event,
          "lock_changed",
          progress,
          "The saved team lock is not off. Review the game settings before starting team moves.",
        );
      const attempts = progress.disableAttempts ?? 0;
      if (attempts >= RETRY_LIMIT)
        return vote
          ? { kind: "halt", reason: "The team lock could not be confirmed off after 3 attempts." }
          : {
              kind: "problem",
              message: "The team lock could not be confirmed off. No player was moved.",
              progress,
            };
      progress.disableAttempts = attempts + 1;
      return {
        kind: "op",
        op: operation(event, "disable_lock", {
          action: "settings-save",
          revision: settings.revision,
          changes: { lockOverpopulated: false },
        }),
        progress,
      };
    }
    // An unconfirmed edit that the saved setting now shows counts as applied.
    if (event.originalLock) progress.lockDisabledAt ??= now;
    if (track?.phase === "waiting")
      return this.observeStep(event, progress, "The 50v50 is ready. Its announcement waits until players are back.");
    const label = event.options.source?.label;
    return {
      kind: "op",
      op: operation(event, "armed", {
        action: "broadcast",
        message: vote
          ? `Vote result: 50v50 next round${label ? ` on ${plainLabel(label, 40)}` : ""}. One team will be closed and its players moved at round start; wait for the team notice before buying.`
          : "Optional 50v50 is armed for the next round. Teams may change early; wait for the team notice before buying. Staff can stop this event at any time.",
      }),
      progress,
    };
  }
  private runStep(
    event: EventRecord,
    lock: LockField,
    snapshot: EventSnapshot,
    track: RoundTrack | null,
    now: number,
  ): Step {
    if (lock?.value !== false) {
      const progress = structuredClone(event.progress);
      if (lock?.value === true)
        return this.stopFor(
          event,
          "lock_changed",
          progress,
          "The team-lock setting changed during the event. Team changes have stopped for staff review.",
        );
      if (!isVoteEvent(event))
        return {
          kind: "problem",
          message: "The team-lock setting changed during the event. Team changes have stopped for staff review.",
        };
      const since = progress.lockIssueSince ?? now;
      if (now - since >= LOCK_ALERT_MS)
        return { kind: "halt", reason: "The team-lock setting could not be read for 5 minutes." };
      progress.lockIssueSince = since;
      return this.observeStep(event, progress, "Waiting to read the team-lock setting. No team changes were planned.");
    }
    const plan = planEvent(event, snapshot, now, track);
    delete plan.progress.lockIssueSince;
    if (plan.stop) return { kind: "stop", reason: plan.stop, message: stopMessages[plan.stop] };
    if (plan.halt) return { kind: "halt", reason: plan.halt };
    if (plan.operation) return { kind: "op", op: plan.operation, progress: plan.progress };
    if (plan.state === "needs_review") return { kind: "problem", message: plan.message, progress: plan.progress };
    return { kind: "observe", update: { state: plan.state, progress: plan.progress, message: plan.message } };
  }
  private async apply(event: EventRecord, step: Step, actor: Staff) {
    switch (step.kind) {
      case "op": {
        if (this.stopped) return;
        const claimed = await this.store.claim(event.id, event.version, step.op, actor, step.progress);
        if (claimed) await this.execute(claimed, step.op, actor);
        return;
      }
      case "observe":
        await this.store.observe(event.id, event.version, step.update);
        return;
      case "complete":
        await this.store.completeRestored(event.id, event.version, step.message);
        return;
      case "stop":
        await this.store.stop(event.id, {
          id: randomUUID(),
          ...systemStops[step.reason],
          reason: step.message,
          at: new Date().toISOString(),
        });
        if (step.reason === "roster")
          await this.alert(
            event.serverId,
            `event-halt:${event.id}`,
            `The 50v50 on ${event.serverName} stopped itself: ${step.message} Gramps is restoring the team lock.`,
          );
        return;
      case "halt":
        await this.halt(event, step.reason);
        return;
      case "problem":
        await this.problem(event, step.message, step.progress, step.alert);
        return;
    }
  }
  /** One alert per finished event when "Lock overpopulated teams" stays off afterwards. */
  private async watchdog(serverId: string) {
    const now = Date.now();
    if (now - (this.watched.get(serverId) ?? 0) < WATCHDOG_MS) return;
    this.watched.set(serverId, now);
    try {
      const [latest] = await this.store.history(serverId);
      if (
        !latest ||
        latest.state !== "complete" ||
        !latest.originalLock ||
        now - latest.updatedAt.getTime() > WATCHDOG_WINDOW_MS ||
        this.lockOffAlerted.has(latest.id) ||
        !this.connected(latest)
      )
        return;
      const settings = await this.servers.get(serverId).configuration();
      if (settings.fields.find((field) => field.id === "lockOverpopulated")?.value !== false) return;
      if (this.lockOffAlerted.size > 500) this.lockOffAlerted.clear();
      this.lockOffAlerted.add(latest.id);
      await this.alert(
        serverId,
        `event-lock-off:${latest.id}`,
        `Team lock is OFF on ${latest.serverName} although the 50v50 (${latest.id}) has ended and it was on before. Check 'Lock overpopulated teams'.`,
      );
    } catch {
      /* The watchdog retries on its next interval. */
    }
  }
  /** Ops tied to a round run only in that same round, from a fresh, live observation. */
  private async inRound(event: EventRecord, op: EventOperation) {
    if (!op.roundId && !op.round) return true;
    const snapshot = await this.servers.get(event.serverId).overview();
    const observedAt = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observedAt) || Date.now() - observedAt > 15_000) return false;
    if (!op.roundId) {
      // Operations recorded before round tracking keep the clock comparison.
      const current = observedRound(snapshot);
      return !!current && sameRound(current, op.round!);
    }
    const track = this.observeRound(event, snapshot);
    return track.round.id === op.roundId && track.phase === "live";
  }
  /**
   * The state after an action that was not sent. Vote-started events keep their state (the next pass
   * plans again, or the restore path runs); other events wait for staff unless stopped.
   */
  private unsent(event: EventRecord, latest: EventRecord | null): EventState {
    if (latest?.stop) return "stopping";
    return isVoteEvent(event) && latest && latest.state !== "needs_review" && this.connected(latest)
      ? latest.state
      : "needs_review";
  }
  private async execute(event: EventRecord, op: EventOperation, actor: Staff) {
    const vote = isVoteEvent(event);
    const afterStop = op.kind === "restore_lock" || op.kind === "ended";
    let result: ActionResult = {
      state: "unknown",
      message: "The event action could not be confirmed. Inspect its receipt before another attempt.",
    };
    let outcome: Outcome = {
      state: "needs_review",
      progress: event.progress,
      restoreRevision: event.restoreRevision,
    };
    let started = false;
    try {
      const latest = await this.store.get(event.id);
      if (
        this.stopped ||
        !latest ||
        latest.operation?.id !== op.id ||
        latest.state === "needs_review" ||
        (latest.stop && !afterStop) ||
        !this.connected(latest)
      ) {
        result = {
          state: "failed",
          changed: false,
          message: "This event action was stopped before it reached the game.",
        };
        outcome.state = this.unsent(event, latest);
      } else {
        actionSchema.parse(op.action);
        // Event ownership is checked separately; the system actor keeps event effects distinct from manual clicks.
        const authorized = await this.administrator(actor, event.serverId);
        if (authorized === "lost") throw new Error("Administrator access changed.");
        if (!authorized) throw new Error("Administrator access could not be checked.");
        if (!(await this.inRound(event, op))) {
          await this.store.settle(
            event.id,
            op.id,
            { state: "failed", message: "The round changed or its observation expired. No event action was sent." },
            {
              state: op.kind === "round_warning" ? event.state : "active",
              progress: { ...event.progress, pendingRespawn: null },
              message: "Waiting for a fresh round observation.",
            },
          );
          return;
        }
        const before = await this.store.get(event.id);
        if (
          this.stopped ||
          before?.operation?.id !== op.id ||
          before.state === "needs_review" ||
          (before.stop && !afterStop)
        ) {
          await this.store.settle(
            event.id,
            op.id,
            { state: "failed", message: "Event stopped during review. No action was sent." },
            {
              state: this.unsent(event, before),
              progress: event.progress,
              message: "No action was sent after the event stopped.",
            },
          );
          return;
        }
        started = true;
        try {
          result = await this.admin.act(
            { ...authorized, id: `system:50v50:${event.id}`, name: `Gramps 50v50 (${actor.name})` },
            op.action,
          );
        } catch (error) {
          // The action service refuses before contacting the game; nothing was sent.
          if (!(error instanceof HttpException)) throw error;
          result = { state: "failed", changed: false, message: error.message };
        }
        outcome = { restoreRevision: event.restoreRevision, ...this.outcome(event, op, result) };
      }
    } catch {
      /* A thrown or lost result never authorizes another automatic attempt. */
      if (op.kind === "restore_lock") outcome = { ...outcome, state: "stopping" };
      else if (vote) {
        // Vote-started events never wait for staff with the lock off: retry a step that was not sent,
        // and stop (restoring the lock) after one whose result is unknown.
        if (!started)
          result = {
            state: "failed",
            changed: false,
            message: "The event action was not sent because its checks could not be completed.",
          };
        outcome = {
          ...outcome,
          state: event.stop ? "stopping" : event.state,
          ...(started ? { halt: "An event action's result could not be confirmed." } : {}),
        };
      }
    }
    await this.store.settle(event.id, op.id, result, {
      state: outcome.state,
      progress: outcome.progress,
      restoreRevision: outcome.restoreRevision ?? null,
      message:
        outcome.message ??
        (outcome.state === "complete"
          ? "Event stopped. The original team-lock value is saved; verify when the game adopts it."
          : result.message),
    });
    if (outcome.halt && outcome.state !== "needs_review") await this.halt(event, outcome.halt);
  }
  /**
   * Maps an action result to the event's next state. Staff-started events need review after anything
   * unconfirmed; vote-started events retry briefly or stop themselves so the lock is restored.
   */
  private outcome(event: EventRecord, op: EventOperation, result: ActionResult): Outcome {
    const vote = isVoteEvent(event);
    const now = Date.now();
    const progress = event.progress;
    const retry = (reason: string, state: EventState, base = progress): Outcome => {
      const failures = (progress.failures ?? 0) + 1;
      return {
        state,
        progress: { ...base, failures },
        halt: failures >= RETRY_LIMIT ? `${reason} (${failures} attempts).` : null,
      };
    };
    if ((op.kind === "move" || op.kind === "respawn") && result.changed === false) {
      // A helpful manual switch or changed precondition is not authority to kill a player.
      const base = { ...progress, pendingRespawn: null };
      if (vote && result.state === "failed") return retry("Team moves were refused", "active", base);
      return { state: "active", progress: base };
    }
    const accepted =
      op.kind === "move"
        ? result.state === "applied" && result.changed === true
        : op.kind === "disable_lock" || op.kind === "restore_lock"
          ? ["applied", "pending"].includes(result.state)
          : ["applied", "accepted"].includes(result.state);
    if (accepted) {
      const states: Partial<Record<EventOperation["kind"], EventState>> = {
        restore_lock: "complete",
        disable_lock: "preparing",
        armed: "waiting_round",
        round_warning: "warming",
        ended: "stopping",
      };
      return {
        state: states[op.kind] ?? "active",
        progress: completeEventOperation(event, op, now),
        ...(op.kind === "disable_lock" ? { restoreRevision: result.revision ?? null } : {}),
      };
    }
    // Every event rechecks the saved lock and retries the restore; the next pass reads the field.
    if (op.kind === "restore_lock")
      return { state: "stopping", progress, message: `${result.message} Gramps rechecks the team lock and retries.` };
    if (!vote) return { state: "needs_review", progress };
    switch (op.kind) {
      case "disable_lock":
        return {
          state: "preparing",
          progress,
          message: `${result.message} Gramps rechecks the team lock before another attempt.`,
        };
      case "move":
        // An accepted move the roster does not show yet counts as moved; the planner allows two minutes.
        if (result.state === "pending")
          return { state: "active", progress: completeEventOperation(event, op, now, false) };
        return result.state === "failed"
          ? retry("Team moves were refused", "active")
          : { state: "active", progress, halt: "A team move could not be confirmed." };
      case "respawn":
        return result.state === "failed"
          ? retry("Respawns were refused", "active", { ...progress, pendingRespawn: null })
          : {
              state: "active",
              progress: { ...progress, pendingRespawn: null },
              halt: "A respawn could not be confirmed.",
            };
      case "round_warning":
        return retry("The round's team warning was not confirmed", event.state);
      // Informational notices never block the event or the restore.
      case "armed":
        return { state: "waiting_round", progress };
      case "ended":
        return { state: "stopping", progress: { ...progress, endedAt: now } };
      case "ready":
        return { state: "active", progress: { ...progress, readyAnnounced: true } };
      case "player_warning":
        // The round warning already covers the player; the usual wait still applies.
        return { state: "active", progress: { ...progress, warned: { ...progress.warned, [op.steamId!]: now } } };
      default:
        return { state: "needs_review", progress };
    }
  }
}
