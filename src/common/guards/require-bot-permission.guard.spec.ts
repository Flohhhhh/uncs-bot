import { Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import {
  ChatInputCommandInteraction,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import { RequireBotPermissionGuard, RequiredBotPermission } from "./require-bot-permission.guard";

class GuardedCommand {
  @RequiredBotPermission(PermissionFlagsBits.ManageMessages)
  handle() {}
}

type Where = "text channel" | "thread" | "uncached channel" | "DM";

function run(where: Where, botPermissions: bigint[]) {
  const permissions = new PermissionsBitField(botPermissions).freeze();
  const channel =
    where === "text channel"
      ? Object.assign(Object.create(TextChannel.prototype), { permissionsFor: () => permissions })
      : where === "thread"
        ? Object.create(ThreadChannel.prototype)
        : null;
  const guildId = where === "DM" ? null : "guild-1";
  const reply = jest.fn();
  const interaction = Object.assign(Object.create(ChatInputCommandInteraction.prototype), {
    client: {
      channels: { cache: new Map(channel ? [["channel-1", channel]] : []) },
      guilds: { cache: new Map([["guild-1", { id: "guild-1", members: { me: { id: "bot" } } }]]) },
    },
    type: InteractionType.ApplicationCommand,
    channelId: "channel-1",
    guildId,
    appPermissions: permissions,
    deferred: false,
    replied: false,
    reply,
  });
  const context = new ExecutionContextHost([[interaction], {}], GuardedCommand, GuardedCommand.prototype.handle);
  context.setType("necord");
  const allowed = new RequireBotPermissionGuard(new Reflector()).canActivate(context);
  return { allowed, reply };
}

describe("RequireBotPermissionGuard", () => {
  it.each<Where>(["text channel", "thread", "uncached channel"])(
    "explains the missing permission when the bot lacks it in a %s",
    async (where) => {
      const { allowed, reply } = run(where, [PermissionFlagsBits.SendMessages]);
      await expect(allowed).resolves.toBe(false);
      expect(reply).toHaveBeenCalledWith({
        content: "❌ I need the following permission(s) in this channel: **Manage Messages**.",
        flags: MessageFlags.Ephemeral,
      });
    },
  );

  it.each<Where>(["text channel", "thread", "uncached channel"])(
    "lets the command run when the bot has the permission in a %s",
    async (where) => {
      const { allowed, reply } = run(where, [PermissionFlagsBits.ManageMessages]);
      await expect(allowed).resolves.toBe(true);
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it("leaves DMs alone, where there are no server permissions to check", async () => {
    const { allowed, reply } = run("DM", []);
    await expect(allowed).resolves.toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });
});
