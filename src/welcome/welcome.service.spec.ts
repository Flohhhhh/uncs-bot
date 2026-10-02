import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { GuildMember } from "discord.js";
import { InteractionError } from "../common/errors/interaction-error";
import { config } from "../config";
import { DATABASE, type Database } from "../database/database.types";
import { DEFAULT_WELCOME_VERSIONS, MAX_WELCOME_DESCRIPTION_LENGTH } from "./welcome-template";
import { WelcomeModule } from "./welcome.module";
import { DEFAULT_WELCOME_MESSAGE, WelcomeService, type WelcomeSettings } from "./welcome.service";

const general = `<#${config.channels.general}>`;
const squadUp = `<#${config.channels.squadUp}>`;
const lobby = `<#${config.channels.lobby}>`;

function member(guildId = "guild-1", id = "111111111111111111") {
  return {
    id,
    guild: { id: guildId },
    toString: () => `<@${id}>`,
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
  } as unknown as GuildMember;
}

/** Replays the given values in order, like `Math.random`. */
function sequence(...values: number[]) {
  let index = 0;
  return jest.fn(() => values[index++ % values.length]);
}

/** Small deterministic PRNG (mulberry32) so the repeated-join checks are repeatable. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function fakeDb(rows: unknown[] = []) {
  const returning = jest.fn();
  const values = jest.fn((row: Record<string, unknown>) => {
    returning.mockResolvedValue([{ ...row, createdAt: new Date(), updatedAt: new Date() }]);
    return { onConflictDoUpdate: jest.fn(() => ({ returning })) };
  });
  const insert = jest.fn(() => ({ values }));
  const limit = jest.fn().mockResolvedValue(rows);
  const select = jest.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  return { db: { insert, select } as unknown as Database, insert, values };
}

const settings = (message: string): WelcomeSettings => ({ enabled: true, message });
const sentText = (service: WelcomeService, message: string, guild = member()) =>
  service.createEmbed(guild, settings(message)).toJSON().description;

describe("welcome embed versions", () => {
  it("sends a template without separators exactly as before", () => {
    const random = jest.fn(() => 0.5);
    const service = new WelcomeService(fakeDb().db, random);
    const template = "{user}, good to have you.\n\nSay hey in {general}, check {squad-up}, or jump into {lobby}.";
    const embed = service.createEmbed(member(), settings(template)).toJSON();

    expect(embed.title).toBe("Welcome to The UNCs");
    expect(embed.description).toBe(
      `<@111111111111111111>, good to have you.\n\nSay hey in ${general}, check ${squadUp}, or jump into ${lobby}.`,
    );
    expect(sentText(service, template)).toBe(embed.description);
    expect(random).not.toHaveBeenCalled();
  });

  it("renders the placeholders of whichever version is picked", () => {
    const template = [
      "A {user} {general}",
      "B {user.id} {squad-up} {channels-and-roles}",
      "C {user_id} {lobby} {general_id}",
    ].join("\n---\n");
    const service = new WelcomeService(fakeDb().db, sequence(0, 0.5, 0.99));

    expect(sentText(service, template)).toBe(`A <@111111111111111111> ${general}`);
    expect(sentText(service, template)).toBe(`C 111111111111111111 ${lobby} ${config.channels.general}`);
    expect(sentText(service, template)).toBe(`B 111111111111111111 ${squadUp} **Channels & Roles**`);
  });

  it("never sends a guild the same version twice in a row, while other guilds pick independently", () => {
    const template = "One {user} --- Two {user} --- Three {user}";
    // The random source always prefers the first candidate, so only the exclusion can move the choice.
    const service = new WelcomeService(fakeDb().db, () => 0);
    const first = member("guild-1");
    const second = member("guild-2");

    expect(sentText(service, template, first)).toMatch(/^One/);
    expect(sentText(service, template, second)).toMatch(/^One/);
    expect(sentText(service, template, first)).toMatch(/^Two/);
    expect(sentText(service, template, first)).toMatch(/^One/);
    expect(sentText(service, template, second)).toMatch(/^Two/);
  });

  it("avoids the previous text after the template is edited", () => {
    const service = new WelcomeService(fakeDb().db, () => 0);
    expect(sentText(service, "Hey {user} --- Yo {user}")).toMatch(/^Hey/);
    expect(sentText(service, "Hey {user} --- Sup {user}")).toMatch(/^Sup/);
  });

  it("uses the five default versions for a guild without a stored message", async () => {
    const service = new WelcomeService(fakeDb([]).db, seeded(5));
    const current = await service.getSettings("guild-1");
    expect(current).toEqual({ enabled: true, message: DEFAULT_WELCOME_MESSAGE });

    const sent = new Set<string | undefined>();
    let previous: string | undefined;
    for (let join = 0; join < 200; join++) {
      const description = service.createEmbed(member(), current).toJSON().description;
      expect(description).not.toBe(previous);
      sent.add(description);
      previous = description;
    }
    const rendered = DEFAULT_WELCOME_VERSIONS.map((version) =>
      version
        .replaceAll("{user}", "<@111111111111111111>")
        .replaceAll("{general}", general)
        .replaceAll("{squad-up}", squadUp),
    );
    expect([...sent].sort()).toEqual([...rendered].sort());
  });

  it("keeps each rendered version within the embed description limit", () => {
    // Fits the 4000-character option, but each channel mention expands to more than twice its placeholder.
    const long = "{general}".repeat(440);
    const template = `Short {user} --- ${long}`;
    expect(template.length).toBeLessThanOrEqual(4000);
    const service = new WelcomeService(fakeDb().db, () => 0);

    expect(sentText(service, template)).toBe("Short <@111111111111111111>");
    const expanded = sentText(service, template);
    expect(expanded).toHaveLength(MAX_WELCOME_DESCRIPTION_LENGTH);
    expect(expanded).toBe(general.repeat(440).slice(0, MAX_WELCOME_DESCRIPTION_LENGTH));
  });
});

describe("welcome message settings", () => {
  it("stores the trimmed template with its separators as typed", async () => {
    const { db, values } = fakeDb();
    const service = new WelcomeService(db);
    const saved = await service.setMessage("guild-1", "  Hi {user} --- Yo {user}  ");
    expect(values).toHaveBeenCalledWith({ guildId: "guild-1", enabled: true, message: "Hi {user} --- Yo {user}" });
    expect(saved.message).toBe("Hi {user} --- Yo {user}");
  });

  it.each(["   ", " --- ", "---\n---"])("refuses a template without any version text: %j", async (message) => {
    const { db, insert } = fakeDb();
    const service = new WelcomeService(db);
    await expect(service.setMessage("guild-1", message)).rejects.toBeInstanceOf(InteractionError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("stores the five-version default when enabling a guild for the first time", async () => {
    const { db, values } = fakeDb();
    await new WelcomeService(db).setEnabled("guild-1", true);
    expect(values).toHaveBeenCalledWith({ guildId: "guild-1", enabled: true, message: DEFAULT_WELCOME_MESSAGE });
  });

  it("resolves through Nest without a random source provider", async () => {
    @Global()
    @Module({ providers: [{ provide: DATABASE, useValue: fakeDb().db }], exports: [DATABASE] })
    class FakeDatabaseModule {}

    const moduleRef = await Test.createTestingModule({ imports: [FakeDatabaseModule, WelcomeModule] }).compile();
    const service = moduleRef.get(WelcomeService);
    const description = service.createEmbed(member(), settings("Hey {user} --- Yo {user}")).toJSON().description;
    expect(["Hey <@111111111111111111>", "Yo <@111111111111111111>"]).toContain(description);
    await moduleRef.close();
  });
});
