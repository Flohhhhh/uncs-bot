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
import { createHash } from "node:crypto";
import { z } from "zod";
import { AdminAuth } from "../admin/admin.auth";
import { AdminService } from "../admin/admin.service";
import { GameServers } from "../admin/game-servers";
import { validateMapSelection } from "../admin/server-configuration";
import { sameMap } from "../common/map-labels";
import type { Staff } from "../admin/admin.types";
import { EnvService } from "../env/env.service";
import { MapVotesStore } from "./map-votes.store";
import { MapVotesDiscord } from "./map-votes.discord";
import { cancelMapVoteSchema, mapVoteView, startMapVoteSchema, type MapVoteRecord } from "./map-votes.types";

@Injectable()
export class MapVotesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MapVotesService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
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
  private enabled() {
    const options = this.options();
    if (!options.enabled)
      throw new ServiceUnavailableException(
        "Map voting is not enabled. Its database and Discord channel need owner setup.",
      );
    return { guildId: options.guildId!, channelId: options.channelId! };
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
  async start(staff: Staff, input: unknown) {
    this.requireStaff(staff);
    const configured = this.enabled();
    const parsed = startMapVoteSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException("Choose two to five different maps, a 2–30 minute duration and a reason.");
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
    if (action.choices.some((choice) => sameMap(choice.map, settings.rotation.currentMap)))
      throw new BadRequestException("Leave the current map out of this ballot.");
    const capabilities = await game.capabilities(),
      catalog = await game.catalog();
    for (const choice of action.choices) await validateMapSelection(game, choice, capabilities, catalog);
    const overview = await game.overview();
    const seconds = overview.status.matchSeconds;
    const observedAt = Date.parse(overview.observedAt);
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isFinite(observedAt) ||
      overview.status.map !== settings.rotation.currentMap
    )
      throw new ConflictException(
        "The current round and its clock could not be confirmed. Refresh before starting a vote.",
      );
    await this.discord.check(configured.guildId, configured.channelId);
    if (this.stopped) throw new ServiceUnavailableException("Gramps is stopping. No ballot was created.");
    const now = new Date();
    const started = await this.store.create({
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
      roundStartedAt: new Date(observedAt - seconds * 1000),
      closesAt: new Date(now.getTime() + action.minutes * 60_000),
      counts: action.choices.map(() => 0),
      createdAt: now,
      updatedAt: now,
    });
    if (!started.created) return mapVoteView(started.record);
    let record = started.record;
    try {
      if (this.stopped) throw new Error("Gramps is stopping.");
      const messageId = await this.discord.publish(record);
      const published = await this.store.published(record.id, messageId);
      if (!published) throw new Error("Publication was interrupted.");
      record = published;
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
        const vote = await this.store.claimClose(due.id);
        if (!vote) continue;
        await this.close(vote);
      }
    } catch {
      this.logger.warn(
        "Map voting could not complete its observation. Recorded work is retained; uncertain actions are not replayed.",
      );
    } finally {
      this.running = false;
    }
  }
  private async close(vote: MapVoteRecord) {
    let state: "queued" | "no_votes" | "needs_review" = "needs_review";
    let message = "The next map was not confirmed. Check the ballot's action receipt before changing the rotation.";
    try {
      if (vote.winner === null) {
        state = "no_votes";
        message = "No votes were cast. The rotation was left unchanged.";
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
        const current = await this.servers.get(vote.serverId).overview();
        const seconds = current.status.matchSeconds;
        const roundStart =
          typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
            ? Date.parse(current.observedAt) - seconds * 1000
            : null;
        if (
          roundStart === null ||
          !Number.isFinite(roundStart) ||
          vote.roundStartedAt === null ||
          Math.abs(roundStart - vote.roundStartedAt.getTime()) > 30_000 ||
          current.status.map !== vote.currentMap ||
          this.stopped
        )
          throw new Error("Round cannot be confirmed.");
        if ((await this.store.get(vote.id))?.state !== "closing" || this.stopped)
          throw new Error("Ballot no longer closing.");
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
      message =
        "The round, settings, connection or staff access changed. No confirmed queue change; review the winner and action receipt.";
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
