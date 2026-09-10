import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { NecordExecutionContext } from "necord";
import { ActivityLogger } from "./activity-logger.service";

type Entity = Record<string, unknown>;

@Injectable()
export class EventLoggingInterceptor implements NestInterceptor {
  constructor(private readonly activityLogger: ActivityLogger) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const necordContext = NecordExecutionContext.create(context);
    const discovery = necordContext.getDiscovery();

    if (necordContext.getType() === "necord" && discovery?.isListener()) {
      const eventArgs = necordContext.getContext<unknown[]>();
      const actor = this.findActor(eventArgs);
      const guild = this.findGuild(eventArgs);

      this.activityLogger.logEvent({
        event: discovery.getEvent(),
        actor: actor?.name ?? "unknown actor",
        actorId: actor?.id,
        guild,
      });
    }

    return next.handle();
  }

  private findActor(values: unknown[]): { name: string; id?: string } | undefined {
    for (const value of values) {
      const entity = this.asEntity(value);
      if (!entity) continue;

      const nestedUser = this.asEntity(entity.user) ?? this.asEntity(entity.author);
      const actor = nestedUser ?? entity;
      const name = this.firstString(actor.tag, actor.username, actor.displayName);
      const id = this.asString(actor.id);

      if (name) {
        return { name: name ?? "unknown actor", id };
      }
    }

    return undefined;
  }

  private findGuild(values: unknown[]): string | undefined {
    for (const value of values) {
      const entity = this.asEntity(value);
      const guild = entity ? this.asEntity(entity.guild) : undefined;
      if (!guild) continue;

      const name = this.asString(guild.name);
      const id = this.asString(guild.id);
      if (name && id) return `${name} (${id})`;
      if (name || id) return name ?? id;
    }

    return undefined;
  }

  private asEntity(value: unknown): Entity | undefined {
    return typeof value === "object" && value !== null ? (value as Entity) : undefined;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private firstString(...values: unknown[]): string | undefined {
    return values.map((value) => this.asString(value)).find((value): value is string => value !== undefined);
  }
}
