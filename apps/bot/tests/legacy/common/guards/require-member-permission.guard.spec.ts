import { Logger } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { APP_FILTER, ExternalContextCreator } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  ChatInputCommandInteraction,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import { NecordParamsFactory } from "necord";
import { AppExceptionFilter } from "../../../../src/common/filters/app-exception.filter";
import { RequiredMemberPermission } from "../../../../src/common/guards/require-member-permission.guard";

@RequiredMemberPermission(PermissionFlagsBits.ManageGuild)
class GuardedCommand {
  ran = false;

  handle() {
    this.ran = true;
  }
}

type Where = "text channel" | "thread" | "uncached channel" | "DM";

afterEach(() => jest.restoreAllMocks());

/** Runs the command the way Necord does, with the guard and the app's global exception filter. */
async function run(where: Where, memberPermissions: bigint[] | null) {
  const errorLog = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  const channel =
    where === "text channel"
      ? Object.create(TextChannel.prototype)
      : where === "thread"
        ? Object.create(ThreadChannel.prototype)
        : null;
  const guildId = where === "DM" ? null : "guild-1";
  const interaction = Object.assign(Object.create(ChatInputCommandInteraction.prototype), {
    client: {
      channels: { cache: new Map(channel ? [["channel-1", channel]] : []) },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    },
    type: InteractionType.ApplicationCommand,
    channelId: "channel-1",
    guildId,
    memberPermissions: memberPermissions ? new PermissionsBitField(memberPermissions).freeze() : null,
    deferred: false,
    replied: false,
  });
  const reply = jest.fn(() => {
    interaction.replied = true;
  });
  const editReply = jest.fn();
  Object.assign(interaction, { reply, editReply });

  const moduleRef = await Test.createTestingModule({
    providers: [GuardedCommand, { provide: APP_FILTER, useClass: AppExceptionFilter }],
  }).compile();
  const command = moduleRef.get(GuardedCommand);
  const handler = moduleRef
    .get(ExternalContextCreator, { strict: false })
    .create(
      command,
      GuardedCommand.prototype.handle,
      "handle",
      ROUTE_ARGS_METADATA,
      new NecordParamsFactory(),
      undefined,
      undefined,
      { guards: true, filters: true, interceptors: true },
      "necord",
    );
  await handler([interaction], {});
  return { ran: command.ran, reply, editReply, errorLog };
}

describe("RequireMemberPermissionGuard", () => {
  it.each<Where>(["text channel", "thread", "uncached channel"])(
    "refuses a member without the permission in a %s with the reason, without logging an error",
    async (where) => {
      const { ran, reply, editReply, errorLog } = await run(where, [PermissionFlagsBits.SendMessages]);
      expect(ran).toBe(false);
      expect(reply).toHaveBeenCalledWith({
        content: "❌ You need the following permission(s) to use this command: **Manage Server**.",
        flags: MessageFlags.Ephemeral,
      });
      expect(editReply).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it.each<Where>(["text channel", "thread", "uncached channel"])(
    "lets a member with the permission through in a %s",
    async (where) => {
      const { ran, reply } = await run(where, [PermissionFlagsBits.ManageGuild]);
      expect(ran).toBe(true);
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it("refuses a guild interaction whose member permissions are unknown", async () => {
    const { ran, reply, editReply } = await run("thread", null);
    expect(ran).toBe(false);
    expect(reply).toHaveBeenCalledWith({
      content: "❌ You need the following permission(s) to use this command: **Manage Server**.",
      flags: MessageFlags.Ephemeral,
    });
    expect(editReply).not.toHaveBeenCalled();
  });

  it("leaves DMs alone, where there are no server permissions to check", async () => {
    const { ran, reply } = await run("DM", null);
    expect(ran).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });
});
