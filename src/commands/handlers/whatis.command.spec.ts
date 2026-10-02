import { Logger } from "@nestjs/common";
import { Collection, GatewayIntentBits, GuildMember, IntentsBitField, Role, type APIEmbedField } from "discord.js";
import type { SlashCommandContext } from "necord";
import { WhatisCommand } from "./whatis.command";

function fixture() {
  const interaction = {
    deferred: false,
    deferReply: jest.fn(() => {
      interaction.deferred = true;
      return Promise.resolve();
    }),
    editReply: jest.fn(),
    reply: jest.fn(),
  };
  const context = [interaction] as unknown as SlashCommandContext;
  const sent = (): APIEmbedField[] => {
    const send = interaction.deferred ? interaction.editReply : interaction.reply;
    expect(send).toHaveBeenCalledTimes(1);
    const [[{ embeds }]] = send.mock.calls as [[{ embeds: { data: { fields: APIEmbedField[] } }[] }]];
    return embeds[0].data.fields;
  };
  const field = (name: string) => sent().find((f) => f.name === name)?.value;
  return { command: new WhatisCommand(), interaction, context, field };
}

function memberWithRoles(names: string[]) {
  const roles = new Collection<string, { id: string; name: string; position: number }>();
  roles.set("guild-1", { id: "guild-1", name: "@everyone", position: 0 });
  names.forEach((name, index) => roles.set(`role-${index}`, { id: `role-${index}`, name, position: index + 1 }));
  const member = Object.create(GuildMember.prototype) as GuildMember;
  Object.defineProperties(member, {
    id: { value: "member-1" },
    guild: { value: { id: "guild-1" } },
    user: { value: { displayName: "Bob", displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png" } },
    joinedAt: { value: new Date("2026-01-01T00:00:00Z") },
    roles: { value: { cache: roles } },
  });
  return member;
}

describe("/whatis on a member", () => {
  it("keeps a long role list within Discord's 1024-character field limit and says how many are left out", async () => {
    const { command, context, field } = fixture();
    const names = Array.from({ length: 60 }, (_, i) => `Game Role Number ${String(i).padStart(2, "0")}`);
    await command.handleWhatis(context, { thing: memberWithRoles(names) });

    const roles = field("Roles")!;
    expect(roles.length).toBeLessThanOrEqual(1024);
    const match = /, and (\d+) more$/.exec(roles);
    expect(match).not.toBeNull();
    const shown = roles.slice(0, match!.index).split(", ");
    expect(shown.length + Number(match![1])).toBe(60);
    expect(shown[0]).toBe("Game Role Number 59");
    expect(roles).not.toContain("@everyone");
  });

  it("lists every role, highest first and without @everyone, when they fit", async () => {
    const { command, context, field } = fixture();
    await command.handleWhatis(context, { thing: memberWithRoles(["Squad Lead", "Medic", "Admin"]) });
    expect(field("Roles")).toBe("Admin, Medic, Squad Lead");
  });

  it("says None for a member with no roles besides @everyone", async () => {
    const { command, context, field } = fixture();
    await command.handleWhatis(context, { thing: memberWithRoles([]) });
    expect(field("Roles")).toBe("None");
  });
});

function roleInGuild({
  intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  memberCount = 300,
  fetchFails = false,
} = {}) {
  const cache = new Collection<string, { _roles: string[] }>([
    ["bot", { _roles: [] }],
    ["cached-holder", { _roles: ["role-1"] }],
  ]);
  const fetch = jest.fn(() => {
    if (fetchFails) return Promise.reject(new Error("Gateway rate limited"));
    for (let i = 0; i < memberCount - 2; i++) cache.set(`member-${i}`, { _roles: i < 149 ? ["role-1"] : [] });
    return Promise.resolve(cache);
  });
  const guild = {
    id: "guild-1",
    memberCount,
    members: { cache, fetch },
    client: { options: { intents: new IntentsBitField(intents) } },
  };
  const role = Object.assign(Object.create(Role.prototype) as Role, {
    id: "role-1",
    name: "Squad",
    color: 0,
    mentionable: false,
    guild,
  });
  Object.defineProperty(role, "hexColor", { value: "#000000" });
  return { role, fetch };
}

describe("/whatis on a role", () => {
  it("loads the full member list before counting, so the count is not just the cached members", async () => {
    const { command, interaction, context, field } = fixture();
    const { role, fetch } = roleInGuild();
    await command.handleWhatis(context, { thing: role });

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
    expect(field("Members")).toBe("150");
  });

  it("counts straight from the cache when every member is already loaded", async () => {
    const { command, context, field } = fixture();
    const { role, fetch } = roleInGuild({ memberCount: 2 });
    await command.handleWhatis(context, { thing: role });

    expect(fetch).not.toHaveBeenCalled();
    expect(field("Members")).toBe("1");
  });

  it("labels the count as a minimum when the bot cannot load the member list", async () => {
    const { command, context, field } = fixture();
    const { role, fetch } = roleInGuild({ intents: [GatewayIntentBits.Guilds] });
    await command.handleWhatis(context, { thing: role });

    expect(fetch).not.toHaveBeenCalled();
    expect(field("Members")).toBe("At least 1 (not every member is loaded)");
  });

  it("labels the count as a minimum when loading the member list fails", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { command, context, field } = fixture();
    const { role } = roleInGuild({ fetchFails: true });
    await command.handleWhatis(context, { thing: role });

    expect(field("Members")).toBe("At least 1 (not every member is loaded)");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Gateway rate limited"));
    warn.mockRestore();
  });
});
