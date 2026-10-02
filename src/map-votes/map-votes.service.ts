import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { validateMapSelection } from "../admin/server-configuration";
import { sameMap } from "../common/map-labels";
import {
  defaultVotingPolicy,
  votingScore,
  votingMilestones,
  voteChoiceTitle,
  voteModeKey,
  type VotingControls,
  type VotingPolicy,
  type VoteReminder,
} from "../common/voting-policy";
import { roundStamp, sameRound, type RoundStamp } from "../common/game-round";
import type { AutomaticVoteStatus, MapVoteSetup } from "../common/map-vote-automation";
import type { MapSelection } from "../common/server-settings";
import type { Staff } from "../admin/admin.types";
import { EnvService } from "../env/env.service";
import { plainLabel } from "../server-community/community-state";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";
import {
  cancelMapVoteSchema,
  mapVoteView,
  startMapVoteSchema,
  votingPolicySchema,
  type MapVoteRecord,
} from "./map-votes.types";

@Injectable()
export class MapVotesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MapVotesService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private readonly automaticPositions = new Map<
    string,
    { map: string; index: number; since: number; lastSeen: number; connection: string; round: RoundStamp | null }
  >();
  private readonly automaticMessages = new Map<string, { message: string; checkedAt: string }>();
  constructor(
    private readonly store: MapVotesStore,
    private readonly servers: GameServers,
    private readonly admin: AdminService,
    private readonly auth: AdminAuth,
    private readonly discord: MapVotesDiscord,
    private readonly env: EnvService,
  ) {}
  private options() {
    const guildId = this.env.get("ADMIN_GUILD_ID"),
      channelId = this.env.get("MAP_VOTES_CHANNEL_ID");
    return { enabled: this.env.get("MAP_VOTES_ENABLED") === true && !!guildId && !!channelId, guildId, channelId };
  }
  private requireStaff(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can manage map votes.");
  }
  private async automaticStatus(serverId: string): Promise<AutomaticVoteStatus | null> {
    const saved = await this.store.policy(serverId);
    const connectionMatches = !saved || saved.connectionHash === this.servers.connectionHash(serverId);
    if (saved)
      return {
        enabled: this.options().enabled && saved.policy.enabled && connectionMatches,
        delaySeconds: 120,
        closesAtScore: votingMilestones.close,
        choices: 5,
        message: !connectionMatches
          ? "The server connection changed. Switch voting off and save its controls before setup."
          : saved.policy.enabled && this.options().enabled
            ? "Waiting for confirmed rotation and scores. Ballots close at 95 points."
            : "Automatic voting is switched off.",
        checkedAt: null,
        ...(saved.policy.enabled && connectionMatches ? this.automaticMessages.get(serverId) : {}),
      };
    return null;
  }
  private enabled() {
    const options = this.options();
    if (!options.enabled)
      throw new ServiceUnavailableException(
        "Map voting is not enabled. Its database and Discord channel need owner setup.",
      );
    return { guildId: options.guildId!, channelId: options.channelId! };
  }
  async controls(staff: Staff): Promise<VotingControls> {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    try {
      const saved = await this.store.policy(serverId);
      const connectionMatches = !saved || saved.connectionHash === this.servers.connectionHash(serverId);
      return {
        serverId,
        version: saved?.version ?? 0,
        policy: saved ? votingPolicySchema.parse(saved.policy) : defaultVotingPolicy,
        available: true,
        ready: this.options().enabled && connectionMatches,
        message: !connectionMatches
          ? "The server connection changed. Switch voting off and save before enabling it for this connection."
          : this.options().enabled
            ? "Changes apply to the next ballot. Switching off stops open automatic ballots."
            : "Live voting is disabled in Gramps. You can prepare these settings without opening a ballot.",
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
      };
    }
  }
  async saveControls(staff: Staff, input: unknown) {
    this.requireStaff(staff);
    const serverId = this.servers.resolve(staff.serverId);
    this.servers.checkVersion(serverId, staff.serverVersion);
    const parsed = z
      .object({ serverId: z.string(), version: z.number().int().nonnegative(), policy: votingPolicySchema })
      .strict()
      .safeParse(input);
    if (!parsed.success || parsed.data.serverId !== serverId)
      throw new BadRequestException("Review the voting controls for the selected server.");
    if (parsed.data.policy.enabled) {
      const saved = await this.store.policy(serverId);
      if (saved && saved.connectionHash !== this.servers.connectionHash(serverId))
        throw new ConflictException(
          "The server connection changed. Save voting off before reviewing activation again.",
        );
      const options = this.enabled();
      await this.discord.check(options.guildId, options.channelId);
    }
    const result = await this.store.savePolicy(
      serverId,
      parsed.data.version,
      parsed.data.policy,
      staff,
      this.servers.connectionHash(serverId),
    );
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
          return rotation.editable && rotation.enabled && rotation.mode === "Ordered" && rotation.currentIndex !== null
            ? {
                status: "ok",
                message:
                  "Ordered rotation and current position confirmed. Ballot choices are validated before opening.",
              }
            : {
                status: "blocked",
                message: "Voting needs an editable ordered rotation with a confirmed current position.",
              };
        },
        "The server's current rotation could not be read.",
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
  async start(
    staff: Staff,
    input: unknown,
    automatic?: { previousId: string | null; map: string; index: number; policy?: VotingPolicy },
  ) {
    this.requireStaff(staff);
    const configured = this.enabled();
    const parsed = startMapVoteSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        "Choose two to five different map/mode combinations, a 2–30 minute duration and a reason.",
      );
    const action = parsed.data;
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
      settings.revision !== action.revision ||
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
    for (const choice of action.choices) await validateMapSelection(game, choice, capabilities, catalog);
    const overview = await game.overview();
    const observedAt = Date.parse(overview.observedAt);
    if (!Number.isFinite(observedAt) || !sameMap(overview.status.map, settings.rotation.currentMap))
      throw new ConflictException("The current map could not be confirmed. Refresh before starting a vote.");
    const round = roundStamp(overview.status, observedAt);
    const score = automatic?.policy ? votingScore(overview.status) : null;
    if (
      automatic?.policy &&
      (score === null || score >= votingMilestones.final || Math.abs(Date.now() - observedAt) > 30_000)
    )
      throw new ConflictException("A fresh score below 85 is needed to open an automatic ballot.");
    await this.discord.check(configured.guildId, configured.channelId);
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
        revision: action.revision,
        currentMap: settings.rotation.currentMap,
        currentIndex: settings.rotation.currentIndex,
        roundStartedAt: round ? new Date(round.startedAt) : null,
        closesAt: new Date(now.getTime() + (automatic?.policy ? 180 : action.minutes) * 60_000),
        automation: automatic?.policy ? { policy: automatic.policy, highestScore: score!, reminders: {} } : null,
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
          "Discord publication could not be confirmed. Check the channel; do not create a duplicate ballot.",
        )) ?? record;
    }
    return mapVoteView(record);
  }
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
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, 15_000);
    this.timer.unref();
  }
  /** Isolated tests call this without starting a timer or touching Discord/the game. */
  async tick() {
    if (this.running || this.stopped || !this.options().enabled) return;
    this.running = true;
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
      for (const vote of await this.store.automaticOpen()) {
        if (this.stopped) break;
        try {
          await this.observeAutomatic(vote);
        } catch {
          this.automaticMessages.set(vote.serverId, {
            checkedAt: new Date().toISOString(),
            message: "Current scores or position could not be checked. No new reminder or queue change was confirmed.",
          });
        }
      }
      const policies = await this.store.policies();
      for (const recipe of policies.filter((row) => row.policy.enabled)) {
        if (this.stopped) break;
        try {
          if (recipe.connectionHash !== this.servers.connectionHash(recipe.serverId))
            throw new Error("Voting server changed.");
          await this.openAutomatic(recipe, votingPolicySchema.parse(recipe.policy));
        } catch {
          this.automaticPositions.delete(recipe.serverId);
          this.automaticMessages.set(recipe.serverId, {
            message:
              "Automatic voting is waiting for valid rotation options, storage and staff access. No new ballot was confirmed.",
            checkedAt: new Date().toISOString(),
          });
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
  private async openAutomatic(recipe: { serverId: string; actorId: string }, policy: VotingPolicy) {
    const serverId = this.servers.resolve(recipe.serverId);
    const note = (message: string) =>
      this.automaticMessages.set(serverId, { message, checkedAt: new Date().toISOString() });
    const history = await this.store.history(serverId);
    const active = history.find((vote) => ["publishing", "open", "closing", "needs_review"].includes(vote.state));
    if (active) {
      if (active.state === "open" && active.automation && this.automaticMessages.has(serverId)) return;
      note(
        active.state === "needs_review"
          ? "Resolve the previous ballot before automatic voting resumes."
          : active.state === "open"
            ? "Community voting is open."
            : "Finishing the current ballot.",
      );
      return;
    }
    const game = this.servers.get(serverId);
    const settings = await game.configuration();
    const rotation = settings.rotation;
    const now = Date.now();
    if (!rotation.editable || !rotation.enabled || rotation.mode !== "Ordered" || rotation.currentIndex === null) {
      this.automaticPositions.delete(serverId);
      note("Waiting for an editable ordered rotation and a confirmed current position.");
      return;
    }
    const overview = await game.overview();
    if (!sameMap(overview.status.map, rotation.currentMap) || !Number.isFinite(Date.parse(overview.observedAt)))
      throw new Error("Rotation observation changed.");
    const round = roundStamp(overview.status, Date.parse(overview.observedAt));
    const score = votingScore(overview.status);
    if (score === null || score >= votingMilestones.final || Math.abs(now - Date.parse(overview.observedAt)) > 30_000) {
      note("Waiting for fresh scores below 85 on a 100-point match.");
      return;
    }
    const connection = this.servers.connectionHash(serverId);
    let position = this.automaticPositions.get(serverId);
    if (
      !position ||
      position.connection !== connection ||
      position.index !== rotation.currentIndex ||
      !sameMap(position.map, rotation.currentMap) ||
      (round && position.round && !sameRound(round, position.round)) ||
      now - position.lastSeen > 60_000
    ) {
      position = {
        map: rotation.currentMap,
        index: rotation.currentIndex,
        since: now,
        lastSeen: now,
        connection,
        round,
      };
      this.automaticPositions.set(serverId, position);
    }
    position.lastSeen = now;
    if (round) position.round = round;
    const latest = history[0];
    if (
      latest &&
      latest.connectionHash === connection &&
      latest.currentIndex === rotation.currentIndex &&
      sameMap(latest.currentMap, rotation.currentMap) &&
      (!round ||
        !latest.roundStartedAt ||
        sameRound(round, { map: latest.currentMap, startedAt: latest.roundStartedAt.getTime() }))
    ) {
      note("This rotation position already had a ballot. Waiting for the next position.");
      return;
    }
    if (now - position.since < 120_000) {
      note("The rotation position must stay confirmed for 120 seconds before voting opens.");
      return;
    }
    const checked = await game.checkRotation();
    if (checked.revision !== settings.revision || checked.issues.some((issue) => !issue.unavailable))
      throw new Error("Rotation options could not be checked.");
    const choices: MapSelection[] = [];
    const current = rotation.entries[rotation.currentIndex];
    for (let offset = 1; offset <= rotation.entries.length && choices.length < 5; offset++) {
      const index = (rotation.currentIndex + offset) % rotation.entries.length;
      const entry = rotation.entries[index];
      if (
        checked.issues.some((issue) => issue.index === index) ||
        (!policy.mapChoices && !sameMap(entry.map, rotation.currentMap)) ||
        (!policy.modeChoices &&
          (voteModeKey(entry) !== voteModeKey(current) || sameMap(entry.map, rotation.currentMap))) ||
        choices.some((choice) => sameMap(choice.map, entry.map) && voteModeKey(choice) === voteModeKey(entry))
      )
        continue;
      choices.push(entry);
    }
    if (choices.length < 2) {
      note("Add at least two available choices matching the map/mode voting controls to the rotation.");
      return;
    }
    const actor = await this.auth.serverStaff(
      { id: recipe.actorId, name: "Gramps automatic voting", role: "admin", csrf: "" },
      serverId,
      true,
    );
    if (this.stopped) return;
    const result = await this.start(
      actor,
      {
        id: randomUUID(),
        serverId,
        revision: settings.revision,
        choices,
        minutes: 5,
        reason: "Automatic community map vote.",
      },
      { previousId: latest?.id ?? null, map: rotation.currentMap, index: rotation.currentIndex, policy },
    );
    note(result.state === "open" ? "Automatic community voting is open." : result.message);
  }
  private async cancelAutomatic(vote: MapVoteRecord, reason: string) {
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
    if (!vote.automation) return;
    const policy = await this.store.policy(vote.serverId);
    const configured = this.options();
    if (
      !policy?.policy.enabled ||
      policy.connectionHash !== vote.connectionHash ||
      vote.connectionHash !== this.servers.connectionHash(vote.serverId) ||
      vote.guildId !== configured.guildId ||
      vote.channelId !== configured.channelId
    ) {
      await this.cancelAutomatic(vote, "Automatic voting is off or the server connection changed.");
      return;
    }
    const game = this.servers.get(vote.serverId);
    const settings = await game.configuration();
    const overview = await game.overview();
    const observedAt = Date.parse(overview.observedAt);
    const round = roundStamp(overview.status, observedAt);
    if (
      settings.revision !== vote.revision ||
      settings.rotation.currentIndex !== vote.currentIndex ||
      !sameMap(settings.rotation.currentMap, vote.currentMap) ||
      !sameMap(overview.status.map, vote.currentMap) ||
      (vote.roundStartedAt &&
        (!round || !sameRound(round, { map: vote.currentMap, startedAt: vote.roundStartedAt.getTime() })))
    ) {
      await this.cancelAutomatic(vote, "The match or staff rotation changed. The rotation was left unchanged.");
      return;
    }
    this.automaticMessages.set(vote.serverId, {
      checkedAt: new Date().toISOString(),
      message: "Waiting for fresh match scores. Voting remains open.",
    });
    if (!Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > 30_000) return;
    const score = votingScore(overview.status);
    if (score === null) return;
    this.automaticMessages.set(vote.serverId, {
      checkedAt: new Date().toISOString(),
      message: `Voting is open. Leading score: ${score}/100; closes at 95.`,
    });
    if (score >= votingMilestones.target || score < vote.automation.highestScore) {
      await this.cancelAutomatic(vote, "The score reached 100 or moved backwards. The rotation was left unchanged.");
      return;
    }
    if (!(await this.store.observeScore(vote.id, score)) || this.stopped) return;
    if (score >= votingMilestones.close) {
      const claimed = await this.store.claimClose(vote.id, true);
      if (claimed) await this.close(claimed);
      return;
    }
    // If observations jump past both milestones, only send the late reminder.
    const stage: VoteReminder | null =
      score >= votingMilestones.final ? "final" : score >= votingMilestones.midpoint ? "midpoint" : null;
    if (!stage || !policy.policy[stage === "midpoint" ? "midpointReminder" : "finalReminder"]) return;
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
      const message = `${stage === "final" ? "Last chance" : "Next round vote"}: ${tally}. Choose in Discord #${plainLabel(channel.name, 35)}. Closes at 95 points.`;
      const currentPolicy = await this.store.policy(vote.serverId);
      if (
        !currentPolicy?.policy.enabled ||
        !currentPolicy.policy[stage === "midpoint" ? "midpointReminder" : "finalReminder"] ||
        (await this.store.get(vote.id))?.state !== "open" ||
        this.stopped
      )
        throw new Error("Voting was stopped before sending.");
      await this.discord.remind({ ...vote, counts }, stage);
      const afterDiscord = await this.store.policy(vote.serverId);
      if (
        !afterDiscord?.policy.enabled ||
        !afterDiscord.policy[stage === "midpoint" ? "midpointReminder" : "finalReminder"] ||
        (await this.store.get(vote.id))?.state !== "open" ||
        this.stopped
      )
        throw new Error("Voting stopped before the in-game reminder.");
      const result = await this.admin.act(actor, {
        id,
        action: "broadcast",
        reason: `Map vote ${stage} totals`,
        message,
      });
      await this.store.finishReminder(vote.id, stage, result.state, result.message);
    } catch {
      await this.store.finishReminder(
        vote.id,
        stage,
        "unknown",
        "Reminder delivery was not confirmed. Check its receipt; it will not be repeated.",
      );
    }
  }
  private async close(vote: MapVoteRecord) {
    let state: "queued" | "no_votes" | "tied" | "cancelled" | "needs_review" = "needs_review";
    let actionStarted = false;
    let message = "The next map was not confirmed. Check the ballot's action receipt before changing the rotation.";
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
        const actor = await this.auth.serverStaff(
          { id: vote.actorId, name: vote.actorName, role: "admin", csrf: "" },
          vote.serverId,
          true,
        );
        if (actor.role !== "admin") throw new Error("Creator no longer authorized.");
        if (vote.automation && !(await this.store.policy(vote.serverId))?.policy.enabled)
          throw new Error("Voting switched off.");
        const game = this.servers.get(vote.serverId);
        const settings = await game.configuration();
        if (
          settings.revision !== vote.revision ||
          settings.rotation.currentIndex !== vote.currentIndex ||
          !sameMap(settings.rotation.currentMap, vote.currentMap)
        )
          throw new Error("Rotation changed.");
        const current = await game.overview();
        if (vote.automation) {
          const score = votingScore(current.status);
          if (
            score === null ||
            score < votingMilestones.close ||
            score >= votingMilestones.target ||
            Math.abs(Date.now() - Date.parse(current.observedAt)) > 30_000
          )
            throw new Error("Score cutoff no longer confirmed.");
        }
        const seconds = current.status.matchSeconds;
        const roundStart =
          typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
            ? Date.parse(current.observedAt) - seconds * 1000
            : null;
        if (
          !Number.isFinite(Date.parse(current.observedAt)) ||
          (vote.roundStartedAt !== null &&
            (roundStart === null ||
              !Number.isFinite(roundStart) ||
              Math.abs(roundStart - vote.roundStartedAt.getTime()) > 30_000)) ||
          !sameMap(current.status.map, vote.currentMap) ||
          this.stopped
        )
          throw new Error("Round cannot be confirmed.");
        if ((await this.store.get(vote.id))?.state !== "closing" || this.stopped) return;
        actionStarted = true;
        const result = await this.admin.act(actor, {
          id: vote.id,
          action: "map-next",
          reason: `Discord map vote ${vote.id}`,
          revision: vote.revision,
          currentIndex: vote.currentIndex,
          currentMap: vote.currentMap,
          entry: vote.choices[vote.winner],
        });
        if (result.state === "applied" || result.state === "pending") {
          state = "queued";
          message = "The winning map was saved in the next rotation position. The current match continues.";
        } else message = result.message;
      }
    } catch {
      state = actionStarted ? "needs_review" : "cancelled";
      message = actionStarted
        ? "The queue result is unconfirmed. Review the winner and action receipt."
        : "The position, settings, connection or staff access changed or could not be read. The ballot closed without sending a queue change.";
    }
    const finished = await this.store.finish(vote.id, state, message);
    if (finished) await this.updateMessage(finished);
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
