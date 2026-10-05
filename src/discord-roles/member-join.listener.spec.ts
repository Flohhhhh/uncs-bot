import type { GuildMember } from "discord.js";
import { DiscordRolesMemberJoinListener } from "../listeners/handlers/discord-roles-member-join.listener";
import type { DiscordRolesService } from "./discord-roles.service";

it("passes each join to the role service, which ignores servers other than ADMIN_GUILD_ID", () => {
  const roles = { memberJoined: jest.fn() };
  const listener = new DiscordRolesMemberJoinListener(roles as unknown as DiscordRolesService);
  listener.handleGuildMemberAdd([{ id: "300000000000000001", guild: { id: "100000000000000001" } } as GuildMember]);
  expect(roles.memberJoined).toHaveBeenCalledWith("100000000000000001", "300000000000000001");
});
