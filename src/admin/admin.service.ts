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
import { RconError, WardogsClient } from "./wardogs.client";

@Injectable()
export class AdminService {
  private readonly reads = new Map<string, { until: number; promise: Promise<unknown> }>();
  private readonly lastActions = new Map<string, number>();
  constructor(
    private readonly game: WardogsClient,
    private readonly store: AdminStore,
  ) {}

  async read(resource: string) {
    const readers: Record<string, () => Promise<unknown>> = {
      overview: () => this.game.overview(),
      bans: () => this.game.bans(),
      whitelist: () => this.game.whitelist(),
      catalog: () => this.game.catalog(),
      rotation: () => this.game.rotation(),
      audit: () => this.store.history(),
    };
    if (!Object.hasOwn(readers, resource)) throw new BadRequestException("Unknown dashboard page.");
    const cached = this.reads.get(resource);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { until: Date.now() + 10_000, promise: readers[resource]() };
    // The roster is shared with the community worker in WardogsClient.
    if (resource !== "overview") this.reads.set(resource, entry);
    try {
      return await entry.promise;
    } catch (error) {
      if (this.reads.get(resource) === entry) this.reads.delete(resource);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        error instanceof RconError
          ? error.message
          : "This page could not be loaded. Check the dashboard connection and database setup.",
      );
    }
  }

  async act(staff: Staff, input: unknown) {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join(" "));
    const action = parsed.data;
    if (!canAct(staff.role, action.action)) throw new ForbiddenException("Your staff role cannot perform this action.");
    if ("steamId" in action && "confirm" in action && action.confirm !== action.steamId)
      throw new BadRequestException("The confirmation SteamID does not match the target player.");
    if ((this.lastActions.get(staff.id) ?? 0) > Date.now() - 1000)
      throw new HttpException("Wait a moment before sending another action.", 429);
    if (this.lastActions.size > 1000) this.lastActions.clear();
    this.lastActions.set(staff.id, Date.now());
    const requestHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    let started: Awaited<ReturnType<AdminStore["begin"]>>;
    try {
      started = await this.store.begin(staff, action, requestHash);
    } catch {
      throw new ServiceUnavailableException("The action could not be recorded, so nothing was sent to the game.");
    }
    if (!started.created) {
      if (started.record.actorId !== staff.id || started.record.requestHash !== requestHash)
        throw new ConflictException("This action ID was already used for a different request.");
      return {
        id: action.id,
        state: started.record.state === "started" ? "unknown" : started.record.state,
        message:
          started.record.state === "started"
            ? "This action was already started. Its result is unknown; check the game before submitting another action."
            : started.record.message,
      };
    }
    let result: ActionResult;
    try {
      result = await this.game.execute(action);
    } catch (error) {
      result = {
        state: error instanceof RconError && !error.unknownResult ? "failed" : "unknown",
        message:
          error instanceof RconError
            ? error.message
            : "The result could not be confirmed. Check the game before repeating the action.",
      };
    }
    this.reads.clear();
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

  async receipt(id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new BadRequestException("Enter a valid action ID.");
    try {
      return { record: await this.store.receipt(parsed.data.toLowerCase()) };
    } catch {
      throw new ServiceUnavailableException("The action receipt could not be loaded. Try again shortly.");
    }
  }
}
