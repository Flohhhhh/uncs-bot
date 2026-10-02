import { PermissionFlagsBits, type Client } from "discord.js";
import { DiscordRolesDiscord } from "./discord-roles.discord";

const GUILD = "100000000000000001";
const UNC = "200000000000000001";
const FOUNDER = "200000000000000002";
const SUPPORTER = "200000000000000004";
type FakeRole = ReturnType<typeof role>;
function role(
  id: string,
  name: string,
  options: { position?: number; managed?: boolean; editable?: boolean; permissions?: bigint[] } = {},
) {
  const permissions = options.permissions ?? [];
  return {
    id,
    name,
    position: options.position ?? 1,
    managed: options.managed ?? false,
    editable: options.editable ?? true,
    permissions: { any: (flags: bigint[]) => flags.some((flag) => permissions.includes(flag)) },
  };
}
function fixture(options: { roles?: FakeRole[]; manageRoles?: boolean; members?: Record<string, unknown> } = {}) {
  const roles = options.roles ?? [
    role(UNC, "UNC"),
    role(FOUNDER, "Founder"),
    role(SUPPORTER, "Supporter"),
    role(GUILD, "@everyone", { position: 0 }),
  ];
  const cache = new Map(roles.map((item) => [item.id, item]));
  const fetchMember = jest.fn(async ({ user }: { user: string; force: boolean }) => {
    const member = options.members?.[user];
    if (!member) throw Object.assign(new Error("Unknown Member"), { code: 10007, status: 404 });
    return member;
  });
  const guild = {
    id: GUILD,
    members: {
      me: {
        permissions: {
          has: (flag: bigint) => flag === PermissionFlagsBits.ManageRoles && options.manageRoles !== false,
        },
        roles: { highest: { position: 9 } },
      },
      fetch: fetchMember,
    },
    roles: { cache, fetch: jest.fn(async () => cache) },
  };
  const client = { isReady: () => true, guilds: { fetch: jest.fn(async () => guild) } };
  return { discord: new DiscordRolesDiscord(client as unknown as Client), fetchMember };
}
const ids = { member: UNC, founder: FOUNDER, supporter: SUPPORTER };

