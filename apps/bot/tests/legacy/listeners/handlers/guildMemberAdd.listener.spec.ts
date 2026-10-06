import { Logger } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { APP_FILTER, ExternalContextCreator } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { DiscordAPIError, TextChannel } from "discord.js";
import { NecordParamsFactory } from "necord";
import { createHash } from "node:crypto";
import { AppExceptionFilter } from "../../../../src/common/filters/app-exception.filter";
import { WelcomeService } from "../../../../src/welcome/welcome.service";
import { GuildMemberAddListener } from "../../../../src/listeners/handlers/guildMemberAdd.listener";

afterEach(() => jest.restoreAllMocks());

function discordError(code: number, status: number) {
  return new DiscordAPIError({ code, message: "Refused" }, code, status, "POST", "/channels/channel-1/messages", {});
}

/** Runs a member join the way Necord does, with the app's global exception filter. */
async function join(sendError?: Error, joinedTimestamp = 1_790_000_000_000) {
  const warnLog = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  const errorLog = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  const channel = Object.assign(Object.create(TextChannel.prototype), {
    id: "channel-1",
    messages: {},
    send: jest.fn(() => (sendError ? Promise.reject(sendError) : Promise.resolve())),
  });
  const member = {
    id: "member-1",
    joinedTimestamp,
    guild: { id: "guild-1", systemChannel: channel },
    toString: () => "<@member-1>",
  };
  const welcomeService = {
    getSettings: jest.fn().mockResolvedValue({ enabled: true, message: "Welcome {user}" }),
    createEmbed: jest.fn().mockReturnValue({}),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      GuildMemberAddListener,
      { provide: WelcomeService, useValue: welcomeService },
      { provide: APP_FILTER, useClass: AppExceptionFilter },
    ],
  }).compile();
  const handler = moduleRef
    .get(ExternalContextCreator, { strict: false })
    .create(
      moduleRef.get(GuildMemberAddListener),
      GuildMemberAddListener.prototype.handleGuildMemberAdd,
      "handleGuildMemberAdd",
      ROUTE_ARGS_METADATA,
      new NecordParamsFactory(),
      undefined,
      undefined,
      { guards: true, filters: true, interceptors: true },
      "necord",
    );
  await handler([member], {});
  return { send: channel.send, warnLog, errorLog };
}

describe("GuildMemberAddListener", () => {
  it.each([
    [50013, "Missing Permissions"],
    [50001, "Missing Access"],
  ])(
    "warns, without the member's details, when Discord refuses the welcome for missing permissions (%i %s)",
    async (code) => {
      const { send, warnLog, errorLog } = await join(discordError(code, 403));
      expect(send).toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledTimes(1);
      const [message] = warnLog.mock.calls[0];
      expect(message).toBe(
        `Cannot send welcome message in guild guild-1: Discord refused it for missing permissions in system channel channel-1 (code ${code}). The bot needs View Channel, Send Messages and Embed Links there.`,
      );
      expect(message).not.toContain("member-1");
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it("still reports other send failures as errors", async () => {
    const { warnLog, errorLog } = await join(discordError(0, 500));
    expect(warnLog).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("sends each join's welcome with one deterministic nonce Discord enforces, so a resend returns the first", async () => {
    const first = await join();
    const again = await join();
    const rejoin = await join(undefined, 1_790_000_060_000);
    const sentWith = (send: jest.Mock) => (send.mock.calls[0] as [{ nonce: string; enforceNonce: boolean }])[0];

    expect(sentWith(first.send)).toEqual(
      expect.objectContaining({
        nonce: createHash("sha256").update("guild-welcome:guild-1:member-1:1790000000000").digest("hex").slice(0, 25),
        enforceNonce: true,
      }),
    );
    expect(sentWith(first.send).nonce).toHaveLength(25);
    expect(sentWith(again.send).nonce).toBe(sentWith(first.send).nonce);
    expect(sentWith(rejoin.send).nonce).not.toBe(sentWith(first.send).nonce);
  });

  it("sends the welcome without warnings when Discord accepts it", async () => {
    const { send, warnLog, errorLog } = await join();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: "👋 <@member-1>" }));
    expect(warnLog).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
