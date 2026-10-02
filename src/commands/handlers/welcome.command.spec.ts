import { MessageFlags } from "discord.js";
import type { SlashCommandContext } from "necord";
import { DEFAULT_WELCOME_MESSAGE, DEFAULT_WELCOME_VERSIONS } from "../../welcome/welcome-template";
import type { WelcomeService } from "../../welcome/welcome.service";
import { WelcomeCommandHandler } from "./welcome.command";

function fixture(stored = DEFAULT_WELCOME_MESSAGE) {
  const service = {
    getSettings: jest.fn().mockResolvedValue({ enabled: true, message: stored }),
    setMessage: jest.fn((_: string, message: string) => Promise.resolve({ enabled: true, message: message.trim() })),
  };
  const interaction = {
    guild: { id: "guild-1" },
    deferReply: jest.fn(),
    editReply: jest.fn(),
    reply: jest.fn(),
  };
  const handler = new WelcomeCommandHandler(service as unknown as WelcomeService);
  const context = [interaction] as unknown as SlashCommandContext;
  return { handler, service, interaction, context };
}

describe("/welcome message", () => {
  it("shows how many versions the current message has and each version, privately and without pings", async () => {
    const { handler, interaction, context } = fixture();
    await handler.handleMessage(context, {});

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const [{ content, allowedMentions }] = interaction.editReply.mock.calls[0];
    expect(allowedMentions).toEqual({ parse: [] });
    expect(content).toContain("**Current welcome message:** 5 versions.");
    DEFAULT_WELCOME_VERSIONS.forEach((version, index) =>
      expect(content).toContain(`**Version ${index + 1}**\n${version}`),
    );
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it("keeps a long single-version view within Discord's message limit", async () => {
    const { handler, interaction, context } = fixture("y".repeat(4000));
    await handler.handleMessage(context, {});
    const [{ content }] = interaction.editReply.mock.calls[0];
    expect(content).toContain("1 version.");
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it("confirms how many versions were saved without promising more than the in-memory rotation does", async () => {
    const { handler, service, interaction, context } = fixture();
    await handler.handleMessage(context, { message: "Hi {user} --- Yo {user} --- Sup {user}" });
    expect(service.setMessage).toHaveBeenCalledWith("guild-1", "Hi {user} --- Yo {user} --- Sup {user}");
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "✅ Welcome message updated and saved with 3 versions. Each new member gets one at random, skipping the one sent last unless the bot has restarted since.",
    });
  });

  it("counts versions with the same text once, so identical copies are not reported as variety", async () => {
    const { handler, interaction, context } = fixture();
    await handler.handleMessage(context, { message: "Hi {user} --- Hi {user}" });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "✅ Welcome message updated and saved." });
  });

  it("keeps the confirmation for a single-version message unchanged", async () => {
    const { handler, interaction, context } = fixture();
    await handler.handleMessage(context, { message: "Hi {user}" });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "✅ Welcome message updated and saved." });
  });
});

describe("/welcome help", () => {
  it("explains the version separator within Discord's message limit", async () => {
    const { handler, interaction, context } = fixture();
    await handler.handleHelp(context);
    const [{ content, flags, allowedMentions }] = interaction.reply.mock.calls[0];
    expect(flags).toBe(MessageFlags.Ephemeral);
    expect(allowedMentions).toEqual({ parse: [] });
    expect(content).toContain("` --- `");
    expect(content).toContain(
      "Each new member gets one at random, skipping the one sent last unless the bot has restarted since.",
    );
    expect(content).not.toContain("never the same");
    expect(content).toContain("`{squad-up}`");
    expect(content.length).toBeLessThanOrEqual(2000);
  });
});