describe("Discord role setup checks", () => {
  it("reports every role as assignable with the bot's permission and position", async () => {
    const { discord } = fixture();
    await expect(discord.check(GUILD, ids, [])).resolves.toEqual({
      manageRoles: true,
      highestRolePosition: 9,
      roles: {
        member: expect.objectContaining({ id: UNC, name: "UNC", exists: true, assignable: true, problem: null }),
        founder: expect.objectContaining({
          id: FOUNDER,
          name: "Founder",
          exists: true,
          assignable: true,
          problem: null,
        }),
        supporter: expect.objectContaining({
          id: SUPPORTER,
          name: "Supporter",
          exists: true,
          assignable: true,
          problem: null,
        }),
      },
    });
  });
  it.each([
    ["an administrator role", { permissions: [PermissionFlagsBits.Administrator] }, "moderation or administrator"],
    [
      "a role that can manage messages",
      { permissions: [PermissionFlagsBits.ManageMessages] },
      "moderation or administrator",
    ],
    [
      "a role that can mention everyone",
      { permissions: [PermissionFlagsBits.MentionEveryone] },
      "moderation or administrator",
    ],
    ["an integration role", { managed: true }, "managed by an integration"],
    ["a role above the bot", { editable: false, position: 12 }, `Drag the bot's role above "UNC"`],
  ])("refuses %s with a plain-English fix", async (_label, options, problem) => {
    const { discord } = fixture({ roles: [role(UNC, "UNC", options), role(FOUNDER, "Founder")] });
    const result = await discord.check(GUILD, ids, []);
    expect(result.roles.member).toMatchObject({ assignable: false, problem: expect.stringContaining(problem) });
    expect(result.roles.founder.assignable).toBe(true);
  });
  it("refuses a dashboard staff role, @everyone and one role used for both", async () => {
    const { discord } = fixture();
    expect((await discord.check(GUILD, ids, [UNC])).roles.member).toMatchObject({
      staffRole: true,
      assignable: false,
      problem: expect.stringContaining("staff role"),
    });
    expect((await discord.check(GUILD, { ...ids, member: GUILD }, [])).roles.member).toMatchObject({
      assignable: false,
      problem: expect.stringContaining("@everyone"),
    });
    const same = await discord.check(GUILD, { ...ids, founder: UNC }, []);
    expect(same.roles.member.problem).toContain("two different roles");
    expect(same.roles.founder.problem).toContain("two different roles");
    expect(same.roles.supporter.assignable).toBe(true);
    const supporter = await discord.check(GUILD, { ...ids, supporter: FOUNDER }, []);
    expect(supporter.roles.supporter.problem).toBe("The Supporter and Founder roles must be two different roles.");
    expect(supporter.roles.founder.problem).toBe("The Founder and Supporter roles must be two different roles.");
    expect(supporter.roles.member.assignable).toBe(true);
  });
  it("asks for Manage Roles before anything else about an otherwise valid role", async () => {
    const { discord } = fixture({ manageRoles: false });
    const result = await discord.check(GUILD, ids, []);
    expect(result.manageRoles).toBe(false);
    expect(result.roles.member.problem).toBe("Give the bot's role the Manage Roles permission.");
  });
  it("lists roles named exactly UNC or Founder when an ID is missing or wrong", async () => {
    const { discord } = fixture({
      roles: [role(UNC, "UNC"), role("200000000000000003", "UNC Crew"), role(FOUNDER, "Founder")],
    });
    const result = await discord.check(
      GUILD,
      { member: undefined, founder: "299999999999999999", supporter: undefined },
      [],
    );
    expect(result.roles.member).toMatchObject({
      exists: false,
      assignable: false,
      problem: expect.stringContaining("DISCORD_MEMBER_ROLE_ID"),
      candidates: [{ id: UNC, name: "UNC" }],
    });
    expect(result.roles.founder).toMatchObject({
      exists: false,
      problem: expect.stringContaining("No role with ID 299999999999999999"),
      candidates: [{ id: FOUNDER, name: "Founder" }],
    });
  });
  it("lists roles named exactly Supporter while DISCORD_SUPPORTER_ROLE_ID is not set", async () => {
    const { discord } = fixture({
      roles: [
        role(UNC, "UNC"),
        role(FOUNDER, "Founder"),
        role(SUPPORTER, "Supporter"),
        role("200000000000000005", "Supporters"),
      ],
    });
    const result = await discord.check(GUILD, { ...ids, supporter: undefined }, []);
    expect(result.roles.supporter).toMatchObject({
      id: null,
      exists: false,
      assignable: false,
      problem: expect.stringContaining("Set DISCORD_SUPPORTER_ROLE_ID to the Supporter role ID"),
      candidates: [{ id: SUPPORTER, name: "Supporter" }],
    });
    expect(result.roles.member.assignable).toBe(true);
    expect(result.roles.founder.assignable).toBe(true);
  });
});

describe("Discord member reads and role writes", () => {
  it("reads a member fresh and writes roles with a private-data-free audit reason", async () => {
    const roles = { cache: new Map([[UNC, {}]]), add: jest.fn(), remove: jest.fn() };
    const joinedAt = new Date("2026-10-01T00:00:00Z");
    const { discord, fetchMember } = fixture({
      members: { "300000000000000001": { id: "300000000000000001", joinedAt, roles } },
    });
    const member = await discord.member(GUILD, "300000000000000001");
    expect(fetchMember).toHaveBeenCalledWith({ user: "300000000000000001", force: true });
    expect(member).toMatchObject({ id: "300000000000000001", joinedAt });
    expect(member!.has(UNC)).toBe(true);
    expect(member!.has(FOUNDER)).toBe(false);
    await member!.add(FOUNDER, "Gramps: founding supporter");
    await member!.remove(UNC, "Gramps: UNC application revoked");
    expect(roles.add).toHaveBeenCalledWith(FOUNDER, "Gramps: founding supporter");
    expect(roles.remove).toHaveBeenCalledWith(UNC, "Gramps: UNC application revoked");
  });
  it("returns no member for someone who is not in the server, and passes other errors on", async () => {
    const { discord, fetchMember } = fixture();
    await expect(discord.member(GUILD, "300000000000000002")).resolves.toBeNull();
    fetchMember.mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 503 }));
    await expect(discord.member(GUILD, "300000000000000002")).rejects.toThrow("Server error");
  });
});
