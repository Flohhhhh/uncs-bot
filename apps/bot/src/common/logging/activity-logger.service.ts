import { Injectable } from "@nestjs/common";

export interface CommandLogEntry {
  command: string;
  actor: string;
  actorId: string;
  guild?: string;
}

export interface EventLogEntry {
  event: string;
  actor: string;
  actorId?: string;
  guild?: string;
}

@Injectable()
export class ActivityLogger {
  logCommand({ command, actor, actorId, guild }: CommandLogEntry) {
    console.info(`[discord-command] ${actor} (${actorId}) ran /${command}${guild ? ` in ${guild}` : ""}`);
  }

  logEvent({ event, actor, actorId, guild }: EventLogEntry) {
    const actorDetails = actorId ? `${actor} (${actorId})` : actor;
    console.info(`[discord-event] ${event} triggered by ${actorDetails}${guild ? ` in ${guild}` : ""}`);
  }
}
