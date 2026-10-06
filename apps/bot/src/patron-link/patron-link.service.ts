import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { patronReply, type InteractionContext } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
import { issuedReply } from "./patron-link.copy";
export type PatronLinkRequest = InteractionContext;
export type PatronLinkReply = { content: string; components?: ReturnType<typeof issuedReply>["components"] };
export function patronLinkRequest(interaction: {
  id: string;
  guildId: string | null;
  channelId: string | null;
  user: { id: string };
}): PatronLinkRequest {
  return {
    interactionId: interaction.id,
    guildId: interaction.guildId!,
    channelId: interaction.channelId,
    userId: interaction.user.id,
  };
}
@Injectable()
export class PatronLinkService {
  constructor(private readonly remote: RemoteService) {}
  async request(context: PatronLinkRequest): Promise<PatronLinkReply> {
    const reply = await this.remote.request("/internal/v1/patreon/request", patronReply, context);
    return reply.url ? issuedReply(reply.url) : reply;
  }
  panel(context: PatronLinkRequest) {
    return this.remote.request("/internal/v1/patreon/panel", z.string(), context);
  }
}
