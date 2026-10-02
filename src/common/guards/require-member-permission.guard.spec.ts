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
import { RequiredMemberPermission, RequireMemberPermissionGuard } from "./require-member-permission.guard";

@RequiredMemberPermission(PermissionFlagsBits.ManageGuild)
class GuardedCommand {
  handle() {}
}

type Where = "text channel" | "thread" | "uncached channel" | "DM";

function run(where: Where, memberPermissions: bigint[] | null) {
  const channel =
    where === "text channel"
      ? Object.create(TextChannel.prototype)
      : where === "thread"
        ? Object.create(ThreadChannel.prototype)
        : null;
  const guildId = where === "DM" ? null : "guild-1";
  const reply = jest.fn();
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
    reply,
  });
  const context = new ExecutionContextHost([[interaction], {}], GuardedCommand, GuardedCommand.prototype.handle);
  context.setType("necord");
  const allowed = new RequireMemberPermissionGuard(new Reflector()).canActivate(context);
  return { allowed, reply };
}

describe("RequireMemberPermissionGuard", () => {
  it.each<Where>(["text channel", "thread", "uncached channel"])(
    "refuses a member without the permission in a %s",
    async (where) => {
      const { allowed, reply } = run(where, [PermissionFlagsBits.SendMessages]);
      await expect(allowed).resolves.toBe(false);
      expect(reply).toHaveBeenCalledWith({
        content: "❌ You need the following permission(s) to use this command: **Manage Server**.",
        flags: MessageFlags.Ephemeral,
      });
    },
  );

  it.each<Where>(["text channel", "thread", "uncached channel"])(
    "lets a member with the permission through in a %s",
    async (where) => {
      const { allowed, reply } = run(where, [PermissionFlagsBits.ManageGuild]);
      await expect(allowed).resolves.toBe(true);
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it("refuses a guild interaction whose member permissions are unknown", async () => {
    const { allowed, reply } = run("thread", null);
    await expect(allowed).resolves.toBe(false);
    expect(reply).toHaveBeenCalled();
  });

  it("leaves DMs alone, where there are no server permissions to check", async () => {
    const { allowed, reply } = run("DM", null);
    await expect(allowed).resolves.toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });
});
