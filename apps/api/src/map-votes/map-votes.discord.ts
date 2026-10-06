import { Injectable } from "@nestjs/common";
import { acknowledged, channelView, messageId } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
import type { MapVoteRecord } from "./map-votes.types";
import type { VoteReminder } from "../common/voting-policy";
@Injectable()
export class MapVotesDiscord {
  constructor(private readonly remote: RemoteService) {}
  check(guildId: string, channelId: string) {
    return this.remote.request("/internal/v1/ballots/channel", channelView, { guildId, channelId });
  }
  publish(vote: MapVoteRecord) {
    return this.remote.request("/internal/v1/ballots/publish", messageId, { vote, operationId: `ballot:${vote.id}` });
  }
  findBallotMessage(vote: MapVoteRecord) {
    return this.remote.request("/internal/v1/ballots/find", messageId.nullable(), {
      vote,
      operationId: `find:${vote.id}`,
    });
  }
  remind(vote: MapVoteRecord, stage: VoteReminder) {
    return this.remote.request("/internal/v1/ballots/remind", acknowledged, {
      vote,
      stage,
      operationId: `reminder:${vote.id}:${stage}`,
    });
  }
  update(vote: MapVoteRecord) {
    return this.remote.request("/internal/v1/ballots/update", acknowledged, {
      vote,
      operationId: `update:${vote.id}:${vote.updatedAt.toISOString()}`,
    });
  }
}
