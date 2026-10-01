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
import { actionSchema, type ActionResult, type Staff } from "../admin/admin.types";
import { GameServers } from "../admin/game-servers";
import { serves } from "../common/admin-policy";
import { EnvService } from "../env/env.service";
import { completeEventOperation, eventRoster, operation, planEvent } from "./event-planner";
import { ServerEventsStore } from "./server-events.store";
import {
  eventView,
  initialEventProgress,
  observedRound,
  sameRound,
  restoreEventSchema,
  startEventSchema,
  stopEventSchema,
  type EventOperation,
  type EventProgress,
  type EventRecord,
  type EventState,
} from "./server-events.types";

@Injectable()
export class ServerEventsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ServerEventsService.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly running = new Set<string>();
  constructor(
    private readonly store: ServerEventsStore,
    private readonly servers: GameServers,
    private readonly admin: AdminService,
    private readonly auth: AdminAuth,
    private readonly env: EnvService,
  ) {}
  private enabled() {
    return this.env.get("SERVER_EVENTS_ENABLED") === true;
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
    const lock = settings.fields.find((field) => field.id === "lockOverpopulated");
    if (settings.revision !== revision || typeof lock?.value !== "boolean" || (lock.value && !lock.editable))
      throw new ConflictException(
        "Refresh settings. The team lock must be readable, and editable if it is currently on.",
      );
    const snapshot = await game.overview(),
      round = observedRound(snapshot);
    if (!round) throw new ConflictException("The game must report a current round clock before an event can be armed.");
    try {
      eventRoster({ options }, snapshot);
    } catch (error) {
      throw new ConflictException((error as Error).message);
    }
    if (snapshot.players.length !== snapshot.status.players.current)
      throw new ConflictException("The roster is changing. Refresh before arming the event.");
    const capabilities = snapshot.capabilities;
    const routes = [
      ["PATCH", "/v1/players/{id}"],
      ["POST", "/v1/broadcast"],
      ["POST", "/v1/players/{id}/message"],
      ...(options.forceRespawn ? [["POST", "/v1/players/{id}/kill"]] : []),
      ...(lock.value ? [["PUT", "/v1/config"]] : []),
    ];
    if (routes.some(([method, path]) => !serves(capabilities, method, path)))
      throw new ConflictException("The current game build does not advertise all controls needed by this event.");
    const allowance = capabilities.limits?.maxRequestsPerMinutePerIp;
    if (allowance && allowance < 30)
      throw new ConflictException(
        "The reported game request allowance is too low for this event's observation and move checks.",
      );
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
      originalLock: lock.value,
      initialRevision: revision,
      progress: initialEventProgress(round, now.getTime()),
      createdAt: now,
      updatedAt: now,
      endsAt: new Date(now.getTime() + options.durationMinutes * 60_000),
    });
    return eventView(started.event);
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
  private async problem(event: EventRecord, message: string) {
    await this.store.observe(event.id, event.version, { state: "needs_review", progress: event.progress, message });
  }
  /** At most one recorded effect per pass, with storage claims coordinating multiple instances. */
  async tick(id?: string): Promise<number> {
    if (this.stopped || !this.enabled()) return 30_000;
    const serverId = this.servers.resolve(id);
    if (this.running.has(serverId)) return 30_000;
    this.running.add(serverId);
    try {
      let event = await this.store.current(serverId);
      if (!event) return 15_000;
      if (!event.stop && event.endsAt.getTime() <= Date.now())
        event = await this.store.stop(event.id, {
          id: randomUUID(),
          actorId: "system:event-expiry",
          actorName: "Gramps event deadline",
          reason: "The reviewed event duration ended.",
          at: new Date().toISOString(),
        });
      if (event.operation) {
        await this.store.recover(event, new Date());
        return 15_000;
      }
      if (event.state === "needs_review") return 30_000;
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
      const actor = await this.auth.serverStaff(this.actor(event), serverId, true).catch(() => null);
      if (actor?.role !== "admin") {
        await this.problem(
          event,
          "The responsible staff account no longer has administrator access. New moves have stopped; another administrator must review restoration.",
        );
        return 30_000;
      }
      const game = this.servers.get(serverId);
      const settings = await game.configuration();
      const lock = settings.fields.find((field) => field.id === "lockOverpopulated");
      let op: EventOperation | null = null;
      let progress = event.progress;
      if (event.stop) {
        if (typeof lock?.value !== "boolean" || (!lock.value && settings.revision !== event.restoreRevision)) {
          await this.problem(
            event,
            "Settings changed after the event's team-lock edit. Review the current revision before restoring; no newer edit was overwritten.",
          );
          return 30_000;
        }
        op = operation(event, "restore_lock", {
          action: "settings-save",
          revision: settings.revision,
          changes: { lockOverpopulated: event.originalLock },
        });
      } else if (event.state === "preparing") {
        if (event.originalLock && event.restoreRevision === null) {
          if (settings.revision !== event.initialRevision) {
            await this.problem(event, "Settings changed before event preparation. No team-lock change was sent.");
            return 30_000;
          }
          op = operation(event, "disable_lock", {
            action: "settings-save",
            revision: settings.revision,
            changes: { lockOverpopulated: false },
          });
        } else {
          if (lock?.value !== false) {
            await this.problem(
              event,
              "The saved team lock is not off. Review the game settings before starting team moves.",
            );
            return 30_000;
          }
          op = operation(event, "armed", {
            action: "broadcast",
            message:
              "Optional 50v50 is armed for the next round. Teams may change early; wait for the team notice before buying. Staff can stop this event at any time.",
          });
        }
      } else {
        if (lock?.value !== false) {
          await this.problem(
            event,
            "The team-lock setting changed during the event. Team changes have stopped for staff review.",
          );
          return 30_000;
        }
        const snapshot = await game.overview();
        const plan = planEvent(event, snapshot, Date.now());
        progress = plan.progress;
        op = plan.operation;
        if (!op) await this.store.observe(event.id, event.version, plan);
      }
      if (op && !this.stopped) {
        const claimed = await this.store.claim(event.id, event.version, op, actor, progress);
        if (claimed) await this.execute(claimed, op, actor);
      }
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
  private async execute(event: EventRecord, op: EventOperation, actor: Staff) {
    let result: ActionResult = {
      state: "unknown",
      message: "The event action could not be confirmed. Inspect its receipt before another attempt.",
    };
    let state: EventState = "needs_review",
      progress: EventProgress = event.progress,
      restoreRevision = event.restoreRevision;
    try {
      const latest = await this.store.get(event.id);
      if (
        this.stopped ||
        !latest ||
        latest.operation?.id !== op.id ||
        latest.state === "needs_review" ||
        (latest.stop && op.kind !== "restore_lock") ||
        !this.connected(latest)
      ) {
        result = {
          state: "failed",
          changed: false,
          message: "This event action was stopped before it reached the game.",
        };
        state = latest?.stop ? "stopping" : "needs_review";
      } else {
        actionSchema.parse(op.action);
        // Event ownership is checked separately; the system actor keeps event effects distinct from manual clicks.
        const authorized = await this.auth.serverStaff(actor, event.serverId, true);
        if (authorized.role !== "admin") throw new Error("Administrator access changed.");
        if (op.round) {
          const snapshot = await this.servers.get(event.serverId).overview(),
            current = observedRound(snapshot);
          if (!current || !sameRound(current, op.round) || Date.now() - Date.parse(snapshot.observedAt) > 15_000) {
            await this.store.settle(
              event.id,
              op.id,
              { state: "failed", message: "The round changed or its observation expired. No event action was sent." },
              {
                state: "active",
                progress: { ...event.progress, pendingRespawn: null },
                message: "Waiting for a fresh round observation.",
              },
            );
            return;
          }
        }
        const before = await this.store.get(event.id);
        if (
          this.stopped ||
          before?.operation?.id !== op.id ||
          before.state === "needs_review" ||
          (before.stop && op.kind !== "restore_lock")
        ) {
          await this.store.settle(
            event.id,
            op.id,
            { state: "failed", message: "Event stopped during review. No action was sent." },
            {
              state: before?.stop ? "stopping" : "needs_review",
              progress: event.progress,
              message: "No action was sent after the event stopped.",
            },
          );
          return;
        }
        result = await this.admin.act(
          { ...authorized, id: `system:50v50:${event.id}`, name: `Gramps 50v50 (${actor.name})` },
          op.action,
        );
        if (["move", "respawn"].includes(op.kind) && result.changed === false) {
          state = "active";
          // A helpful manual switch or changed precondition is not authority to kill a player.
          progress = { ...event.progress, pendingRespawn: null };
        } else {
          const accepted =
            op.kind === "move"
              ? result.state === "applied" && result.changed === true
              : ["disable_lock", "restore_lock"].includes(op.kind)
                ? ["applied", "pending"].includes(result.state)
                : ["applied", "accepted"].includes(result.state);
          if (accepted) {
            progress = completeEventOperation(event, op, Date.now());
            state =
              op.kind === "restore_lock"
                ? "complete"
                : op.kind === "disable_lock"
                  ? "preparing"
                  : op.kind === "armed"
                    ? "waiting_round"
                    : op.kind === "round_warning"
                      ? "warming"
                      : "active";
            if (op.kind === "disable_lock") {
              restoreRevision = result.revision ?? null;
              if (!restoreRevision) {
                state = "needs_review";
                result = {
                  state: "unknown",
                  message:
                    "The lock edit was accepted but its exact saved revision is unavailable. Review before event activation or restoration.",
                };
              }
            }
          }
        }
      }
    } catch {
      /* A thrown or lost result never authorizes another automatic attempt. */
    }
    await this.store.settle(event.id, op.id, result, {
      state,
      progress,
      restoreRevision,
      message:
        state === "complete"
          ? "Event stopped. The original team-lock value is saved; verify when the game adopts it."
          : result.message,
    });
  }
}
