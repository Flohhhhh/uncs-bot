import { ServiceCallError } from "@uncs/api-client";
import { HttpException } from "@nestjs/common";
import { InteractionError } from "../src/common/errors/interaction-error";
import { WelcomeService } from "../src/welcome/welcome.service";
import { MapVotesService } from "../src/map-votes/map-votes.service";
import type { RemoteService } from "../src/internal/transport";
const context = {
  interactionId: "100000000000000001",
  guildId: "200000000000000001",
  userId: "300000000000000001",
  channelId: null,
};
it("preserves a confirmed welcome validation refusal for the private interaction reply", async () => {
  const remote = {
    request: jest
      .fn()
      .mockRejectedValue(
        new ServiceCallError("rejected", 400, { message: "Welcome message needs text between the separators." }),
      ),
  };
  await expect(
    new WelcomeService(remote as unknown as RemoteService).setMessage(context.guildId, "---", context),
  ).rejects.toBeInstanceOf(InteractionError);
  expect(remote.request).toHaveBeenCalledTimes(1);
});
it("preserves ballot refusals and never retries an unknown API result", async () => {
  const remote = {
    request: jest.fn().mockRejectedValue(new ServiceCallError("rejected", 409, { message: "Ballot is closed." })),
  };
  const votes = new MapVotesService(remote as unknown as RemoteService);
  await expect(
    votes.cast("id", "0", context.userId, context.guildId, "channel", "message", true, context.interactionId),
  ).rejects.toBeInstanceOf(HttpException);
  remote.request.mockReset().mockRejectedValue(new ServiceCallError("unknown"));
  await expect(
    votes.cast("id", "0", context.userId, context.guildId, "channel", "message", true, context.interactionId),
  ).rejects.toMatchObject({ outcome: "unknown" });
  expect(remote.request).toHaveBeenCalledTimes(1);
});
