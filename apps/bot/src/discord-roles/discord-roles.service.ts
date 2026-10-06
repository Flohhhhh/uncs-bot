import { Injectable } from "@nestjs/common";
import { acknowledged } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
@Injectable()
export class DiscordRolesService {
  constructor(private readonly remote: RemoteService) {}
  async memberJoined(guildId: string, userId: string) {
    try {
      await this.remote.request("/internal/v1/roles/member-joined", acknowledged, { guildId, userId });
    } catch {
      console.warn("Earned role reconciliation could not be requested.");
    }
  }
}
