import { HttpException, Injectable } from "@nestjs/common";
import { ServiceCallError } from "@uncs/api-client";
import { voteCastResult } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
@Injectable()
export class MapVotesService {
  constructor(private readonly remote: RemoteService) {}
  cast(
    id: string,
    choice: string,
    userId: string,
    guildId: string | null,
    channelId: string,
    messageId: string,
    eligible: boolean,
    interactionId: string,
  ) {
    return this.remote
      .request("/internal/v1/votes/cast", voteCastResult, {
        id,
        choice,
        messageId,
        context: { interactionId, userId, guildId, channelId },
      })
      .catch((error: unknown) => {
        const message =
          error instanceof ServiceCallError && error.outcome === "rejected"
            ? (error.details as { message?: unknown })?.message
            : undefined;
        if (typeof message === "string" && error instanceof ServiceCallError)
          throw new HttpException(message, error.status ?? 400);
        throw error;
      });
  }
}
