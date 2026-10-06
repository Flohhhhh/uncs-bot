import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { acknowledged, readiness } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
import type { CommunitySnapshot } from "./community-state";
@Injectable()
export class CommunityDiscord {
  constructor(private readonly remote: RemoteService) {}
  async ready() {
    try {
      return (await this.remote.request("/internal/v1/discord/ready", readiness)).gateway === true;
    } catch {
      return false;
    }
  }
  edit(guildId: string, channelId: string, messageId: string, snapshot: CommunitySnapshot | null, online: boolean) {
    return this.remote.request("/internal/v1/community/edit", acknowledged, {
      guildId,
      channelId,
      messageId,
      snapshot,
      online,
      operationId: randomUUID(),
    });
  }
}
