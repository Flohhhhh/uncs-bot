import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AdminStore } from "./admin.store";
import { actionSchema, canAct, type ActionResult, type Staff } from "./admin.types";
import { RconError } from "./wardogs.client";
import { GameServers } from "./game-servers";
import { auditAction } from "./server-configuration";

@Injectable()
export class AdminService {
  private readonly reads = new Map<string, { until: number; promise: Promise<unknown> }>();
  private readonly lastActions = new Map<string, number>();
  constructor(
    private readonly servers: GameServers,
    private readonly store: AdminStore,
  ) {}

  async read(resource: string, serverId?: string) {
    const id = this.servers.resolve(serverId),
      game = () => this.servers.get(id);
    const readers: Record<string, () => Promise<unknown>> = {
      overview: () => game().overview(),
      bans: () => game().bans(),
      whitelist: () => game().whitelist(),
      catalog: () => game().catalog(),
      rotation: () => game().rotation(),
      audit: () => this.store.history(id),
      "game-log": () => game().gameLog(),
      "server-identity": () => game().identity(),
      "rotation-check": () => game().checkRotation(),
    };
    if (!Object.hasOwn(readers, resource)) throw new BadRequestException("Unknown dashboard page.");
    const key = `${id}:${resource}`;
    const cached = this.reads.get(key);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { until: Date.now() + 10_000, promise: readers[resource]() };
    // The roster is shared with the community worker in WardogsClient.
    if (resource !== "overview") this.reads.set(key, entry);
    try {
      return await entry.promise;
    } catch (error) {
      if (this.reads.get(key) === entry) this.reads.delete(key);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        error instanceof RconError
          ? error.message
          : error instanceof z.ZodError
            ? "The game returned data this dashboard could not read. Refresh or report this page to staff."
            : "This page could not be loaded. Check the dashboard connection and database setup.",
      );
    }
  }

  async configuration(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can read server settings.");
    try {
      return await this.servers.get(this.servers.resolve(staff.serverId)).configuration();
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof RconError ? error.message : "Server settings could not be read safely. Check the host panel.",
      );
    }
  }
  gameLog(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can read the game command log.");
    return this.read("game-log", staff.serverId);
  }
  rotationCheck(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can check saved server settings.");
    return this.read("rotation-check", staff.serverId);
  }
  async mapOptions(map: string, serverId?: string) {
    if (!/^[\w./-]{1,150}$/.test(map)) throw new BadRequestException("Choose a valid map.");
    try {
      return await this.servers.get(this.servers.resolve(serverId)).mapOptions(map);
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof RconError ? error.message : "The map options could not be read.",
      );
    }
  }

  async act(staff: Staff, input: unknown): Promise<ActionResult & { id: string }> {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join(" "));
    const serverId = this.servers.resolve(staff.serverId ?? parsed.data.serverId);
    if (staff.serverId && parsed.data.serverId && staff.serverId !== parsed.data.serverId)
      throw new BadRequestException("The reviewed server does not match this request.");
    const serverVersion = parsed.data.serverVersion ?? staff.serverVersion;
    this.servers.checkVersion(serverId, serverVersion);
    const action = { ...parsed.data, serverId, ...(serverVersion ? { serverVersion } : {}) };
    if (!canAct(staff.role, action.action)) throw new ForbiddenException("Your staff role cannot perform this action.");
    if ("steamId" in action && "confirm" in action && action.confirm !== action.steamId)
      throw new BadRequestException("The confirmation SteamID does not match the target player.");
    const actorKey = `${serverId}:${staff.id}`;
    if ((this.lastActions.get(actorKey) ?? 0) > Date.now() - 1000)
      throw new HttpException("Wait a moment before sending another action.", 429);
    if (this.lastActions.size > 1000) this.lastActions.clear();
    this.lastActions.set(actorKey, Date.now());
    const requestHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    let started: Awaited<ReturnType<AdminStore["begin"]>>;
    try {
      started = await this.store.begin(staff, auditAction(action), requestHash);
    } catch {
      throw new ServiceUnavailableException("The action could not be recorded, so nothing was sent to the game.");
    }
    if (!started.created) {
      if (started.record.actorId !== staff.id || started.record.requestHash !== requestHash)
        throw new ConflictException("This action ID was already used for a different request.");
      return {
        id: action.id,
        state: z
          .enum(["applied", "accepted", "pending", "failed", "unknown"])
          .catch("unknown")
          .parse(started.record.state),
        message:
          started.record.state === "started"
            ? "This action was already started. Its result is unknown; check the game before submitting another action."
            : started.record.message,
      };
    }
    let result: ActionResult;
    try {
      result = await this.servers.get(serverId).execute(action);
    } catch (error) {
      result = {
        state: error instanceof RconError && !error.unknownResult ? "failed" : "unknown",
        message:
          error instanceof RconError
            ? error.message
            : "The result could not be confirmed. Check the game before repeating the action.",
      };
    }
    for (const key of this.reads.keys()) if (key.startsWith(`${serverId}:`)) this.reads.delete(key);
    try {
      await this.store.finish(action.id, result);
    } catch {
      return {
        id: action.id,
        state: "unknown",
        message:
          "The game request finished, but its final audit record could not be saved. Check the game and this action ID before repeating it.",
      };
    }
    return { id: action.id, ...result };
  }

  async receipt(id: string, serverId?: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new BadRequestException("Enter a valid action ID.");
    try {
      return { record: await this.store.receipt(parsed.data.toLowerCase(), this.servers.resolve(serverId)) };
    } catch {
      throw new ServiceUnavailableException("The action receipt could not be loaded. Try again shortly.");
    }
  }
}
